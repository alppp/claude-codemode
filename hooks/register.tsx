import { update } from 'claude-code'
import type { AgentSpawnArgs, AgentSpawnResult, EngineInterface, Register, TurnCompleteInput } from 'claude-code'

import type { CodemodeJson, CodemodeRun } from '../types'

const TOOL = 'mcp__codemode__exec'
const MARK = '\u001ecm '
const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
const CEILING_S = 3600
const MAX_PARALLEL = 8
const MAX_CALLS = 300
const MAX_OUTPUT = 40_000
const MAX_FAILED_OUTPUT = 20_000
const MAX_LOGS = 8_000
const MAX_LINE = 16_000_000
const MAX_STDERR = 4096
const STORE_KEYS = 256
const STORE_VALUE = 1_000_000
const GUEST_PATH = 'PATH=/usr/local/bin:/usr/bin:/bin'
// A soft call (sh, ssh) that ends in "Exit code N" is data. Bash's own
// timeout or kill still fails.
const EXIT = /^Exit code (-?\d+)/
const BASH_KILLED = /Command timed out after |Command killed: /
// The prelude files and their doc lines, per language.
const PRELUDE = {
  js: { file: /^(?!.*\.d\.ts$).+\.(js|ts)$/, doc: /^\/\/: (.*?)\r?$/ },
  py: { file: /^.+\.py$/, doc: /^#: (.*?)\r?$/ },
} as const
type Lang = keyof typeof PRELUDE
// CODEMODE_LANG=python (or py) selects the Python runtime for the session.
const langOf = (value: string | undefined): Lang => (/^(python|py)$/i.test(value?.trim() ?? '') ? 'py' : 'js')
// The Python sandbox binds these root links of the host, or the dirs themselves.
const ROOT_LINKS = ['/bin', '/sbin', '/lib', '/lib64']

// The nudge on serial read-only calls outside exec (see the tool.call hook).
const PROBE_TOOLS = new Set(['Bash', 'Grep', 'Glob'])
// Calls that neither count nor end a run of probes. Read often comes
// before an Edit, so it stays out of the count.
const NEUTRAL_TOOLS = new Set(['Read', 'ToolSearch', 'TaskOutput', 'TodoWrite'])
const NUDGE_MAX = 3
const MAIN_LOOP = 'main'
const NUDGE =
  'codemode: this is the second read-only call in a row outside exec. Put the next independent probes in one mcp__codemode__exec.'
// probes counts the direct read-only calls since the last reset.
type Loop = { probes: number; isNudged: boolean; nudges: number }
// Core's read-only check does not cover ssh and a few other readers, so a Bash
// call also counts when its first word reads and nothing in it writes. The
// same lists as scripts/usage.py.
const LEAD = /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*|[A-Z_][A-Z0-9_]*=\S*\s+|timeout\s+(?:-\S+\s+\S+\s+)?\S+\s+)*/
const READ_HEAD =
  /^(?:rg|grep|ug|sed|awk|cat|head|tail|ls|fd|find|plocate|wc|jq|stat|file|du|df|md5sum|diff|ssh|curl|unzip|javap|docker|journalctl|git\s+(?:log|show|status|diff|blame|grep|ls-files))\b/
const WRITES =
  /(^|[^>&0-9])>(?!&|\/dev\/null)|\btee\b|\bsed\s+-i|\b(?:mv|cp|rm|mkdir|chmod|chown|scp|rsync)\b|\bgit\s+(?:commit|push|add|checkout|reset|stash|pull)/
const readsByName = (command: unknown) =>
  typeof command === 'string' && READ_HEAD.test(command.replace(LEAD, '')) && !WRITES.test(command)

const STORE_INDEX = { plugin: 'codemode', key: 'keys' } as const
const STORE_VALUES = { plugin: 'codemode', key: 'values' } as const
const DESCRIPTIONS = { plugin: 'codemode', key: 'descriptions' } as const
const RUNS = { plugin: 'codemode', key: 'runs' } as const
const EXPANDED = { plugin: 'codemode', key: 'expanded' } as const

// The host rejects a tool description over 4096 chars, and then the tool
// does not exist in the session. Keep DESCRIPTION near 2900 chars. The MCP
// client also cuts every listed description to 2048 chars
// (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH), so tool.describe puts the full
// text back.
const MAX_DESCRIPTION = 4000
const REPAIR_LINE =
  'codemode repairs near-miss tool names and input keys (read to Read, path to file_path), and the ledger lists each repair.'
const DESCRIPTION = `Run a JavaScript or TypeScript program that calls Claude Code tools. Only its return value, console lines and a call ledger come back.

Use it for every read-only probe (rg, ssh, sed, cat, Mongo, reads of files you will not edit) when another probe may follow, even if this one is a single call. Before the first probe, list what you need to know, then fetch every independent part in one exec. Use plain Bash only for writes and for jobs over about a minute (run_in_background).

The program is the body of an async function: use await and return. Strings come back as is, other values as JSON, long multi-line strings as raw sections. TS types are stripped; enum and namespace fail. No Node APIs: all I/O goes through tools, under the normal permissions.

Globals:
- sh(cmd, opts?) or sh\`cmd \${x}\`: { ok, code, out, saved? }. A non-zero exit is data, so one empty grep does not stop a batch (no match: code 1, meaning "No matches found"). A deny or Bash timeout throws. Template values become single-quoted words; arrays give one word per item. opts go to Bash (timeout ms, description).
- ssh(host, script, opts?) or ssh(host)\`...\`: { ok, code, out, host, timedOut }. The script goes to remote bash on stdin: no extra quoting. Give stdin readers </dev/null. Auto mode may deny an inline script with \${...} next to quotes: keep such a script in a file. opts.timeout in s, default 90. Exit 255: ssh failed.
- bash(cmd, opts?): stdout. A non-zero exit throws ToolError.
- read(path, { offset, limit }?): content without line numbers. Big files are paged up to about 48k tokens; a cut read ends with a "[codemode: read stopped at line N ...]" line.
- tools.Name(input): the tool's text; throws ToolError. call(name, input): { text, result, isError, deny }; never throws.
- agent(prompt, { type, model, description, name, cwd }?): the subagent's final answer. Throws ToolError on a deny or a failed agent. Agent waits take no call slot, so Promise.all fans out many.
- q(...words): POSIX single-quoted words.
- listTools(filter?), describe(name): tool names and full descriptions.
- store.get/set/delete/keys: JSON kept across execs in this session (256 keys, 1 MB each). Bash cannot see it.
- helpers(): doc lines of the loaded prelude files. projectDir: launch dir, or the nearest one above it with .codemode.
- console.log, ToolError (.tool, .text).

Bash output: stdout with stderr merged, cut at 30000 chars (sh and ssh give saved, the full-output path). A failed call keeps 10000 chars. With run_in_background, Bash returns the task id at once.

${REPAIR_LINE}

Prelude: each exec first runs ~/.claude/codemode/prelude/*.{js,ts}, then <projectDir>/.codemode/prelude/*.{js,ts}. Their top-level declarations are globals. A prelude that throws is skipped with a note.

timeoutSeconds (default 120, max 600) counts program time only, not tool waits. 8 calls run at once, 300 per run.

Example:
const [hits, disk] = await Promise.all([sh\`rg -n -i \${"needle"} src\`, ssh("buildhost", "df -h /")])
return { hits: hits.ok ? hits.out : \`exit \${hits.code}\`, disk: disk.out }`

