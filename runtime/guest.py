# Guest side of codemode for Python. CPython runs it inside bwrap: no
# network, no host files but /usr, the run folder and this file, and an empty
# environment. The protocol is the one of guest.mjs. Tool calls go out on the
# original stdout as marked JSON lines, and the mod answers each one with a
# file r<id>.json in the run folder. print() and other writes to stdout or
# stderr become console lines. A watchdog thread takes the replies and stops
# the run at the soft timeout, so a busy program cannot hold off either one.
# Prelude files from the host run first, in the program's module.
import ast
import asyncio
import io
import json
import math
import os
import re
import secrets
import sys
import threading
import time
import traceback
import types
from collections.abc import Mapping

MARK = '\x1ecm '
MAX_VALUE = 2_000_000
MAX_LOGS = 1_000_000
# read() paging. 48k tokens at about 3 chars per token, a safe guess for dense text.
READ_CAP = 144_000
PAGE_TOKENS = 20_000
PAGE_CHARS = 48_000
TOO_BIG = re.compile(r'exceeds maximum allowed (size|tokens)')
# sh() and ssh(). Bash answers a non-zero exit with isError and the text
# "Exit code N", then the output. Bash's own timeout or kill is not data.
EXIT = re.compile(r'Exit code (-?\d+)\n?')
BASH_KILLED = re.compile(r'Command timed out after |Command killed: ')
SSH_TIMEOUT_S = 90
MAX_BASH_MS = 600_000
DOC_LINE = re.compile(r'^#: (.*?)\r?$')
POLL_S = 0.005
LAST = '__codemode_last__'
FENCE = re.compile(r'\A\s*```[^\n]*\n(.*?)\n?[ \t]*```\s*\Z', re.S)


class State:
    def __init__(self):
        # lock guards pending, used and idle_since. Program time runs only
        # while no tool call waits for its reply.
        self.lock = threading.Lock()
        self.pending = {}
        self.seq = 0
        self.used = 0.0
        self.idle_since = time.monotonic()
        self.log_lock = threading.Lock()
        self.logs = []
        self.log_chars = 0
        self.dropped = 0
        self.send_lock = threading.Lock()
        self.proto = None
        self.finish_lock = threading.Lock()
        self.finished = False
        # Note lines for the result, one per skipped prelude.
        self.notes = []
        self.docs = []
        self.prelude_files = set()
        self.is_last_hit = False


st = State()


class Obj(dict):
    """A JSON object. Its keys also read as attributes: r.out is r["out"]."""

    __slots__ = ()

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            keys = ', '.join(str(k) for k in list(self)[:20]) or 'none'
            raise AttributeError(f'no key {name!r} here. Keys: {keys}') from None

    def __setattr__(self, name, value):
        self[name] = value

    def __delattr__(self, name):
        try:
            del self[name]
        except KeyError:
            raise AttributeError(name) from None


class ToolError(Exception):
    def __init__(self, message, tool=None, text=None, deny=None, result=None):
        message = str(message)
        super().__init__(message[:4000] + '...' if len(message) > 4000 else message)
        self.tool = tool
        self.text = text
        self.deny = deny
        self.result = result


def add_log(line):
    # The caller holds st.log_lock.
    if st.log_chars + len(line) > MAX_LOGS:
        st.dropped += 1
    else:
        st.logs.append(line)
        st.log_chars += len(line) + 1


class LogWriter(io.TextIOBase):
    """sys.stdout and sys.stderr: each line becomes a console line."""

    def __init__(self):
        super().__init__()
        self._part = ''

    @property
    def encoding(self):
        return 'utf-8'

    def writable(self):
        return True

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError(f'write() argument must be str, not {type(s).__name__}')
        with st.log_lock:
            lines = (self._part + s).split('\n')
            self._part = lines.pop()
            for line in lines:
                add_log(line)
            if len(self._part) > MAX_LOGS:
                add_log(self._part)
                self._part = ''
        return len(s)

    def drain(self):
        with st.log_lock:
            if self._part:
                add_log(self._part)
                self._part = ''


def program_time():
    with st.lock:
        return st.used + (0.0 if st.pending else time.monotonic() - st.idle_since)


