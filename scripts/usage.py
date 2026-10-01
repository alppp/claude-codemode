#!/usr/bin/env python3
"""How often sessions probe with plain tools in place of codemode exec.

Reads the Claude Code transcripts in ~/.claude/projects/*/*.jsonl (and the
subagent transcripts with --agents). A round is one assistant message with
tool calls. Rounds are of three kinds:
  exec   the round calls mcp__codemode__exec
  probe  every call in the round is a direct read-only probe
  other  anything else (writes, edits, agents, background jobs)
A serial run is 2 or more probe rounds in a row with no user prompt between.
Each probe round after the first in a run is a wasted round trip: one exec
could have held it. The key number is wasted / (exec + probe rounds).

Usage: usage.py [--days 14] [--project SUBSTR] [--sessions 15] [--agents] [--examples 3]
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

EXEC = 'mcp__codemode__exec'
READ_TOOLS = {'Read', 'Grep', 'Glob', 'LS'}
# The first word of a Bash command that only reads.
READ_HEADS = {
    'rg', 'grep', 'ug', 'sed', 'awk', 'cat', 'head', 'tail', 'less', 'ls', 'fd', 'find', 'plocate', 'locate',
    'wc', 'jq', 'stat', 'file', 'du', 'df', 'md5sum', 'sha256sum', 'diff', 'cmp', 'tree', 'which', 'type',
    'ssh', 'curl', 'unzip', 'zipinfo', 'javap', 'nbtdump', 'docker', 'journalctl', 'systemctl', 'ps', 'pgrep',
    'date', 'echo', 'printf', 'test', 'env', 'readlink', 'realpath', 'basename', 'dirname', 'sort', 'uniq',
}
READ_GIT = {'log', 'show', 'status', 'diff', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch', 'remote'}
# A shell write anywhere in the command makes it a write.
WRITES = re.compile(r'(^|[^>&0-9])>(?!&|/dev/null)|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\bmkdir\b|\bchmod\b|\bgit\s+(commit|push|add|checkout|reset|stash|pull)')
LEAD = re.compile(r'^\s*(?:cd\s+\S+\s*(?:&&|;)\s*|[A-Z_][A-Z0-9_]*=\S*\s+|timeout\s+(?:-\S+\s+\S+\s+)?\S+\s+|sudo\s+(?:-A\s+)?)*')


def is_probe(name, inp):
    if name in READ_TOOLS:
        return True
    if name != 'Bash' or inp.get('run_in_background'):
        return False
    cmd = inp.get('command', '')
    if WRITES.search(cmd):
        return False
    words = LEAD.sub('', cmd).split()
    if not words:
        return False
    head = os.path.basename(words[0])
    if head == 'git':
        return len(words) > 1 and words[1] in READ_GIT
    if head in ('node', 'python3', 'python'):
        # Known read-only helper scripts only.
        return bool(re.search(r'-c\s', cmd))
    return head in READ_HEADS


def is_prompt(d):
    if d.get('type') != 'user' or d.get('isMeta'):
        return False
    c = d.get('message', {}).get('content')
    if isinstance(c, str):
        return not c.startswith('<')
    return isinstance(c, list) and not any(b.get('type') == 'tool_result' for b in c)


def session_stats(path, examples):
    rounds = []  # (kind, first probe command) in order; None marks a prompt
    by_msg = {}
    for line in open(path, errors='replace'):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if is_prompt(d):
            rounds.append(None)
            continue
        if d.get('type') != 'assistant':
            continue
        msg = d.get('message', {})
        calls = [b for b in msg.get('content', []) if b.get('type') == 'tool_use']
        if not calls:
            continue
        mid = msg.get('id') or d.get('requestId') or d.get('uuid')
        if mid not in by_msg:
            by_msg[mid] = {'calls': [], 'ts': d.get('timestamp')}
            rounds.append(by_msg[mid])
        by_msg[mid]['calls'] += calls
    s = {'exec': 0, 'probe': 0, 'other': 0, 'wasted': 0, 'runs': 0, 'ts': None, 'examples': []}
    run = []

    def close():
        if len(run) >= 2:
            s['runs'] += 1
            s['wasted'] += len(run) - 1
            if len(s['examples']) < examples:
                s['examples'].append(run[:4])
        run.clear()

    for r in rounds:
        if r is None:
            close()
            continue
        s['ts'] = s['ts'] or r['ts']
        names = [c['name'] for c in r['calls']]
        if EXEC in names:
            kind = 'exec'
        elif all(is_probe(c['name'], c.get('input', {})) for c in r['calls']):
            kind = 'probe'
        else:
            kind = 'other'
        s[kind] += 1
        if kind == 'probe':
            c = r['calls'][0]
            run.append(c['input'].get('command') or c['input'].get('file_path') or c['name'])
        else:
            close()
    close()
    return s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--days', type=int, default=14)
    ap.add_argument('--project', default='')
    ap.add_argument('--sessions', type=int, default=15, help='recent sessions to list')
    ap.add_argument('--agents', action='store_true', help='include subagent transcripts')
    ap.add_argument('--examples', type=int, default=0, help='serial runs to show per listed session')
    a = ap.parse_args()

    root = os.path.expanduser('~/.claude/projects')
    files = glob.glob(f'{root}/*/*.jsonl')
    if a.agents:
        files += glob.glob(f'{root}/*/*/subagents/*.jsonl')
    since = datetime.now(timezone.utc) - timedelta(days=a.days)
    rows = []
    for f in files:
        if a.project and a.project not in f:
            continue
        if datetime.fromtimestamp(os.path.getmtime(f), timezone.utc) < since:
            continue
        s = session_stats(f, a.examples)
        if not s['ts'] or s['exec'] + s['probe'] == 0:
            continue
        project = f.split('/projects/')[1].split('/')[0].replace('-home-user-', '').replace('GitHub-', '')
        rows.append((s['ts'], project, os.path.basename(f)[:8], s))
    rows.sort(key=lambda r: r[0])
    if not rows:
        sys.exit('No sessions with probes in that window.')

    def share(s):
        base = s['exec'] + s['probe']
        return f"{100 * s['wasted'] / base:4.0f}%" if base else '   -'

    print(f'Per day (last {a.days} days). wasted = probe rounds that one exec could have held.')
    print(f"{'day':10}  {'sess':>4}  {'exec':>5}  {'probe':>5}  {'runs':>4}  {'wasted':>6}  {'share':>5}")
    days = defaultdict(lambda: defaultdict(int))
    for ts, _, _, s in rows:
        d = days[ts[:10]]
        d['sess'] += 1
        for k in ('exec', 'probe', 'runs', 'wasted'):
            d[k] += s[k]
    for day in sorted(days):
        d = days[day]
        print(f"{day:10}  {d['sess']:4}  {d['exec']:5}  {d['probe']:5}  {d['runs']:4}  {d['wasted']:6}  {share(d):>5}")

    print(f'\nLast {a.sessions} sessions:')
    print(f"{'start (UTC)':16}  {'session':8}  {'exec':>4}  {'probe':>5}  {'wasted':>6}  {'share':>5}  project")
    for ts, project, sid, s in rows[-a.sessions:]:
        print(f"{ts[:16].replace('T', ' '):16}  {sid:8}  {s['exec']:4}  {s['probe']:5}  {s['wasted']:6}  {share(s):>5}  {project}")
        for ex in s['examples']:
            print('    run: ' + ' | '.join(re.sub(r'\s+', ' ', str(c))[:70] for c in ex))


if __name__ == '__main__':
    main()