const DESCRIPTION_PY = `Run a Python program that calls Claude Code tools. Only its return value, printed lines and a call ledger come back.

Use it for every read-only probe (rg, ssh, sed, cat, Mongo, reads of files you will not edit) when another probe may follow, even if this one is a single call. Before the first probe, list what you need to know, then fetch every independent part in one exec. Use plain Bash only for writes and for jobs over about a minute (run_in_background).

The program is the body of an async function: use await and return. Strings come back as is, other values as JSON, long multi-line strings as raw sections. A sandbox blocks network and host files: all I/O goes through tools, under the normal permissions. asyncio, json and re are preloaded.

Globals (await all but q and helpers):
- sh(cmd, **opts): {ok, code, out, saved?}. A non-zero exit is data, so one empty grep does not stop a batch (no match: code 1, meaning "No matches found"). A deny or Bash timeout raises. Quote values with q(). opts go to Bash (timeout ms, description).
- ssh(host, script, timeout=90): {ok, code, out, host, timedOut}. The script goes to remote bash on stdin: no extra quoting. Give stdin readers </dev/null. Auto mode may deny an inline script with \${...} next to quotes: keep such a script in a file. Exit 255: ssh failed.
- bash(cmd, **opts): stdout. A non-zero exit raises ToolError.
- read(path, offset=None, limit=None): content without line numbers. Big files are paged up to about 48k tokens; a cut read ends with a "[codemode: read stopped at line N ...]" line.
- tools.Name(input=None, **kw): the tool's text; raises ToolError. call(name, input=None, **kw): {text, result, isError, deny}; never raises.
- agent(prompt, type="general-purpose", model=None, description=None, name=None, cwd=None): the subagent's final answer. Raises ToolError on a deny or a failed agent. Agent waits take no call slot, so asyncio.gather fans out many.
- q(*words): POSIX single-quoted words; lists give one word per item.
- list_tools(filter=None), describe(name): tool names and full descriptions.
- store.get/set/delete/keys: JSON kept across execs in this session (256 keys, 1 MB each). Bash cannot see it.
- helpers(): doc lines of the loaded prelude files. project_dir: launch dir, or the nearest one above it with .codemode.
- print, ToolError (.tool, .text). Results are dicts that also read keys as attributes: r.out is r["out"].

Bash output: stdout with stderr merged, cut at 30000 chars (sh and ssh give saved, the full-output path). A failed call keeps 10000 chars. With run_in_background, Bash returns the task id at once.

${REPAIR_LINE}

Prelude: each exec first runs ~/.claude/codemode/prelude/*.py, then <projectDir>/.codemode/prelude/*.py. Their top-level names are globals. A prelude that raises is skipped with a note.

timeoutSeconds (default 120, max 600) counts program time only, not tool waits. 8 calls run at once, 300 per run.

Example:
hits, disk = await asyncio.gather(sh(f"rg -n -i {q('needle')} src"), ssh("buildhost", "df -h /"))
return {"hits": hits.out if hits.ok else f"exit {hits.code}", "disk": disk.out}`

const PROGRAM_PARAM: Record<Lang, string> = {
  js: 'Body of an async function. Use await and return.',
  py: 'Body of an async Python function. Use await and return.',
}

