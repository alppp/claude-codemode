import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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
const DOC_CAP = 1500
// A soft call (sh, ssh) that ends in "Exit code N" is data. Bash's own
// timeout or kill still fails.
const EXIT = /^Exit code (-?\d+)/
const BASH_KILLED = /Command timed out after |Command killed: /
const PRELUDE_FILE = /^(?!.*\.d\.ts$).+\.(js|ts)$/
const DOC_LINE = /^\/\/: (.*?)\r?$/

const STORE_INDEX = { plugin: 'codemode', key: 'keys' } as const
const STORE_VALUES = { plugin: 'codemode', key: 'values' } as const
const DESCRIPTIONS = { plugin: 'codemode', key: 'descriptions' } as const
const RUNS = { plugin: 'codemode', key: 'runs' } as const
const EXPANDED = { plugin: 'codemode', key: 'expanded' } as const

const DESCRIPTION = `Run a JavaScript or TypeScript program that calls Claude Code tools. Only its return value and console lines come back to you.

Use it for 3 or more calls, fan-out over many files or commands, or big outputs you filter in code. For one small call, call the tool directly. For an investigation, put every independent probe in the first exec. sh() and ssh() return a non-zero exit as data, so one empty grep does not stop the batch. Exec waits for every inner call, and your turn blocks until then. Run builds, deploys, big syncs and anything over about a minute with the Bash tool and run_in_background, several at once when they are independent.

The program is the body of an async function: use await and return. A string comes back as is, other values as JSON. Long multi-line strings come back as raw sections. TypeScript types are stripped, not checked; enum and namespace fail. The program has no file system, network or process access. All I/O goes through tools, under the normal permissions and hooks.

Globals:
- tools.Name(input): the tool's text. Throws ToolError on failure or deny.
- call(name, input): { text, result, isError, deny }. Never throws.
- read(path, { offset, limit }?): the file content, no line numbers. A file too big for one Read is read in pages, up to about 48k tokens. A cut read ends with a "[codemode: read stopped at line N ...]" line.
- bash(command, opts?): stdout. A non-zero exit throws ToolError.
- sh(command, opts?) or sh\`cmd \${x}\`: { ok, code, out }. A non-zero exit is data. A deny or a Bash timeout throws ToolError. In the template form, each \${x} becomes one single-quoted word, and an array becomes one word per item. opts go to Bash (timeout in ms, description). sh(opts)\`cmd\` also works.
- ssh(host, script, opts?) or ssh(host)\`cmd \${x}\`: { ok, code, out, host, timedOut }. The script runs in bash on the host. It goes over stdin, so it needs no extra quoting. A command in it that reads stdin eats the rest of the script: give that command </dev/null. opts.timeout is in seconds, default 90. Exit 255 is an ssh failure.
- q(...words): the words in POSIX single quotes, joined by spaces. Arrays flatten.
- listTools(filter?): [{ name, summary }]. The filter is a substring or a RegExp.
- describe(name): the tool's full description.
- store.get(key), store.set(key, value), store.delete(key), store.keys(): JSON values kept across exec calls in this session (256 keys, 1 MB each). Only exec sees them. Bash does not.
- helpers(): the doc lines of the prelude files that loaded.
- projectDir: the nearest dir at or above the launch dir that holds .codemode, else the launch dir.
- console.log(...): lines after the result.
- ToolError: an Error with .tool and .text.

Result shapes: Read gives result.file.content. Bash gives result.stdout, with stderr merged in. A failed Bash call has isError true, text "Exit code N" and then the output, and no structured result. Bash keeps the first 30000 chars of output. When it cuts more, sh() and ssh() also give saved, the path of the full output. A non-zero exit keeps 10000 of those chars, the head and the tail. With run_in_background, Bash returns the task id at once. The completion notice comes to you, not to the program.

Prelude: each exec first runs ~/.claude/codemode/prelude/*.{js,ts}, then <projectDir>/.codemode/prelude/*.{js,ts}. Their top-level declarations are globals in the program. A prelude that throws is skipped, and the result says so.

timeoutSeconds (default 120, max 600) counts program time only. Time spent waiting on tools and permission dialogs does not count. Up to 8 calls run at once, and 300 per run. The result ends with a ledger of the calls.

Example:
const [hits, disk, head] = await Promise.all([
  sh\`rg -n -i \${"needle"} src\`,
  ssh("buildhost", "df -h /; uptime"),
  sh("git log -1 --format=%s"),
])
return { hits: hits.ok ? hits.out : \`no hits (exit \${hits.code})\`, disk: disk.out, head: head.out.trim() }`