def send(msg):
    line = MARK + json.dumps(msg, ensure_ascii=False, allow_nan=False) + '\n'
    with st.send_lock:
        st.proto.write(line)
        st.proto.flush()


def finish(msg):
    with st.finish_lock:
        if st.finished:
            return
        st.finished = True
    try:
        for writer in (sys.stdout, sys.stderr):
            if isinstance(writer, LogWriter):
                writer.drain()
        with st.log_lock:
            logs = list(st.logs)
            if st.dropped:
                logs.append(f'[{st.dropped} more log lines dropped]')
        send({'type': 'done', **msg, 'logs': logs, 'programSeconds': round(program_time(), 1)})
    finally:
        os._exit(0)


def end(msg):
    note = '\n'.join(n for n in [msg.get('note'), *st.notes] if n) or None
    finish({**msg, 'note': note})


def settle(future, value):
    if not future.done():
        future.set_result(value)


# The watchdog thread. It takes each reply file once it parses whole, since a
# parse failure can be a partial write. It also ends the run at the soft
# timeout.
def watch(loop, run_dir, soft_s):
    while True:
        time.sleep(POLL_S)
        with st.lock:
            ids = list(st.pending)
        for id in ids:
            try:
                with open(f'{run_dir}/r{id}.json', encoding='utf-8') as fh:
                    value = json.loads(fh.read(), object_hook=Obj)
            except (OSError, ValueError):
                continue
            with st.lock:
                future = st.pending.pop(id, None)
                if future is not None and not st.pending:
                    st.idle_since = time.monotonic()
            if future is not None:
                try:
                    loop.call_soon_threadsafe(settle, future, value)
                except RuntimeError:
                    return
        if program_time() >= soft_s:
            finish({'ok': False, 'kind': 'timeout'})


# The API.

def num(value):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return 0.0
    return f if math.isfinite(f) else 0.0


def one_line(text, limit):
    line = ' '.join(text.split())
    return line[:max(0, limit - 3)] + '...' if len(line) > limit else line