// quiet: a read() page. When it fails on Read's size or token cap, read() pages
// around it, so it leaves no ledger entry. soft: an sh() or ssh() call.
// label: the ledger argument in place of the command head.
type Call = {
  type: 'call'
  id: number
  tool: string
  // A plain string fills the tool's primary key (see PRIMARY).
  input: Record<string, unknown> | string
  quiet?: boolean
  soft?: boolean
  label?: string
}
type Done = {
  type: 'done'
  ok: boolean
  kind?: 'parse' | 'error' | 'crash' | 'timeout'
  value?: string
  note?: string
  error?: string
  logs?: string[]
  programSeconds?: number
}
type Reply = { text?: string; result?: unknown; isError?: boolean; deny?: string }
// exit: a soft call's non-zero exit code. Its state is ok. repairs: the
// name and key fixes the call got (see the tool repair section).
type Entry = {
  tool: string
  arg: string
  state: 'running' | 'ok' | 'failed' | 'denied'
  note?: string
  exit?: number
  repairs?: string[]
}
type Prelude = { path: string; source?: string; error?: string }

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, Math.max(0, max - 3))}...` : line
}

// The argument a person would name the call by: a path, a command head.
const brief = (input: Record<string, unknown>) => {
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query
  return typeof v === 'string' ? oneLine(v, 60) : ''
}

const cutMiddle = (text: string, max: number) => {
  if (text.length <= max) return text
  const keep = Math.max(0, max - 60)
  const head = text.slice(0, Math.ceil(keep / 2))
  const tail = text.slice(text.length - Math.floor(keep / 2))
  return `${head}\n[... ${text.length - head.length - tail.length} chars cut here ...]\n${tail}`
}

// The row's label when the model gave no title: the program's first code line.
const headline = (program: string) =>
  oneLine(program.split('\n').find(l => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l)) ?? '', 80)

// The text of a stored result: a string, or text content blocks.
const outputText = (output: unknown): string | undefined => {
  if (typeof output === 'string') return output
  const blocks = Array.isArray(output)
    ? output
    : (output as { content?: unknown } | null)?.content
  if (!Array.isArray(blocks)) return undefined
  return blocks.map(b => (typeof b?.text === 'string' ? b.text : '')).join('\n')
}

// The ledger footer starts at the line "calls: N (...)".
const splitFooter = (text: string) => {
  const at = text.search(/\n\ncalls: \d+ \(/)
  return at < 0 ? { body: text, footer: '' } : { body: text.slice(0, at), footer: text.slice(at + 2) }
}

const runMeta = (run: CodemodeRun | undefined, isRunning: boolean) => {
  if (!run) return isRunning ? 'running' : ''
  const parts = [`${run.calls} call${run.calls === 1 ? '' : 's'}`]
  if (run.failed) parts.push(`${run.failed} failed`)
  if (run.denied) parts.push(`${run.denied} denied`)
  parts.push(`${run.seconds}s`)
  return isRunning ? `running · ${parts.join(' · ')}` : parts.join(' · ')
}

const summary = (description: string) => oneLine(description.split(/(?<=\.)\s|\n/)[0] ?? '', 160)

const distance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)))
    }
    row = next
  }
  return row[b.length] ?? 0
}

const unknownTool = (name: string, names: string[], lang: Lang) => {
  const want = name.toLowerCase()
  const close = names
    .map(n => ({ n, d: distance(want, n.toLowerCase()) }))
    .filter(x => x.d <= Math.max(2, Math.ceil(want.length / 2)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(x => x.n)
  const hint = close.length ? ` Close names: ${close.join(', ')}.` : ''
  return `No tool named "${name}" in this session.${hint} ${lang === 'py' ? 'list_tools()' : 'listTools()'} lists them all.`
}

const tally = (entries: Entry[]) => {
  const counts = new Map<string, number>()
  for (const c of entries) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1)
  return [...counts].map(([tool, n]) => `${tool} ${n}`).join(', ')
}

// One footer line: the calls by tool, then failures and denials with the
// first line of each, 300 chars of snippets at most.
const ledgerLine = (ledger: Entry[]) => {
  if (!ledger.length) return ''
  let room = 300
  const group = (state: Entry['state']) => {
    const hit = ledger.filter(c => c.state === state)
    if (!hit.length) return 'none'
    const tools = [...new Set(hit.map(c => c.tool))]
    return tools
      .map(tool => {
        const mine = hit.filter(c => c.tool === tool)
        const first = (mine[0]?.note ?? '').split('\n')[0] ?? ''
        const snippet = oneLine(first, Math.min(120, room))
        room -= snippet.length
        return `${tool} x${mine.length}${snippet ? ` "${snippet}"` : ''}`
      })
      .join(', ')
  }
  const nonzero = ledger.filter(c => c.exit !== undefined).length
  const exits = nonzero ? `; nonzero exits: ${nonzero}` : ''
  const fixes = new Map<string, number>()
  for (const c of ledger) for (const fix of c.repairs ?? []) fixes.set(fix, (fixes.get(fix) ?? 0) + 1)
  const repaired = fixes.size
    ? `; repaired: ${oneLine([...fixes].map(([fix, n]) => (n > 1 ? `${fix} x${n}` : fix)).join(', '), 200)}`
    : ''
  return `calls: ${ledger.length} (${tally(ledger)})${exits}; failed: ${group('failed')}; denied: ${group('denied')}${repaired}`
}

// Tool repair. A near-miss tool name or input key gets its canonical form
// before the call, or once after an InputValidationError. The canonical key
// always wins: a repair never overwrites a key that is present.

type KeyType = 'string' | 'number' | 'boolean' | 'other'
// The input keys of the built-in tools, from BuiltinToolInputs. Grep and Glob
// are not in it; their keys are the ones of Claude Code's own Grep and Glob.
const KEYS: Record<string, Record<string, KeyType>> = {
  Read: { file_path: 'string', offset: 'number', limit: 'number', pages: 'string' },
  Write: { file_path: 'string', content: 'string' },
  Edit: { file_path: 'string', old_string: 'string', new_string: 'string', replace_all: 'boolean' },
  Bash: {
    command: 'string',
    timeout: 'number',
    description: 'string',
    run_in_background: 'boolean',
    dangerouslyDisableSandbox: 'boolean',
  },
  Grep: {
    pattern: 'string',
    path: 'string',
    glob: 'string',
    output_mode: 'string',
    '-B': 'number',
    '-A': 'number',
    '-C': 'number',
    context: 'number',
    '-n': 'boolean',
    '-i': 'boolean',
    type: 'string',
    head_limit: 'number',
    offset: 'number',
    multiline: 'boolean',
  },
  Glob: { pattern: 'string', path: 'string' },
  WebFetch: { url: 'string', prompt: 'string' },
  WebSearch: { query: 'string', allowed_domains: 'other', blocked_domains: 'other' },
  NotebookEdit: {
    notebook_path: 'string',
    cell_id: 'string',
    new_source: 'string',
    cell_type: 'string',
    edit_mode: 'string',
  },
  ToolSearch: { query: 'string', max_results: 'number' },
}
const FILE_KEYS = { path: 'file_path', file: 'file_path', filename: 'file_path' }
const DIR_KEYS = { dir: 'path', directory: 'path' }
// Key aliases per built-in. Each target is a key of KEYS.
const KEY_ALIASES: Record<string, Record<string, string>> = {
  Read: FILE_KEYS,
  Write: { ...FILE_KEYS, text: 'content', contents: 'content' },
  Edit: {
    ...FILE_KEYS,
    old: 'old_string',
    oldText: 'old_string',
    old_text: 'old_string',
    old_str: 'old_string',
    new: 'new_string',
    newText: 'new_string',
    new_text: 'new_string',
    new_str: 'new_string',
  },
  NotebookEdit: { path: 'notebook_path', notebook: 'notebook_path' },
  Bash: { cmd: 'command', script: 'command' },
  Grep: { regex: 'pattern', ignore_case: '-i', case_insensitive: '-i', ...DIR_KEYS },
  Glob: { glob: 'pattern', ...DIR_KEYS },
  WebFetch: { link: 'url' },
  WebSearch: { q: 'query' },
}
// The key a plain string input fills.
const PRIMARY: Record<string, string> = {
  Read: 'file_path',
  Bash: 'command',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  ToolSearch: 'query',
  Agent: 'prompt',
}
// Tool name aliases by squashed name. Each applies only when its tool is in the session.
const TOOL_ALIASES: Record<string, string> = {
  shell: 'Bash',
  readfile: 'Read',
  writefile: 'Write',
  editfile: 'Edit',
  search: 'Grep',
  fetch: 'WebFetch',
}

const own = <T,>(table: Record<string, T>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined)
const squash = (name: string) => name.toLowerCase().replace(/[-_.\s]/g, '')
const snake = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()

// The one session tool a near-miss name means. Zero or several matches give undefined.
const resolveTool = (name: string, names: string[]) => {
  const want = squash(name)
  const hits = names.filter(n => n !== TOOL && squash(n) === want)
  if (hits.length) return hits.length === 1 ? hits[0] : undefined
  const alias = own(TOOL_ALIASES, want)
  return alias !== undefined && names.includes(alias) ? alias : undefined
}

// A string that turns into a number or boolean without loss, else undefined.
const coerce = (type: KeyType | string | undefined, value: unknown) => {
  if (typeof value !== 'string') return undefined
  if (type === 'number' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true'
  return undefined
}

type Repair = { input: Record<string, unknown>; repairs: string[]; renames: [string, string][] }

const renameKey = (tool: string, input: Record<string, unknown>, from: string, to: string, repairs: string[]) => {
  if (from === to || !Object.hasOwn(input, from) || Object.hasOwn(input, to)) return false
  input[to] = input[from]
  delete input[from]
  repairs.push(`${tool} ${from}→${to}`)
  return true
}

// The fixes before a call: the renames learned in this session, then for a
// built-in the key aliases, null drops and number or boolean strings.
const repairBefore = (tool: string, input: Record<string, unknown>, learned?: Map<string, string>) => {
  const out = { ...input }
  const repairs: string[] = []
  for (const [from, to] of learned ?? []) renameKey(tool, out, from, to, repairs)
  const keys = own(KEYS, tool)
  if (!keys) return { input: out, repairs }
  const aliases = own(KEY_ALIASES, tool) ?? {}
  for (const key of Object.keys(out)) {
    if (Object.hasOwn(keys, key)) continue
    const target = Object.hasOwn(keys, snake(key)) ? snake(key) : own(aliases, key)
    if (target !== undefined && Object.hasOwn(keys, target)) renameKey(tool, out, key, target, repairs)
  }
  for (const [key, value] of Object.entries(out)) {
    if (value === null) {
      delete out[key]
      repairs.push(`${tool} ${key}:null dropped`)
      continue
    }
    const fixed = coerce(own(keys, key), value)
    if (fixed !== undefined) {
      out[key] = fixed
      repairs.push(`${tool} ${key}→${typeof fixed}`)
    }
  }
  return { input: out, repairs }
}

type Issue = { code?: string; path?: unknown[]; message?: string; keys?: unknown[]; expected?: string }

// The issues of an InputValidationError: the zod list in result, else the
// readable lines of text. Undefined for any other result.
const validationIssues = (r: { result?: unknown; text?: string }): Issue[] | undefined => {
  const zod = typeof r.result === 'string' ? /^InputValidationError: (\[[\s\S]*\])\s*$/.exec(r.result)?.[1] : undefined
  if (zod !== undefined) {
    try {
      const issues: unknown = JSON.parse(zod)
      if (Array.isArray(issues)) return issues as Issue[]
    } catch {}
  }
  const text = r.text ?? ''
  if (!text.includes('InputValidationError')) return undefined
  const issues: Issue[] = []
  for (const m of text.matchAll(/An unexpected parameter `([^`]+)` was provided/g)) {
    issues.push({ code: 'unrecognized_keys', path: [], keys: [m[1]] })
  }
  for (const m of text.matchAll(/The required parameter `([^`]+)` is missing/g)) {
    issues.push({ code: 'invalid_type', path: [m[1]], message: 'received undefined' })
  }
  for (const m of text.matchAll(/The parameter `([^`]+)` type is expected as `(\w+)` but provided as `(\w+)`/g)) {
    issues.push({ code: 'invalid_type', path: [m[1]], expected: m[2], message: `received ${m[3]}` })
  }
  return issues
}