// quiet: a read() page. When it fails on Read's size or token cap, read() pages
// around it, so it leaves no ledger entry. soft: an sh() or ssh() call.
// label: the ledger argument in place of the command head.
type Call = {
  type: 'call'
  id: number
  tool: string
  input: Record<string, unknown>
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
// exit: a soft call's non-zero exit code. Its state is ok.
type Entry = { tool: string; arg: string; state: 'running' | 'ok' | 'failed' | 'denied'; note?: string; exit?: number }
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

const unknownTool = (name: string, names: string[]) => {
  const want = name.toLowerCase()
  const close = names
    .map(n => ({ n, d: distance(want, n.toLowerCase()) }))
    .filter(x => x.d <= Math.max(2, Math.ceil(want.length / 2)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(x => x.n)
  const hint = close.length ? ` Close names: ${close.join(', ')}.` : ''
  return `No tool named "${name}" in this session.${hint} listTools() lists them all.`
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
  return `calls: ${ledger.length} (${tally(ledger)})${exits}; failed: ${group('failed')}; denied: ${group('denied')}`
}

// The exit code of a soft call that ended in a plain non-zero exit.
const softExit = (text: string) => {
  const code = Number(EXIT.exec(text)?.[1])
  if (!Number.isInteger(code)) return undefined
  return (code === 143 || code === 137) && BASH_KILLED.test(text) ? undefined : code
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

// The .js and .ts files of one prelude dir, sorted by name.
const preludeDir = async ($: Host, dir: string): Promise<Prelude[]> => {
  const entries = await $.fs.list(dir).catch(() => [])
  const names = entries
    .filter(f => (f.kind === 'file' || f.isLink) && PRELUDE_FILE.test(f.name))
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
const loadPreludes = async ($: Host, fallbackRoot?: string) => {
  const home = await $.env.get('HOME')
  const root = (await $.session.root().catch(() => undefined)) ?? fallbackRoot
  const projectDir = root === undefined ? null : await findProject($, root, home)
  const preludes = [
    ...(home ? await preludeDir($, `${home}/.claude/codemode/prelude`) : []),
    ...(projectDir ? await preludeDir($, `${projectDir}/.codemode/prelude`) : []),
  ]
  return { projectDir, preludes }
}

// The description's helper block: the "//: " doc lines of the prelude files
// at session start, cut near DOC_CAP chars.
const helperDocs = (preludes: Prelude[]) => {
  const files = preludes
    .map(p => ({ path: p.path, lines: (p.source ?? '').split('\n').flatMap(l => DOC_LINE.exec(l)?.[1] ?? []) }))
    .filter(f => f.lines.length)
  if (!files.length) return ''
  let text = `Helpers (from ${files.map(f => f.path).join(', ')}). This list is from session start. Later edits to these files reach helpers() and the runtime, not this text.`
  for (const line of files.flatMap(f => f.lines)) {
    if (text.length + line.length + 3 > DOC_CAP) {
      text += '\n- ... helpers() lists the rest.'
      break
    }
    text += `\n- ${line}`
  }
  return text
}

export const register: Register = on => {
  let nodePath: string | undefined
  let guestPath: string | undefined
  // The descriptions already saved to state, so a repeat describe writes nothing.
  const seen = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const { preludes } = await loadPreludes($, e.cwd).catch(() => ({ preludes: [] }))
    const docs = helperDocs(preludes)
    await $.tool.register({
      name: 'exec',
      description: docs ? `${DESCRIPTION}\n\n${docs}` : DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          program: { type: 'string', description: 'Body of an async function. Use await and return.' },
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
  // that exec stays out of ToolSearch.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    if (seen.get(e.tool) !== described.description) {
      seen.set(e.tool, described.description)
      await $.state.set({ ...DESCRIPTIONS, id: e.tool }, described.description).catch(() => undefined)
    }
    return e.tool === TOOL ? { description: described.description, isDeferred: false } : described
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

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const program = typeof e.program === 'string' ? e.program : ''
    if (!program.trim()) return { result: 'Error: the program is empty.', isError: true as const }
    const timeoutS = Math.min(Math.max(Number(e.timeoutSeconds) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S)
    const title = typeof e.title === 'string' ? oneLine(e.title, 60) : ''
    const sessionId = await $.session.id()
    const runRef = { ...RUNS, id: e.tool_use_id }
    const startedAt = await $.clock.now()

    nodePath ??= (await $.process.run(['sh', '-c', 'command -v node'])).stdout.trim() || 'node'
    if (guestPath === undefined) {
      const guest = `${$.plugin.root}/runtime/guest.mjs`
      guestPath = (await $.fs.stat(guest, { resolve: true })).realPath ?? guest
    }
    const runDir = (await $.process.run(['mktemp', '-d', '-t', 'codemode.XXXXXX'])).stdout.trim()
    const { projectDir, preludes } = await loadPreludes($).catch(() => ({ projectDir: null, preludes: [] }))

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

    const callTool = async (
      tool: string,
      input: Record<string, unknown>,
      { quiet = false, soft = false, label }: Pick<Call, 'quiet' | 'soft' | 'label'> = {},
    ): Promise<Reply> => {
      if (tool === TOOL) return { deny: 'codemode cannot call itself.' }
      const arg = typeof label === 'string' && label.trim() ? oneLine(label, 60) : brief(input)
      const entry: Entry = { tool, arg, state: 'running' }
      ledger.push(entry)
      showStatus()
      if (ledger.length > MAX_CALLS) {
        entry.state = 'denied'
        entry.note = 'call budget reached'
        return { deny: `codemode allows ${MAX_CALLS} tool calls per exec. Split the work.` }
      }
      await acquire()
      try {
        const r = await $.tool.call({ ...input, tool } as never)
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
        const names = (await toolList().catch(() => [])).map(t => t.name)
        const isKnown = names.includes(tool)
        const text = isKnown ? (err instanceof Error ? err.message : String(err)) : unknownTool(tool, names)
        entry.note = isKnown ? text : 'no such tool'
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
        return { isError: true, text: unknownTool(String(input.name), list.map(t => t.name)) }
      }
      if (tool === '$store') return storeOp(input)
      return { isError: true, text: `Unknown codemode request ${tool}.` }
    }

    const serve = async ({ id, tool, input, quiet, soft, label }: Call) => {
      let reply: Reply
      try {
        reply = tool.startsWith('$')
          ? await serveOwn(tool, input ?? {})
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
      const child = $.process.spawn({
        argv: [
          'env', '-i', GUEST_PATH,
          'timeout', '-k', '2', String(CEILING_S),
          nodePath, '--permission', `--allow-fs-read=${runDir}`, `--allow-fs-read=${guestPath}`,
          '--allow-worker', '--preserve-symlinks-main', '--no-warnings',
          guestPath, runDir, String(timeoutS),
        ],
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
    else if (exit?.code === 124 || exit?.code === 137) {
      head = `Hard ceiling: the run passed ${CEILING_S} s of wall time and was killed.`
    } else {
      const how = exit ? `exit code ${exit.code}, signal ${exit.signal}` : 'no exit status'
      head = `Program crashed: the guest stopped without a result (${how}).\n${stderr.trim()}`
    }
    if (done?.note) head += `\n${done.note}`

    const logs = done?.logs?.length ? `console:\n${done.logs.join('\n')}` : ''
    const footer = [ledgerLine(ledger), isFailed ? progressNote(ledger) : '', droppedNote(ledger), protocolNote]
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