# extra: quiet (a read() page), soft (sh and ssh) and label (the ledger
# argument in place of the command head).
async def request(tool, input=None, quiet=False, soft=False, label=None):
    if not isinstance(tool, str):
        return Obj(isError=True, text='call(name, input) takes a tool name first.')
    try:
        clean = json.loads(json.dumps({} if input is None else input, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError) as err:
        return Obj(isError=True, text=f'The input of {tool} is not JSON: {err}')
    if not isinstance(clean, (dict, str)):
        return Obj(isError=True, text=f'The input of {tool} must be a dict of its parameters.')
    future = asyncio.get_running_loop().create_future()
    with st.lock:
        st.seq += 1
        id = st.seq
        if not st.pending:
            st.used += time.monotonic() - st.idle_since
        st.pending[id] = future
    msg = {'type': 'call', 'id': id, 'tool': tool, 'input': clean}
    if quiet:
        msg['quiet'] = True
    if soft:
        msg['soft'] = True
    if label is not None:
        msg['label'] = label
    send(msg)
    return await future


def raise_for(tool, r):
    own = tool.startswith('$')
    if r.get('deny') is not None:
        raise ToolError(f'{tool} denied: {r["deny"]}', tool=tool, deny=r['deny'])
    if r.get('isError'):
        text = r.get('text')
        raise ToolError(text if own else f'{tool} failed: {text}', tool=tool, text=text, result=r.get('result'))


async def ok(tool, input=None):
    r = await request(tool, input)
    raise_for(tool, r)
    return r


# The input of a tool call: a dict, keyword arguments, or both.
def merge(input, kwargs, name):
    if not kwargs:
        return {} if input is None else input
    if input is None:
        return dict(kwargs)
    if isinstance(input, dict):
        return {**input, **kwargs}
    raise TypeError(f'{name} takes a dict of parameters or keyword arguments, not a {type(input).__name__} with keywords.')


async def call(name, input=None, **kwargs):
    try:
        merged = merge(input, kwargs, 'call')
    except TypeError as err:
        return Obj(text=str(err), result=None, isError=True, deny=None)
    r = await request(name, merged)
    return Obj(text=r.get('text'), result=r.get('result'), isError=r.get('isError') is True, deny=r.get('deny'))


class Tools:
    def __getattr__(self, name):
        if name.startswith('__') and name.endswith('__'):
            raise AttributeError(name)

        async def run(input=None, **kwargs):
            return (await ok(name, merge(input, kwargs, f'tools.{name}'))).get('text')

        run.__name__ = run.__qualname__ = name
        return run

    def __getitem__(self, name):
        return self.__getattr__(name)


tools = Tools()


# A subagent's final answer. The host spawns it and waits for its last turn.
# The wait counts as a tool wait, so it uses no program time.
async def agent(prompt, type='general-purpose', model=None, description=None, name=None, cwd=None):
    if not isinstance(prompt, str) or not prompt.strip():
        raise TypeError('agent(prompt, type=..., model=...) takes a prompt string first.')
    args = {'prompt': prompt, 'subagent_type': type, 'model': model, 'description': description, 'name': name, 'cwd': cwd}
    return (await ok('Agent', {k: v for k, v in args.items() if v is not None})).get('text')


def file_of(r):
    result = r.get('result')
    f = result.get('file') if isinstance(result, dict) else None
    return f if isinstance(f, dict) else None


# A file too big for one Read is read in pages. Each page asks for about
# PAGE_CHARS, and a page over Read's token cap is retried smaller, quietly.
# The whole read stops near READ_CAP chars with a note line.
async def read(path, offset=None, limit=None, **opts):
    if offset is not None:
        opts['offset'] = offset
    if limit is not None:
        opts['limit'] = limit
    first = await request('Read', {'file_path': path, **opts}, quiet=True)
    if first.get('isError') and TOO_BIG.search(first.get('text') or ''):
        return await read_pages(path, opts)
    raise_for('Read', first)
    f = file_of(first)
    if f is None or not isinstance(f.get('content'), str):
        return first.get('text')
    if limit is not None or f['startLine'] + f['numLines'] > f['totalLines']:
        return f['content']
    return await read_pages(path, opts, f)


async def read_pages(path, opts, head=None):
    start = max(1, int(num(opts.get('offset'))) or 1)
    end = math.inf if opts.get('limit') is None else start + max(1, int(num(opts['limit']))) - 1
    parts = []
    chars = 0
    line = start
    size = 2000
    total = None
    note = None

    def take(f):
        nonlocal chars, line, size, total, note
        total = f['totalLines']
        lines = f['content'].split('\n')[:f['numLines']]
        kept = 0
        while kept < len(lines) and chars + len(lines[kept]) + 1 <= READ_CAP:
            chars += len(lines[kept]) + 1
            kept += 1
        parts.extend(lines[:kept])
        line += kept
        if kept < len(lines):
            note = 'the 48k-token cap of read()'
        elif kept:
            per_line = len(f['content']) / kept
            size = 2000 if per_line == 0 else min(2000, max(1, math.floor(PAGE_CHARS / per_line)))

    if head is not None:
        take(head)
    while note is None and line <= end and (total is None or line <= total):
        want = int(min(size, end - line + 1, math.inf if total is None else total - line + 1))
        r = await request('Read', {**opts, 'file_path': path, 'offset': line, 'limit': want}, quiet=True)
        if r.get('isError') and TOO_BIG.search(r.get('text') or ''):
            if want == 1:
                note = f'line {line} alone is over the token cap of one Read'
                break
            m = re.search(r'\((\d+) tokens\)', r.get('text') or '')
            tokens = int(m.group(1)) if m else 0
            size = max(1, (want * PAGE_TOKENS) // tokens) if tokens > 0 else max(1, want >> 1)
            continue
        raise_for('Read', r)
        f = file_of(r)
        if f is None or not f.get('numLines') or not isinstance(f.get('content'), str):
            break
        take(f)
    text = '\n'.join(parts)
    if note is None:
        return text
    of = '' if total is None else f' of {total}'
    return f'{text}\n[codemode: read stopped at line {line}{of}: {note}. Pass offset={line} to read on.]'


async def bash(command, opts=None, **kwargs):
    r = await ok('Bash', {'command': command, **(opts or {}), **kwargs})
    result = r.get('result') if isinstance(r.get('result'), dict) else {}
    if result.get('backgroundTaskId'):
        return r.get('text')
    return result['stdout'] if result.get('stdout') is not None else r.get('text')


# POSIX single quotes. A list or tuple gives one word per item.
def q(*words):
    out = []

    def add(v):
        if isinstance(v, (list, tuple)):
            for item in v:
                add(item)
            return
        if isinstance(v, bool):
            word = 'true' if v else 'false'
        elif isinstance(v, (str, int, float)):
            word = str(v)
        else:
            kind = 'None' if v is None else type(v).__name__
            raise TypeError(f'q: {kind} is not a shell word. Pass strings, numbers or lists of them.')
        out.append("'" + word.replace("'", "'\\''") + "'")

    for w in words:
        add(w)
    return ' '.join(out)


# A Bash call where a plain non-zero exit is data. Bash cuts stdout at
# 30000 chars and saves the full text to a file, given as saved.
async def shell(command, opts, label=None):
    r = await request('Bash', {'command': command, **opts}, soft=True, label=label)
    text = r.get('text') or ''
    exit = EXIT.match(text) if r.get('isError') and r.get('deny') is None else None
    if exit:
        code = int(exit.group(1))
        if not (code in (143, 137) and BASH_KILLED.search(text)):
            return Obj(ok=False, code=code, out=text[exit.end():])
    raise_for('Bash', r)
    result = r.get('result') if isinstance(r.get('result'), dict) else {}
    if result.get('timedOutAfterMs') is not None:
        raise ToolError(
            f'Bash timed out after {result["timedOutAfterMs"] / 1000:g} s and moved the command to the background: {text}',
            tool='Bash', text=r.get('text'), result=r.get('result'),
        )
    if result.get('backgroundTaskId'):
        return Obj(ok=True, code=0, out=text)
    out = result['stdout'] if result.get('stdout') is not None else r.get('text')
    # Bash reports exit 1 of grep, rg, diff, test and find as a success with
    # a meaning ("No matches found"). Give the real exit back.
    meaning = result.get('returnCodeInterpretation')
    value = Obj(ok=False, code=1, out=out, meaning=meaning) if meaning else Obj(ok=True, code=0, out=out)
    if result.get('persistedOutputPath'):
        value['saved'] = result['persistedOutputPath']
    return value


async def sh(command, opts=None, **kwargs):
    if not isinstance(command, str):
        raise TypeError('sh(command, **opts) takes a command string.')
    return await shell(command, {**(opts or {}), **kwargs})


# One local Bash call. The script goes to the remote bash on stdin from a
# quoted heredoc, so it needs no remote quoting.
async def ssh(host, script, timeout=SSH_TIMEOUT_S, **opts):
    if not isinstance(host, str) or not host:
        raise TypeError('ssh(host, script, timeout=90) takes a host name first.')
    if not isinstance(script, str):
        raise TypeError('ssh(host, script, timeout=90) takes the script as a string.')
    seconds = num(timeout) if num(timeout) > 0 else SSH_TIMEOUT_S
    if seconds == int(seconds):
        seconds = int(seconds)
    tag = f'CM_{secrets.token_hex(6)}'
    while tag in script:
        tag = f'CM_{secrets.token_hex(6)}'
    first = next((l.strip() for l in script.split('\n') if l.strip()), '')
    label = f'ssh {host}: {first}'
    command = (
        f"timeout -k 5 {seconds} ssh -o BatchMode=yes -o ConnectTimeout=10 {q(host)} bash -s <<'{tag}'\n"
        f'{script}\n{tag}'
    )
    bash_opts = {'description': one_line(label, 80), **opts, 'timeout': min(MAX_BASH_MS, int((seconds + 15) * 1000))}
    r = await shell(command, bash_opts, label)
    return Obj({**r, 'host': host, 'timedOut': r['code'] in (124, 137)})


async def list_tools(filter=None):
    found = (await ok('$list', {}))['result']
    if filter is None:
        return found
    if isinstance(filter, re.Pattern):
        return [t for t in found if filter.search(t['name']) or filter.search(t.get('summary') or '')]
    needle = str(filter).lower()
    return [t for t in found if needle in f"{t['name']} {t.get('summary') or ''}".lower()]


async def describe(name):
    return (await ok('$describe', {'name': name})).get('text')


class Store:
    async def get(self, key):
        r = (await ok('$store', {'op': 'get', 'key': key}))['result']
        return r.get('value') if r.get('found') else None

    async def set(self, key, value):
        try:
            text = json.dumps(value, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as err:
            raise ToolError(f'store.set needs a JSON value: {err}', tool='$store') from None
        if len(text) > 1_000_000:
            raise ToolError(f'store.set: the value is {len(text)} chars of JSON; the cap is 1,000,000.', tool='$store')
        await ok('$store', {'op': 'set', 'key': key, 'value': value})

    async def delete(self, key):
        return (await ok('$store', {'op': 'delete', 'key': key}))['result']

    async def keys(self):
        return (await ok('$store', {'op': 'keys'}))['result']


store = Store()


def helpers():
    return list(st.docs)


def last(value):
    st.is_last_hit = True
    return value


# Source normalization and compile.

class ParseFailure(Exception):
    pass


# The program becomes the body of async def __codemode__(). The wrap works on
# the syntax tree, so line numbers and string contents stay as written. A last
# bare expression becomes the return value.
def prepare(source):
    text = source
    fence_lines = 0
    fence = FENCE.match(source)
    if fence:
        text = fence.group(1)
        fence_lines = source[:fence.start(1)].count('\n')
    last_line = fence_lines + text.count('\n') + 1
    try:
        tree = ast.parse('\n' * fence_lines + text, filename='program')
        body = tree.body
        if body and isinstance(body[-1], ast.Expr):
            expr = body[-1]
            wrapped = ast.Call(func=ast.Name(id=LAST, ctx=ast.Load()), args=[expr.value], keywords=[])
            ast.copy_location(wrapped.func, expr.value)
            ast.copy_location(wrapped, expr.value)
            body[-1] = ast.copy_location(ast.Return(value=wrapped), expr)
        fn = ast.parse('async def __codemode__():\n    pass').body[0]
        fn.body = body or [ast.Pass()]
        tree.body = [fn]
        ast.fix_missing_locations(tree)
        return compile(tree, 'program', 'exec')
    except (SyntaxError, ValueError) as err:
        raise ParseFailure(parse_error(err, source, last_line)) from None


# Errors.

GLOBALS = (
    'In scope: tools, call, agent, read, bash, sh, ssh, q, list_tools, describe, store, helpers, project_dir, '
    'print, ToolError, asyncio, json, re, the prelude helpers, and the Python built-ins.'
)
JS_SYNTAX = re.compile(r'\b(?:const|let|var)\s+[A-Za-z_$]|=>|===|!==|\bPromise\.|\bJSON\.|\bconsole\.log\b')
JS_HINT = (
    'This session runs Python. Write Python syntax: plain assignments, def or lambda, True, False and None, '
    'and await asyncio.gather(...) in place of Promise.all.'
)
# JavaScript names a program may use by habit, and what Python has instead.
JS_NAMES = {
    'true': 'Use True.',
    'false': 'Use False.',
    'null': 'Use None.',
    'undefined': 'Use None.',
    'Promise': 'Use await asyncio.gather(...) in place of Promise.all.',
    'JSON': 'Use json.dumps(...) and json.loads(...).',
    'console': 'Use print(...).',
    'require': 'Use import.',
    'process': 'The sandbox has no process access. Run commands with sh() or bash().',
    'fetch': 'Use tools.WebFetch(url=..., prompt=...).',
    'listTools': 'Use list_tools(...).',
    'projectDir': 'Use project_dir.',
}
NOT_JSON = re.compile(r'not JSON serializable|not JSON compliant|keys must be str')
JSON_HINT = 'Convert values to JSON types before you pass or store them: list(s) for a set, str(x) for other objects.'


def code_frame(source, line, column):
    lines = source.split('\n')
    width = len(str(line))
    shown = []
    for n in range(max(1, line - 1), min(len(lines), line) + 1):
        shown.append(f"{'>' if n == line else ' '} {str(n).rjust(width)} | {lines[n - 1]}")
    if column:
        shown.append(f"  {' ' * width} | {' ' * (column - 1)}^")
    return '\n'.join(shown)


def parse_error(err, source, last_line):
    message = err.msg if isinstance(err, SyntaxError) else str(err)
    line = getattr(err, 'lineno', None)
    column = getattr(err, 'offset', None)
    where = ''
    if line is not None:
        if line > last_line:
            line = last_line
            column = None
            where = ' (at the end of the program)'
        line = max(line, 1)
    if line is None:
        out = [f'Program did not parse: {message}']
    else:
        out = [f'Program did not parse. Line {line}{f":{column}" if column else ""}: {message}{where}']
        out.append(code_frame(source, line, column))
    if JS_SYNTAX.search(source[:16000]):
        out.append(JS_HINT)
    return '\n'.join(out)


# A frame in the program or in a prelude file. Other frames are codemode's
# own and stay hidden.
def describe_error(err):
    name = type(err).__name__
    message = str(err)
    out = [f'{name}: {message}' if message else name]
    for f in reversed(traceback.extract_tb(err.__traceback__)):
        if f.filename != 'program' and f.filename not in st.prelude_files:
            continue
        column = f':{f.colno + 1}' if f.colno is not None else ''
        fn = '' if f.name in ('__codemode__', '<module>') else f'{f.name} '
        where = f'line {f.lineno}{column}' if f.filename == 'program' else f'{f.filename}:{f.lineno}{column}'
        out.append(f'  at {fn}{where}')
        if len(out) > 6:
            break
    if type(err) is NameError:
        missing = getattr(err, 'name', None)
        if missing in JS_NAMES:
            out.append(f'This session runs Python. {JS_NAMES[missing]}')
        out.append(GLOBALS)
    if NOT_JSON.search(message):
        out.append(JSON_HINT)
    return '\n'.join(out)


# One line for a prelude that did not run: the error and where it is.
def prelude_error(err, path):
    name = type(err).__name__
    message = (err.msg if isinstance(err, SyntaxError) else str(err)).split('\n')[0]
    where = None
    if isinstance(err, SyntaxError) and err.lineno:
        where = f'{err.lineno}:{err.offset}' if err.offset else str(err.lineno)
    else:
        for f in reversed(traceback.extract_tb(err.__traceback__)):
            if f.filename == path:
                where = f'{f.lineno}:{f.colno + 1}' if f.colno is not None else str(f.lineno)
                break
    return f'{name}: {message}' + (f' (line {where})' if where else '')


# Result formatting. Multi-line strings longer than 80 chars leave the
# skeleton and follow it as raw sections, so the model can copy exact text.

KEY = re.compile(r'[A-Za-z_$][A-Za-z0-9_$]*\Z')


def plain(value, path, sections, seen):
    if isinstance(value, (bytes, bytearray, memoryview)):
        value = bytes(value).decode('utf-8', 'replace')
    if isinstance(value, str):
        if path and len(value) > 80 and '\n' in value:
            sections.append((path, value))
            return f'<see section {path}>'
        return value
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if id(value) in seen:
        return '[circular]'
    if isinstance(value, BaseException):
        return {'name': type(value).__name__, 'message': str(value)}
    if isinstance(value, Mapping):
        seen.add(id(value))
        out = {}
        for k, item in value.items():
            key = str(k)
            sub = (f'{path}.{key}' if path else key) if KEY.match(key) else f'{path}[{json.dumps(key, ensure_ascii=False)}]'
            out[key] = plain(item, sub, sections, seen)
        seen.discard(id(value))
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        items = list(value)
        if isinstance(value, (set, frozenset)):
            try:
                items.sort()
            except TypeError:
                pass
        seen.add(id(value))
        out = [plain(item, f'{path}[{i}]', sections, seen) for i, item in enumerate(items)]
        seen.discard(id(value))
        return out
    return str(value)


def format_value(value):
    if value is None:
        return '(no return value; add return)'
    if isinstance(value, (bytes, bytearray, memoryview)):
        value = bytes(value).decode('utf-8', 'replace')
    if isinstance(value, str):
        text = value
    else:
        sections = []
        skeleton = plain(value, '', sections, set())
        pretty = json.dumps(skeleton, indent=2, ensure_ascii=False)
        text = pretty if len(pretty) <= 2048 else json.dumps(skeleton, ensure_ascii=False, separators=(',', ':'))
        for path, section in sections:
            text += f'\n\n--- {path} ({len(section)} chars) ---\n{section}'
    if len(text) > MAX_VALUE:
        text = f'{text[:MAX_VALUE]}\n[codemode: the value was cut at {MAX_VALUE} of {len(text)} chars]'
    return text


# The run.

# The host sends { program, preludes, projectDir } as JSON. A bare program
# is the older form.
def envelope(text):
    try:
        v = json.loads(text)
        if isinstance(v, dict) and isinstance(v.get('program'), str):
            return {
                'source': v['program'],
                'preludes': v['preludes'] if isinstance(v.get('preludes'), list) else [],
                'projectDir': v['projectDir'] if isinstance(v.get('projectDir'), str) else None,
            }
    except ValueError:
        pass
    return {'source': text, 'preludes': [], 'projectDir': None}


def on_loop_error(loop, context):
    err = context.get('exception')
    if err is None:
        with st.log_lock:
            add_log(f"asyncio: {context.get('message')}")
        return
    end({'ok': False, 'kind': 'error', 'error': 'Unhandled exception in a task: ' + describe_error(err)})


async def run(env, run_dir, soft_s):
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(on_loop_error)
    threading.Thread(target=watch, args=(loop, run_dir, soft_s), daemon=True).start()
    try:
        code = prepare(env['source'])
    except ParseFailure as err:
        end({'ok': False, 'kind': 'parse', 'error': str(err)})
        return
    module = types.ModuleType('__codemode__')
    sys.modules['__codemode__'] = module
    scope = module.__dict__
    scope.update({
        'tools': tools, 'call': call, 'agent': agent, 'read': read, 'bash': bash, 'sh': sh, 'ssh': ssh, 'q': q,
        'list_tools': list_tools, 'describe': describe, 'store': store, 'helpers': helpers,
        'project_dir': env['projectDir'], 'ToolError': ToolError,
        'asyncio': asyncio, 'json': json, 're': re, LAST: last,
    })

    # Each prelude runs at module level in the program's module, so its
    # top-level names are globals for the program. A prelude that raises is
    # skipped.
    for p in env['preludes']:
        if not isinstance(p, dict) or not isinstance(p.get('path'), str):
            continue
        path = p['path']
        if not isinstance(p.get('source'), str):
            st.notes.append(f"prelude {path} skipped: {p.get('error') or 'no source'}")
            continue
        st.prelude_files.add(path)
        try:
            exec(compile(p['source'], path, 'exec'), scope)
            for line in p['source'].split('\n'):
                doc = DOC_LINE.match(line)
                if doc:
                    st.docs.append(doc.group(1))
        except BaseException as err:
            st.notes.append(f'prelude {path} skipped: {prelude_error(err, path)}')

    try:
        exec(code, scope)
        value = await scope['__codemode__']()
        note = '(returned last expression)' if st.is_last_hit and value is not None else None
        end({'ok': True, 'value': format_value(value), 'note': note})
    except BaseException as err:
        end({'ok': False, 'kind': 'error', 'error': describe_error(err)})


def main():
    run_dir = sys.argv[1]
    soft_s = float(sys.argv[2])
    # Protocol lines go to a copy of the original stdout. fd 1 itself points
    # at /dev/null, so a stray write cannot break a protocol line.
    st.proto = os.fdopen(os.dup(1), 'w', encoding='utf-8', errors='replace', newline='\n')
    null = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null, 1)
    os.close(null)
    sys.stdout = LogWriter()
    sys.stderr = LogWriter()
    try:
        env = envelope(sys.stdin.buffer.read().decode('utf-8', 'replace'))
        asyncio.run(run(env, run_dir, soft_s))
        finish({'ok': False, 'kind': 'crash', 'error': 'The program ended without a result.'})
    except BaseException as err:
        finish({'ok': False, 'kind': 'crash', 'error': f'{type(err).__name__}: {err}'})


if __name__ == '__main__':
    main()