// One fix for all the issues of a failed validation: a single unknown key
// renamed to a single missing key, a lossless number or boolean string
// coerced, a null dropped. Undefined when an issue has no fix.
const repairAfter = (tool: string, input: Record<string, unknown>, issues: Issue[]): Repair | undefined => {
  const out = { ...input }
  const repairs: string[] = []
  const unknown: string[] = []
  const missing: string[] = []
  for (const issue of issues) {
    const path = Array.isArray(issue.path) ? issue.path : []
    if (issue.code === 'unrecognized_keys' && path.length === 0) {
      unknown.push(...(issue.keys ?? []).map(String))
      continue
    }
    if (issue.code !== 'invalid_type' || path.length !== 1) return undefined
    const key = String(path[0])
    const received = /received (\w+)/.exec(issue.message ?? '')?.[1]
    if (received === 'undefined') missing.push(key)
    else if (received === 'null' && out[key] === null) {
      delete out[key]
      repairs.push(`${tool} ${key}:null dropped`)
    } else {
      const fixed = received === 'string' ? coerce(issue.expected, out[key]) : undefined
      if (fixed === undefined) return undefined
      out[key] = fixed
      repairs.push(`${tool} ${key}→${typeof fixed}`)
    }
  }
  const renames: [string, string][] = []
  if (unknown.length || missing.length) {
    const [from, to] = [unknown[0], missing[0]]
    if (unknown.length !== 1 || missing.length !== 1 || from === undefined || to === undefined) return undefined
    if (!renameKey(tool, out, from, to, repairs)) return undefined
    renames.push([from, to])
  }
  return repairs.length ? { input: out, repairs, renames } : undefined
}

// The exit code of a soft call that ended in a plain non-zero exit.
const softExit = (text: string) => {
  const code = Number(EXIT.exec(text)?.[1])
  if (!Number.isInteger(code)) return undefined
  return (code === 143 || code === 137) && BASH_KILLED.test(text) ? undefined : code
}

// Agent calls. The host refuses the Agent tool through $.tool.call, so exec
// spawns with $.agent.spawn. Its args take these Agent tool keys.
const SPAWN_KEYS: Record<string, keyof AgentSpawnArgs> = {
  prompt: 'prompt',
  subagent_type: 'subagentType',
  subagentType: 'subagentType',
  description: 'description',
  model: 'model',
  name: 'name',
  cwd: 'cwd',
}

// The spawn args of an Agent call, or the error text.
const spawnArgs = (input: Record<string, unknown>): AgentSpawnArgs | string => {
  const args: Partial<Record<keyof AgentSpawnArgs, string>> = {}
  const unknown: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue
    const to = own(SPAWN_KEYS, key)
    if (to === undefined) unknown.push(key)
    else if (typeof value !== 'string') return `The Agent parameter ${key} must be a string.`
    else args[to] = value
  }
  if (unknown.length) {
    return `Agent in exec takes prompt, subagent_type, description, model, name and cwd. It does not take ${unknown.join(', ')}.`
  }
  const prompt = args.prompt
  if (!prompt?.trim()) return 'Agent needs a prompt.'
  return { ...args, prompt, description: args.description ?? oneLine(prompt, 40) }
}

// The error text of an agent run that did not end in an answer.
const agentFailure = (e: TurnCompleteInput) => {
  const said = e.answer.trim() ? `\n${e.answer}` : ''
  if (e.reason === 'refusal') {
    const why = e.refusal.explanation ?? e.refusal.category
    return `The agent refused${why ? `: ${why}` : '.'}${said}`
  }
  if (e.reason === 'aborted') return `The agent was stopped before it answered.${said}`
  return `The agent ended on an API error.${said}`
}

// A spawned agent also delivers its answer to the main loop: a hand-back
// (<agent-message from="ID">) and task notifications (<task-id>ID</task-id>).
// The harness indents a hand-back's report, so only real frame lines start
// at column zero.
const DELIVERY_KINDS = new Set(['task-notification', 'peer', 'peer-send-message'])
const DELIVERY_BLOCK =
  /^<agent-message from="([^"]+)"[^>]*>\n[\s\S]*?^<\/agent-message>[ \t]*(?:\n|$)|^<task-notification>\n[\s\S]*?^<\/task-notification>[ \t]*(?:\n|$)/gm
const TASK_ID = /<task-id>([^<]+)<\/task-id>/
// An agent may notify more than once, so its id cannot leave the set on the
// first block. The oldest ids go past this many.
const ANSWERED_MAX = 512

// The delivery text without the blocks of the given agents, and how many it lost.
const withoutAgents = (text: string, ids: Set<string>) => {
  let removed = 0
  const rest = text.replace(DELIVERY_BLOCK, (block: string, from: string | undefined) => {
    const id = from ?? TASK_ID.exec(block)?.[1]
    if (id === undefined || !ids.has(id)) return block
    removed += 1
    return ''
  })
  return { rest, removed }
}

const progressNote = (ledger: Entry[]) => {
  const done = ledger.filter(c => c.state === 'ok')
  if (!done.length) return ''
  const shown = done.slice(0, 8).map(c => (c.arg ? `${c.tool}(${c.arg})` : c.tool))
  const more = done.length > shown.length ? `; +${done.length - shown.length} more` : ''
  return `Completed before the failure (outputs not returned): ${shown.join('; ')}${more}.\nSuccessful calls may already have changed the workspace; inspect before repeating writes.`
}

const droppedNote = (ledger: Entry[]) => {
  const running = ledger.filter(c => c.state === 'running')
  if (!running.length) return ''
  const shown = running.slice(0, 8).map(c => (c.arg ? `${c.tool}(${c.arg})` : c.tool))
  return `Still running when the program ended, result dropped: ${shown.join('; ')}.`
}

const spillDir = async ($: Pick<EngineInterface, 'env'>, sessionId: string) =>
  `${(await $.env.get('XDG_RUNTIME_DIR')) ?? '/tmp'}/codemode/${sessionId}`

type Host = Pick<EngineInterface, 'env' | 'fs' | 'session'>

// The nearest dir at or above the launch dir that holds .codemode. The walk
// stops below the home dir. Without one, the launch dir itself.
const findProject = async ($: Host, root: string, home: string | undefined) => {
  for (let dir = root; dir && dir !== home && dir !== '/'; dir = dir.slice(0, dir.lastIndexOf('/'))) {
    if (await $.fs.exists(`${dir}/.codemode`).catch(() => false)) return dir
  }
  return root
}

// The prelude files of one dir for the language, sorted by name.
const preludeDir = async ($: Host, dir: string, lang: Lang): Promise<Prelude[]> => {
  const entries = await $.fs.list(dir).catch(() => [])
  const names = entries
    .filter(f => (f.kind === 'file' || f.isLink) && PRELUDE[lang].file.test(f.name))
    .map(f => f.name)
    .sort()
  return Promise.all(
    names.map(async name => {
      const path = `${dir}/${name}`
      try {
        return { path, source: await $.fs.read(path) }
      } catch (err) {
        return { path, error: `could not read it: ${err instanceof Error ? err.message : String(err)}` }
      }
    }),
  )
}

// The global prelude files, then the project's. Read again on every exec.
const loadPreludes = async ($: Host, lang: Lang, fallbackRoot?: string) => {
  const home = await $.env.get('HOME')
  const root = (await $.session.root().catch(() => undefined)) ?? fallbackRoot
  const projectDir = root === undefined ? null : await findProject($, root, home)
  const preludes = [
    ...(home ? await preludeDir($, `${home}/.claude/codemode/prelude`, lang) : []),
    ...(projectDir ? await preludeDir($, `${projectDir}/.codemode/prelude`, lang) : []),
  ]
  return { projectDir, preludes }
}

// The description's helper block: the helper signatures from the doc lines
// ("//: " in JS, "#: " in Python) at session start. helpers() gives the full lines.
const helperDocs = (preludes: Prelude[], lang: Lang, room: number) => {
  const names = preludes
    .flatMap(p => (p.source ?? '').split('\n').flatMap(l => PRELUDE[lang].doc.exec(l)?.[1] ?? []))
    .map(line => /^[^:]*?\)/.exec(line)?.[0] ?? line.split(':')[0] ?? line)
  if (!names.length) return ''
  let text = 'Prelude helpers (helpers() gives their docs; edits after session start reach the runtime only):'
  for (const [i, name] of names.entries()) {
    const part = `${i ? ',' : ''} ${name}`
    if (text.length + part.length + 12 > room) return `${text}, and more`
    text += part
  }
  return text
}

// The Python sandbox: CPython under bwrap, with no network, no host files
// but /usr, the run dir and guest.py, and an empty environment. It fails
// closed: without bwrap or a python3 under /usr, the answer is an error text.
type Box = { bwrap: string; python: string; guest: string; roots: string[] }
const pythonBox = async ($: Pick<EngineInterface, 'process' | 'fs' | 'plugin'>): Promise<Box | string> => {
  const which = async (bin: string) =>
    (await $.process.run(['sh', '-c', `command -v ${bin}`]).catch(() => undefined))?.stdout.trim() || undefined
  const bwrap = await which('bwrap')
  if (!bwrap?.startsWith('/')) {
    return 'Python mode needs bwrap (bubblewrap) to sandbox the program. No bwrap is on PATH, so the program did not run.'
  }
  const found = await which('python3')
  const python = found && (await $.fs.stat(found, { resolve: true }).catch(() => undefined))?.realPath
  if (!python) return 'Python mode needs python3. No python3 is on PATH, so the program did not run.'
  if (!python.startsWith('/usr/')) {
    return `Python mode runs only a python3 under /usr, because the sandbox binds /usr alone. python3 is ${python}, so the program did not run.`
  }
  const guest = `${$.plugin.root}/runtime/guest.py`
  const real = (await $.fs.stat(guest, { resolve: true }).catch(() => undefined))?.realPath ?? guest
  const roots: string[] = []
  for (const dir of ROOT_LINKS) {
    const stat = await $.fs.stat(dir, { resolve: true }).catch(() => undefined)
    if (stat?.isLink && stat.realPath) roots.push('--symlink', stat.realPath, dir)
    else roots.push('--ro-bind-try', dir, dir)
  }
  return { bwrap, python, guest: real, roots }
}

const pythonArgv = (box: Box, runDir: string, timeoutS: number) => [
  box.bwrap,
  '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
  '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
  '--ro-bind', '/usr', '/usr', ...box.roots,
  '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  '--ro-bind-try', '/etc/localtime', '/etc/localtime',
  '--ro-bind', runDir, runDir, '--ro-bind', box.guest, box.guest,
  box.python, '-I', '-B', box.guest, runDir, String(timeoutS),
]

export const register: Register = on => {
  let nodePath: string | undefined
  let guestPath: string | undefined
  let box: Box | undefined
  // The language of this session, read once at session start. A hot reload
  // does not run session.start again, so it falls back to JS.
  let lang: Lang = 'js'
  // Key renames that passed validation after a failed call, by tool, for
  // the rest of the session.
  const learned = new Map<string, Map<string, string>>()
  // The descriptions already saved to state, so a repeat describe writes nothing.
  const seen = new Map<string, string>()
  // The exec description as registered, before the MCP client cuts it.
  let execDescription = DESCRIPTION

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = langOf(await $.env.get('CODEMODE_LANG').catch(() => undefined))
    learned.clear()
    const base = lang === 'py' ? DESCRIPTION_PY : DESCRIPTION
    const { preludes } = await loadPreludes($, lang, e.cwd).catch(() => ({ preludes: [] }))
    const docs = helperDocs(preludes, lang, MAX_DESCRIPTION - base.length - 2)
    const description = docs ? `${base}\n\n${docs}` : base
    execDescription = description.length <= MAX_DESCRIPTION ? description : base
    await $.tool.register({
      name: 'exec',
      description: execDescription,
      inputSchema: {
        type: 'object',
        properties: {
          program: { type: 'string', description: PROGRAM_PARAM[lang] },
          timeoutSeconds: {
            type: 'number',
            description: `Program-time limit in seconds. Waiting on tools does not count. Default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.`,
          },
          title: { type: 'string', description: 'A 3 to 6 word label for the transcript row and the status line.' },
        },
        required: ['program'],
      },
    })
    return started
  })

  // $.tool.list() cuts descriptions short, so describe() serves the full
  // text the engine rendered. Every answer passes through unchanged, except
  // exec: it gets its uncut description and stays out of ToolSearch.
  on('tool.describe', async ($, e, next) => {
    const engine = await next(e)
    const described = e.tool === TOOL ? { description: execDescription, isDeferred: false } : engine
    if (seen.get(e.tool) !== described.description) {
      seen.set(e.tool, described.description)
      await $.state.set({ ...DESCRIPTIONS, id: e.tool }, described.description).catch(() => undefined)
    }
    return described
  })

  // The nudge. A probe is a model call to Bash, Grep or Glob that core marks
  // read-only, or a Bash call that reads by name. The second probe in a row in
  // one loop gets a short reminder in context, once per run of probes and
  // NUDGE_MAX times per loop. Parallel probes count too: the engine runs each
  // call as its block arrives, so one response cannot be told apart, and the
  // rule says they belong in one exec anyway. Exec's own inner
  // calls (origin codemode) and calls by other plugins are not counted.
  // CODEMODE_NUDGE=0 turns it off.
  const loops = new Map<string, Loop>()
  const loopOf = (id: string) => {
    let loop = loops.get(id)
    if (!loop) loops.set(id, (loop = { probes: 0, isNudged: false, nudges: 0 }))
    return loop
  }
  let isNudgeOn: boolean | undefined
  on('tool.call', async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    isNudgeOn ??= (await $.env.get('CODEMODE_NUDGE').catch(() => undefined)) !== '0'
    const loop = loopOf(e.agentId ?? MAIN_LOOP)
    if (!PROBE_TOOLS.has(e.tool)) {
      if (!NEUTRAL_TOOLS.has(e.tool)) loop.probes = 0
      return next(e)
    }
    const r = await next(e)
    const input = e as { run_in_background?: unknown; command?: unknown }
    const isRead = r.isReadOnly === true || (e.tool === 'Bash' && readsByName(input.command))
    if (r.deny !== undefined || !isRead || input.run_in_background === true) {
      loop.probes = 0
      return r
    }
    loop.probes += 1
    if (loop.probes === 1) loop.isNudged = false
    if (!isNudgeOn || loop.probes < 2 || loop.isNudged || loop.nudges >= NUDGE_MAX) return r
    loop.isNudged = true
    loop.nudges += 1
    return { ...r, context: [...(r.context ?? []), NUDGE] }
  })

  on('session.end', async ($, e, next) => {
    await $.process.run(['rm', '-rf', await spillDir($, e.sessionId)]).catch(() => undefined)
    const index = await $.state.get({ ...STORE_INDEX, id: e.sessionId }).catch(() => undefined)
    const keys = index?.value ?? []
    if (keys.length) {
      await Promise.allSettled([
        ...keys.map(key => $.state.set({ ...STORE_VALUES, id: `${e.sessionId}/${key}` }, null)),
        $.state.set({ ...STORE_INDEX, id: e.sessionId }, []),
      ])
    }
    return next(e)
  })

  // $.agent.spawn resolves once the agent started. Its answer is the
  // turn.complete of its loop, matched here by agentId. A turn that ends
  // while a spawn is in flight waits in early, because that spawn has not
  // given its agentId yet.
  const waiting = new Map<string, (e: TurnCompleteInput) => void>()
  const early = new Map<string, TurnCompleteInput>()
  let spawning = 0
  const finished = (agentId: string) =>
    new Promise<TurnCompleteInput>(resolve => {
      const ended = early.get(agentId)
      if (ended === undefined) waiting.set(agentId, resolve)
      else {
        early.delete(agentId)
        resolve(ended)
      }
    })
  // The agents whose answer an exec program received. Their deliveries to
  // the main loop would repeat it.
  const answered = new Set<string>()
  const markAnswered = (id: string) => {
    answered.add(id)
    for (const old of answered) {
      if (answered.size <= ANSWERED_MAX) break
      answered.delete(old)
    }
  }
  // A prompt resets the probe count of the nudge. The engine allows one
  // prompt.submit hook per module, so both jobs share it.
  on('prompt.submit', async ($, e, next) => {
    loopOf(MAIN_LOOP).probes = 0
    if (!answered.size || !DELIVERY_KINDS.has(e.origin.kind)) return next(e)
    const { rest, removed } = withoutAgents(e.text, answered)
    if (!removed) return next(e)
    if (!rest.trim()) return { drop: 'codemode: an exec program already received this agent answer.' }
    return next({ ...e, text: rest })
  })
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const resolve = waiting.get(id)
      if (resolve) {
        waiting.delete(id)
        resolve(e)
      } else if (spawning > 0) early.set(id, e)
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const program = typeof e.program === 'string' ? e.program : ''
    if (!program.trim()) return { result: 'Error: the program is empty.', isError: true as const }
    const timeoutS = Math.min(Math.max(Number(e.timeoutSeconds) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S)
    const title = typeof e.title === 'string' ? oneLine(e.title, 60) : ''
    const sessionId = await $.session.id()
    const runRef = { ...RUNS, id: e.tool_use_id }
    const startedAt = await $.clock.now()
    // One run keeps the language it started with.
    const runLang = lang
    const isPy = runLang === 'py'

    if (isPy) {
      const found = box ?? (await pythonBox($))
      if (typeof found === 'string') return { result: `Error: ${found}`, isError: true as const }
      box = found
    } else {
      nodePath ??= (await $.process.run(['sh', '-c', 'command -v node'])).stdout.trim() || 'node'
      if (guestPath === undefined) {
        const guest = `${$.plugin.root}/runtime/guest.mjs`
        guestPath = (await $.fs.stat(guest, { resolve: true })).realPath ?? guest
      }
    }
    const runDir = (await $.process.run(['mktemp', '-d', '-t', 'codemode.XXXXXX'])).stdout.trim()
    const { projectDir, preludes } = await loadPreludes($, runLang).catch(() => ({
      projectDir: null,
      preludes: [],
    }))

    const ledger: Entry[] = []
    let isClosed = false
    // The transcript row reads this, so it redraws as calls come and go.
    const publish = async (isDone = false, isOk = true) => {
      const seconds = Math.round(((await $.clock.now()) - startedAt) / 100) / 10
      const count = (state: Entry['state']) => ledger.filter(c => c.state === state).length
      const run: CodemodeRun = {
        title: title || headline(program),
        calls: ledger.length,
        failed: count('failed'),
        denied: count('denied'),
        isDone,
        isOk,
        seconds,
      }
      await $.state.set(runRef, run).catch(() => undefined)
    }
    const showStatus = () => {
      if (isClosed) return
      $.ui.status(`codemode: ${title ? `${title} · ` : ''}${ledger.length} calls`)
      void publish()
    }

    let active = 0
    const queue: (() => void)[] = []
    const acquire = () =>
      active < MAX_PARALLEL ? ((active += 1), Promise.resolve()) : new Promise<void>(r => queue.push(r))
    const release = () => {
      const next = queue.shift()
      if (next) next()
      else active -= 1
    }

    let tools: { name: string; description: string }[] | undefined
    const toolList = async () => (tools ??= (await $.tool.list()).filter(t => t.name !== TOOL))

    // The engine throws for a tool it does not know.
    const attempt = async (name: string, input: Record<string, unknown>) => {
      try {
        return { r: await $.tool.call({ ...input, tool: name } as never) }
      } catch (err) {
        return { err }
      }
    }
    const learn = (name: string, renames: [string, string][]) => {
      if (!renames.length) return
      const known = learned.get(name) ?? new Map<string, string>()
      for (const [from, to] of renames) known.set(from, to)
      learned.set(name, known)
    }

    // The agents of this run whose answer has not come yet. Agent calls take
    // no call slot: Claude Code's own subagent limit governs them.
    const spawned = new Set<string>()
    const callAgent = async (entry: Entry, input: Record<string, unknown>): Promise<Reply> => {
      const fail = (text: string): Reply => {
        entry.state = 'failed'
        entry.note = text
        return { isError: true, text }
      }
      const args = spawnArgs(input)
      if (typeof args === 'string') return fail(args)
      // The exec's own loop is the parent. AgentSpawnArgs has no such key, and
      // this release drops it (tested): an agent spawned from a subagent's
      // exec gets no parentId and reports to the main loop.
      const parent = e.agentId === undefined ? {} : { parentAgentId: e.agentId }
      let started: AgentSpawnResult | undefined
      let error: unknown
      spawning += 1
      try {
        started = await $.agent.spawn({ ...args, ...parent } as AgentSpawnArgs)
      } catch (err) {
        error = err
      }
      spawning -= 1
      const agentId = started?.agentId
      const answer = agentId === undefined || isClosed ? undefined : finished(agentId)
      if (spawning === 0) early.clear()
      if (started === undefined) return fail(error instanceof Error ? error.message : String(error))
      if (started.deny !== undefined) {
        entry.state = 'denied'
        entry.note = started.deny
        return { deny: started.deny }
      }
      if (agentId === undefined) return fail('The spawn started no local agent, so no answer can come back.')
      if (answer === undefined) return fail('The exec run ended before the spawn answered.')
      spawned.add(agentId)
      const ended = await answer
      spawned.delete(agentId)
      if (ended.reason !== 'answer') return fail(agentFailure(ended))
      if (!isClosed) markAnswered(agentId)
      entry.state = 'ok'
      return { text: ended.answer, result: { agentId, model: started.model } }
    }

    const callTool = async (
      tool: string,
      raw: Record<string, unknown> | string,
      { quiet = false, soft = false, label }: Pick<Call, 'quiet' | 'soft' | 'label'> = {},
    ): Promise<Reply> => {
      if (tool === TOOL) return { deny: 'codemode cannot call itself.' }
      let name = tool
      const repairs: string[] = []
      if (name !== 'Agent' && squash(name) === 'agent') {
        repairs.push(`${name}→Agent`)
        name = 'Agent'
      }
      let input: Record<string, unknown>
      if (typeof raw === 'string') {
        // A string fills the primary key of the tool, so a near-miss name
        // has to resolve first.
        if (own(PRIMARY, name) === undefined) {
          const fixed = resolveTool(name, (await toolList().catch(() => [])).map(t => t.name))
          if (fixed !== undefined && fixed !== name) {
            repairs.push(`${name}→${fixed}`)
            name = fixed
          }
        }
        const key = own(PRIMARY, name)
        if (key === undefined) return { isError: true, text: `The input of ${tool} must be an object of its parameters.` }
        input = { [key]: raw }
        repairs.push(`${name} string→${key}`)
      } else input = raw
      let sent = repairBefore(name, input, learned.get(name))
      const arg =
        typeof label === 'string' && label.trim()
          ? oneLine(label, 60)
          : name === 'Agent'
            ? oneLine(String(sent.input.description ?? sent.input.prompt ?? ''), 60)
            : brief(sent.input)
      const entry: Entry = { tool: name, arg, state: 'running', repairs }
      ledger.push(entry)
      showStatus()
      if (ledger.length > MAX_CALLS) {
        entry.state = 'denied'
        entry.note = 'call budget reached'
        return { deny: `codemode allows ${MAX_CALLS} tool calls per exec. Split the work.` }
      }
      if (name === 'Agent') {
        repairs.push(...sent.repairs)
        try {
          return await callAgent(entry, sent.input)
        } finally {
          if (!isClosed) void publish()
        }
      }
      await acquire()
      try {
        let out = await attempt(name, sent.input)
        if ('err' in out) {
          // Names resolve lazily, so a call by the right name costs no list call.
          const names = (await toolList().catch(() => [])).map(t => t.name)
          if (names.includes(name)) throw out.err
          const fixed = resolveTool(name, names)
          if (fixed === undefined) {
            entry.state = 'failed'
            entry.note = 'no such tool'
            return { isError: true, text: unknownTool(name, names, runLang) }
          }
          repairs.push(`${name}→${fixed}`)
          name = fixed
          entry.tool = fixed
          sent = repairBefore(name, input, learned.get(name))
          out = await attempt(name, sent.input)
          if ('err' in out) throw out.err
        }
        repairs.push(...sent.repairs)
        let r = out.r
        // Validation fails before the tool runs, so one retry repeats no side effect.
        const issues = r.isError === true ? validationIssues(r) : undefined
        const fix = issues && repairAfter(name, sent.input, issues)
        if (fix) {
          const again = await attempt(name, fix.input)
          if (again.r !== undefined && !(again.r.isError === true && validationIssues(again.r))) {
            r = again.r
            repairs.push(...fix.repairs)
            learn(name, fix.renames)
          }
        }
        if (r.deny !== undefined) {
          entry.state = 'denied'
          entry.note = r.deny
          return { deny: r.deny }
        }
        if (quiet && r.isError === true && /exceeds maximum allowed (size|tokens)/.test(r.text ?? '')) {
          ledger.splice(ledger.indexOf(entry), 1)
          return { text: r.text ?? '', result: r.result, isError: true }
        }
        const exit = soft && r.isError === true ? softExit(r.text ?? '') : undefined
        if (exit !== undefined) {
          entry.state = 'ok'
          entry.exit = exit
          return { text: r.text ?? '', result: r.result, isError: true }
        }
        const timedOutAfterMs = (r.result as { timedOutAfterMs?: unknown } | undefined)?.timedOutAfterMs
        if (soft && typeof timedOutAfterMs === 'number') {
          entry.state = 'failed'
          entry.note = `timed out after ${timedOutAfterMs / 1000} s; Bash moved it to the background`
          return { text: r.text ?? '', result: r.result, isError: false }
        }
        entry.state = r.isError === true ? 'failed' : 'ok'
        if (r.isError === true) entry.note = r.text
        return { text: r.text ?? '', result: r.result, isError: r.isError === true }
      } catch (err) {
        entry.state = 'failed'
        const text = err instanceof Error ? err.message : String(err)
        entry.note = text
        return { isError: true, text }
      } finally {
        release()
        if (!isClosed) void publish()
      }
    }

    // The store keeps a local view for this run: the reads of one dispatch
    // see one moment, so the run's own writes are kept here too.
    let storeKeys: Promise<string[]> | undefined
    const stored = new Map<string, CodemodeJson>()
    const indexRef = { ...STORE_INDEX, id: sessionId }
    const storeOp = async (input: Record<string, unknown>): Promise<Reply> => {
      const keys = await (storeKeys ??= $.state.get(indexRef).then(r => [...(r.value ?? [])]))
      if (input.op === 'keys') return { result: [...keys] }
      const key = input.key
      if (typeof key !== 'string' || key === '' || key.length > 200) {
        return { isError: true, text: 'store: a key is a string of 1 to 200 chars.' }
      }
      const member = { ...STORE_VALUES, id: `${sessionId}/${key}` }
      if (input.op === 'get') {
        if (!keys.includes(key)) return { result: { found: false } }
        if (stored.has(key)) return { result: { found: true, value: stored.get(key) } }
        const { value } = await $.state.get(member)
        return { result: { found: true, value: value ?? null } }
      }
      if (input.op === 'set') {
        const value = (input.value ?? null) as CodemodeJson
        const size = JSON.stringify(value).length
        if (size > STORE_VALUE) {
          return { isError: true, text: `store.set: the value is ${size} chars of JSON; the cap is ${STORE_VALUE}.` }
        }
        if (!keys.includes(key) && keys.length >= STORE_KEYS) {
          return { isError: true, text: `store.set: the store holds ${STORE_KEYS} keys, the cap. Delete one first.` }
        }
        await $.state.set(member, value)
        stored.set(key, value)
        if (!keys.includes(key)) {
          keys.push(key)
          await $.state.set(indexRef, [...keys])
        }
        return { result: true }
      }
      if (input.op === 'delete') {
        if (!keys.includes(key)) return { result: false }
        keys.splice(keys.indexOf(key), 1)
        stored.delete(key)
        await $.state.set(indexRef, [...keys])
        await $.state.set(member, null)
        return { result: true }
      }
      return { isError: true, text: `store: unknown op ${String(input.op)}.` }
    }

    const serveOwn = async (tool: string, input: Record<string, unknown>): Promise<Reply> => {
      if (tool === '$list') {
        return { result: (await toolList()).map(t => ({ name: t.name, summary: summary(t.description) })) }
      }
      if (tool === '$describe') {
        const list = await toolList()
        const found = list.find(t => t.name === input.name)
        if (found) {
          const full = await $.state.get({ ...DESCRIPTIONS, id: found.name }).catch(() => undefined)
          return { text: full?.value ?? found.description }
        }
        return { isError: true, text: unknownTool(String(input.name), list.map(t => t.name), runLang) }
      }
      if (tool === '$store') return storeOp(input)
      return { isError: true, text: `Unknown codemode request ${tool}.` }
    }

    const serve = async ({ id, tool, input, quiet, soft, label }: Call) => {
      let reply: Reply
      try {
        reply = tool.startsWith('$')
          ? await serveOwn(tool, typeof input === 'object' && input !== null ? input : {})
          : await callTool(tool, input ?? {}, { quiet: quiet === true, soft: soft === true, label })
      } catch (err) {
        reply = { isError: true, text: err instanceof Error ? err.message : String(err) }
      }
      if (isClosed) return
      let json: string
      try {
        json = JSON.stringify(reply)
      } catch {
        json = JSON.stringify({ ...reply, result: undefined })
      }
      await $.fs.write(`${runDir}/r${id}.json`, json).catch(() => undefined)
    }

    let done: Done | undefined
    let exit: { code: number | null; signal: string | null } | undefined
    let stderr = ''
    let protocolNote = ''
    let stopNote = ''
    const inflight: Promise<void>[] = []
    const handle = (line: string) => {
      if (!line.startsWith(MARK)) return
      let msg: Call | Done
      try {
        msg = JSON.parse(line.slice(MARK.length)) as Call | Done
      } catch {
        return
      }
      if (msg.type === 'call' && typeof msg.tool === 'string' && Number.isInteger(msg.id)) inflight.push(serve(msg))
      else if (msg.type === 'done') done = msg
    }

    showStatus()
    try {
      const guest =
        isPy && box
          ? pythonArgv(box, runDir, timeoutS)
          : [
              nodePath ?? 'node', '--permission', `--allow-fs-read=${runDir}`, `--allow-fs-read=${guestPath}`,
              '--allow-worker', '--preserve-symlinks-main', '--no-warnings',
              guestPath ?? '', runDir, String(timeoutS),
            ]
      const child = $.process.spawn({
        argv: ['env', '-i', GUEST_PATH, 'timeout', '-k', '2', String(CEILING_S), ...guest],
        input: JSON.stringify({ program, preludes, projectDir }),
      })
      let buffer = ''
      let isOverflow = false
      for await (const piece of child) {
        if (piece.stream === 'stderr') {
          stderr = (stderr + piece.text).slice(-MAX_STDERR)
          continue
        }
        let text = piece.text
        let end: number
        while ((end = text.indexOf('\n')) >= 0) {
          const line = buffer + text.slice(0, end)
          buffer = ''
          text = text.slice(end + 1)
          if (isOverflow) isOverflow = false
          else handle(line)
        }
        if (isOverflow) continue
        buffer += text
        if (buffer.length > MAX_LINE) {
          buffer = ''
          isOverflow = true
          protocolNote = 'codemode: a protocol line passed 16 MB and was dropped.'
        }
      }
      exit = await child.result.catch(() => undefined)
      // Calls still in flight get a short grace, then their results drop.
      if (ledger.some(c => c.state === 'running')) {
        await Promise.race([Promise.allSettled(inflight), $.process.run(['sleep', '2'])])
      }
    } finally {
      isClosed = true
      // An agent the run left running answers no program, so TaskStop ends it.
      const left = [...spawned]
      for (const id of left) waiting.delete(id)
      const stops = await Promise.all(
        left.map(async id => {
          try {
            const r = await $.tool.call({ tool: 'TaskStop', task_id: id } as never)
            if (r.deny !== undefined) return `${id}: ${r.deny}`
            return r.isError === true ? `${id}: ${oneLine(r.text ?? '', 120)}` : undefined
          } catch (err) {
            return `${id}: ${err instanceof Error ? err.message : String(err)}`
          }
        }),
      )
      const unstopped = stops.filter(s => s !== undefined)
      if (left.length) {
        stopNote = unstopped.length
          ? `TaskStop could not stop ${unstopped.length} of ${left.length} agents the run left running: ${unstopped.join('; ')}`
          : `Stopped ${left.length} agent${left.length === 1 ? '' : 's'} the run left running.`
      }
      $.ui.status(undefined)
      await $.process.run(['rm', '-rf', runDir])
    }

    const isFailed = !done?.ok
    await publish(true, !isFailed)
    let head: string
    if (done?.ok) head = done.value ?? ''
    else if (done?.kind === 'parse') head = done.error ?? 'Program did not parse.'
    else if (done?.kind === 'error') head = `Program error: ${done.error}`
    else if (done?.kind === 'timeout') {
      head = `Soft timeout: the program used ${done.programSeconds} s of program time, over its ${timeoutS} s limit, and was stopped. Time spent waiting on tools does not count. Raise timeoutSeconds (max ${MAX_TIMEOUT_S}) or do less per run.`
    } else if (done) head = `Program crashed: ${done.error}`
    else if (isPy && stderr.trimStart().startsWith('bwrap:')) {
      head = `Python sandbox error: bwrap did not start, so the program did not run. Python runs only inside the sandbox.\n${stderr.trim()}`
    } else if (exit?.code === 124 || exit?.code === 137) {
      head = `Hard ceiling: the run passed ${CEILING_S} s of wall time and was killed.`
    } else {
      const how = exit ? `exit code ${exit.code}, signal ${exit.signal}` : 'no exit status'
      head = `Program crashed: the guest stopped without a result (${how}).\n${stderr.trim()}`
    }
    if (done?.note) head += `\n${done.note}`

    const logs = done?.logs?.length ? `console:\n${done.logs.join('\n')}` : ''
    const footer = [ledgerLine(ledger), isFailed ? progressNote(ledger) : '', droppedNote(ledger), stopNote, protocolNote]
      .filter(Boolean)
      .join('\n')
    const full = [head, logs, footer].filter(Boolean).join('\n\n')
    const cap = isFailed ? MAX_FAILED_OUTPUT : MAX_OUTPUT
    const answer = (result: string) => (isFailed ? { result, isError: true as const } : { result })
    if (full.length <= cap && logs.length <= MAX_LOGS) return answer(full)

    // Over budget: keep both ends of the text and save the whole to a file.
    let notice: string
    try {
      const dir = await spillDir($, sessionId)
      await $.process.run(['mkdir', '-p', '-m', '700', dir.slice(0, dir.lastIndexOf('/')), dir])
      const taken = (await $.fs.list(dir)).map(f => Number(/^(\d+)\.txt$/.exec(f.name)?.[1] ?? 0))
      const path = `${dir}/${Math.max(0, ...taken) + 1}.txt`
      await $.fs.write(path, full)
      notice = `[Full output (${full.length} chars) saved to ${path}. Read it with offset/limit.]`
    } catch {
      notice = `[Output cut from ${full.length} chars. The full text could not be saved.]`
    }
    const logsShown = cutMiddle(logs, MAX_LOGS)
    const room = cap - logsShown.length - footer.length - notice.length - 8
    const text = [cutMiddle(head, Math.max(room, 1000)), logsShown, footer, notice].filter(Boolean).join('\n\n')
    return answer(text)
  })

  // The transcript row: one header line, then at most two result lines.
  // A click on the last line opens the program and the full output.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isInterrupted) return next(e)
    const run = (await $.state.get({ ...RUNS, id: e.requestId }).catch(() => undefined))?.value
    const isOpen = (await $.state.get({ ...EXPANDED, id: e.requestId }).catch(() => undefined))?.value === true
    const input = (e.props.input ?? {}) as { program?: unknown; title?: unknown }
    const program = typeof input.program === 'string' ? input.program : ''
    const title = run?.title ?? (typeof input.title === 'string' && input.title ? oneLine(input.title, 60) : headline(program))
    const isBad = e.props.isErrored || (run?.isDone === true && !run.isOk)
    const dot = e.props.isRunning ? 'yellow' : isBad ? 'red' : 'green'
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={dot}>● </Text>
          <Text bold>codemode </Text>
          <Text wrap="truncate">{title}</Text>
          <Text dimColor wrap="truncate"> · {runMeta(run, e.props.isRunning)}</Text>
        </Box>
        {isOpen ? (
          <Box paddingLeft={2}>
            <Text dimColor>{program}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const text = outputText(e.props.output)
    if (text === undefined) return next(e)
    const ref = { ...EXPANDED, id: e.requestId }
    const isOpen = (await $.state.get(ref).catch(() => undefined))?.value === true
    const { body, footer } = splitFooter(text)
    const lines = body.split('\n')
    const { Box, Button, Text } = $.ui.resolve(e)
    const toggle = () => update($, ref, v => !v)
    if (isOpen) {
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Text>{text}</Text>
          <Button key="toggle" plain dimColor label="collapse" onPress={toggle} />
        </Box>
      )
    }
    const first = lines.find(l => l.trim()) ?? '(empty)'
    const rest = lines.filter(l => l.trim()).length - 1
    const ledger = footer.split('\n')[0] ?? ''
    const failed = /failed: (?!none)/.test(ledger) ? ledger.replace(/^.*?; (failed: .*?); denied.*$/, '$1') : ''
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text wrap="truncate">⎿  {first}</Text>
        {rest > 0 || footer ? (
          <Box paddingLeft={3}>
            <Button
              key="toggle"
              plain
              dimColor
              label={`${rest > 0 ? `+${rest} line${rest === 1 ? '' : 's'}` : 'details'}${failed ? ` · ${oneLine(failed, 80)}` : ''} · expand`}
              onPress={toggle}
            />
          </Box>
        ) : null}
      </Box>
    )
  })
}
