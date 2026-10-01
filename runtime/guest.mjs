// Guest side of codemode. Node runs it under --permission: it may read only
// its run folder and this file, with no writes, network or subprocesses.
// The main thread speaks the protocol. Tool calls go out on stdout as marked
// JSON lines, and the mod answers each one with a file r<id>.json in the run
// folder. The program runs in a worker, inside a vm context that holds only
// the codemode globals. The main thread stops the worker at the soft timeout.
import fs from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const MARK = '\u001ecm '
const MAX_VALUE = 2_000_000
const MAX_LOGS = 1_000_000

function runMain() {
  const runDir = process.argv[2]
  const softMs = Number(process.argv[3]) * 1000
  const send = msg => process.stdout.write(MARK + JSON.stringify(msg) + '\n')

  // Program time runs only while no tool call waits for its reply.
  const pending = new Set()
  let usedMs = 0
  let idleSince = performance.now()
  const programMs = () => usedMs + (pending.size === 0 ? performance.now() - idleSince : 0)

  const logs = []
  let logChars = 0
  let droppedLogs = 0
  let finished = false
  const finish = msg => {
    if (finished) return
    finished = true
    if (droppedLogs) logs.push(`[${droppedLogs} more log lines dropped]`)
    const programSeconds = Math.round(programMs() / 100) / 10
    send({ type: 'done', ...msg, logs, programSeconds })
    process.exit(0)
  }

  const worker = new Worker(new URL(import.meta.url), {
    workerData: { source: fs.readFileSync(0, 'utf8') },
  })
  worker.on('message', msg => {
    if (msg.type === 'call') {
      if (pending.size === 0) usedMs += performance.now() - idleSince
      pending.add(msg.id)
      send(msg)
    } else if (msg.type === 'log') {
      if (logChars + msg.line.length > MAX_LOGS) droppedLogs += 1
      else {
        logs.push(msg.line)
        logChars += msg.line.length + 1
      }
    } else if (msg.type === 'done') finish(msg)
  })
  worker.on('error', err =>
    finish({ ok: false, kind: 'crash', error: `${err?.name ?? 'Error'}: ${err?.message ?? err}` }),
  )
  worker.on('exit', code =>
    finish({ ok: false, kind: 'crash', error: `The program's worker stopped with exit code ${code}.` }),
  )

  // Replies. fs.watch is fast. The poll covers a missed or partial write.
  const take = id => {
    let text
    try {
      text = fs.readFileSync(`${runDir}/r${id}.json`, 'utf8')
      JSON.parse(text)
    } catch {
      return
    }
    if (!pending.delete(id)) return
    if (pending.size === 0) idleSince = performance.now()
    worker.postMessage({ id, text })
  }
  fs.watch(runDir, (_, name) => {
    const id = /^r(\d+)\.json$/.exec(name ?? '')?.[1]
    if (id && pending.has(Number(id))) take(Number(id))
  })
  setInterval(() => {
    for (const id of [...pending]) take(id)
    if (programMs() >= softMs) {
      void worker.terminate()
      finish({ ok: false, kind: 'timeout' })
    }
  }, 100)
}

function runProgram(source) {
  const post = msg => parentPort.postMessage(msg)
  let ended = false
  const end = msg => {
    if (ended) return
    ended = true
    post({ type: 'done', ...msg })
  }

  const log = (...args) =>
    post({ type: 'log', line: args.map(v => (typeof v === 'string' ? v : show(v))).join(' ') })
  const guestConsole = { log, info: log, warn: log, error: log, debug: log, dir: log, table: log }

  // Replies and ToolError belong to the program's own realm, so that
  // instanceof Error, Array and Object work in the program.
  const context = vm.createContext({})
  const fromJson = vm.runInContext('JSON.parse', context)
  const ToolError = vm.runInContext(
    `(class ToolError extends Error {
      constructor(message, info = {}) {
        super(message.length > 4000 ? message.slice(0, 4000) + '...' : message)
        this.name = 'ToolError'
        Object.assign(this, info)
      }
    })`,
    context,
  )

  const waiting = new Map()
  parentPort.on('message', ({ id, text }) => {
    const resolve = waiting.get(id)
    waiting.delete(id)
    resolve?.(fromJson(text))
  })

  let seq = 0
  const call = (tool, input = {}) => {
    let clean
    try {
      clean = JSON.parse(JSON.stringify(input ?? {}))
    } catch (err) {
      return Promise.resolve({ isError: true, text: `The input of ${tool} is not JSON: ${err.message}` })
    }
    if (typeof tool !== 'string') {
      return Promise.resolve({ isError: true, text: 'call(name, input) takes a tool name first.' })
    }
    if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) {
      return Promise.resolve({ isError: true, text: `The input of ${tool} must be an object of its parameters.` })
    }
    const id = ++seq
    return new Promise(resolve => {
      waiting.set(id, resolve)
      post({ type: 'call', id, tool, input: clean })
    })
  }

  const ok = async (tool, input) => {
    const r = await call(tool, input)
    const own = tool.startsWith('$')
    if (r.deny !== undefined) throw new ToolError(`${tool} denied: ${r.deny}`, { tool, deny: r.deny })
    if (r.isError) {
      throw new ToolError(own ? r.text : `${tool} failed: ${r.text}`, { tool, text: r.text, result: r.result })
    }
    return r
  }

  const tools = new Proxy(
    {},
    {
      get: (_, name) =>
        typeof name === 'string' && name !== 'then'
          ? async input => (await ok(name, input)).text
          : undefined,
    },
  )
  const read = async (path, opts = {}) => {
    const r = await ok('Read', { file_path: path, ...opts })
    return r.result?.file?.content ?? r.text
  }
  const bash = async (command, opts = {}) => {
    const r = await ok('Bash', { command, ...opts })
    if (r.result?.backgroundTaskId) return r.text
    return r.result?.stdout ?? r.text
  }
  const listTools = async filter => {
    const all = (await ok('$list', {})).result
    if (filter === undefined) return all
    if (typeof filter?.test === 'function') {
      return all.filter(t => {
        filter.lastIndex = 0
        if (filter.test(t.name)) return true
        filter.lastIndex = 0
        return filter.test(t.summary)
      })
    }
    const needle = String(filter).toLowerCase()
    return all.filter(t => `${t.name} ${t.summary}`.toLowerCase().includes(needle))
  }
  const describe = async name => (await ok('$describe', { name })).text
  const store = {
    get: async key => {
      const r = (await ok('$store', { op: 'get', key })).result
      return r.found ? r.value : undefined
    },
    set: async (key, value) => {
      const json = JSON.stringify(value)
      if (json === undefined) throw new ToolError('store.set needs a JSON value.', { tool: '$store' })
      if (json.length > 1_000_000) {
        throw new ToolError(`store.set: the value is ${json.length} chars of JSON; the cap is 1,000,000.`, {
          tool: '$store',
        })
      }
      await ok('$store', { op: 'set', key, value })
    },
    delete: async key => (await ok('$store', { op: 'delete', key })).result,
    keys: async () => (await ok('$store', { op: 'keys' })).result,
  }

  let isLastHit = false
  Object.assign(context, {
    tools, call, read, bash, listTools, describe, store, console: guestConsole, ToolError,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone,
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
    [LAST]: v => ((isLastHit = true), v),
  })

  let prepared
  try {
    prepared = prepare(source)
  } catch (err) {
    end({ ok: false, kind: 'parse', error: err.message })
    return
  }
  const fail = (lead, err) => end({ ok: false, kind: 'error', error: lead + describeError(err, prepared) })
  process.on('unhandledRejection', err => fail('Unhandled promise rejection: ', err))
  process.on('uncaughtException', err => fail('Uncaught exception: ', err))

  void (async () => {
    try {
      const program = prepared.script.runInContext(context)
      let value = await program()
      const isCalled = prepared.splice?.isWhole === true && typeof value === 'function'
      if (isCalled) value = await value()
      const note = isLastHit && !isCalled ? '(returned last expression)' : undefined
      end({ ok: true, value: format(value), note })
    } catch (err) {
      fail('', err)
    }
  })()
}

// Source normalization and compile.

const HEAD = '(async function codemode() {\n'
const TAIL = '\n})'
const LAST = '__codemode_last__'
const PREFIX = `return ${LAST}(`
const wrap = body => HEAD + body + TAIL
const FENCE = /^\s*```[^\n]*\n([\s\S]*?)\n?[ \t]*```\s*$/d
// A first token that can continue the line before it, so the line is not a
// statement of its own.
const CONTINUES = /^\s*(?:[([`+\-*/%.,?:=<>&|^]|!=|in\b|instanceof\b)/

const compiles = code => {
  try {
    new vm.Script(code)
    return true
  } catch {
    return false
  }
}

function prepare(source) {
  let text = source
  let fenceLines = 0
  const fence = FENCE.exec(source)
  if (fence) {
    text = fence[1]
    fenceLines = source.slice(0, fence.indices[1][0]).split('\n').length - 1
  }
  const at = { source, fenceLines, lineCount: text.split('\n').length }
  let body
  try {
    const stripped = stripTypeScriptTypes(wrap(text), { mode: 'strip' })
    body = stripped.slice(HEAD.length, stripped.length - TAIL.length)
  } catch (err) {
    throw new Error(parseError(err, at, 'strip'))
  }
  const options = { filename: 'program', lineOffset: fenceLines - 1 }
  try {
    new vm.Script(wrap(body), options)
  } catch (err) {
    throw new Error(parseError(err, at, 'v8'))
  }
  const splice = spliceLast(body)
  if (splice) splice.line += fenceLines
  return { ...at, splice, script: new vm.Script(wrap(splice?.body ?? body), options) }
}

// Puts `return` before a last expression statement. It splices only when
// the expression stands alone, the code before it parses on its own, and
// the result still parses.
function spliceLast(body) {
  const lines = body.split('\n')
  for (let k = 1; k <= Math.min(lines.length, 40); k++) {
    const at = lines.length - k
    const tail = lines.slice(at).join('\n')
    if (!tail.trim()) continue
    const head = lines.slice(0, at).join('\n')
    const isWhole = !head.trim()
    if (!isWhole && CONTINUES.test(tail)) continue
    if (!compiles(`(async () => (\n${tail}\n))`)) continue
    if (!isWhole && !compiles(wrap(head))) continue
    const first = lines[at]
    const indent = first.length - first.trimStart().length
    const out = [...lines]
    out[at] = first.slice(0, indent) + PREFIX + first.slice(indent)
    out.push(')')
    const spliced = out.join('\n')
    if (!compiles(wrap(spliced))) return undefined
    return { body: spliced, line: at + 1, indent, isWhole }
  }
  return undefined
}

// Errors.

const GLOBALS =
  'In scope: tools, call, read, bash, listTools, describe, store, console, ToolError, setTimeout, and the standard JavaScript built-ins.'
const NODE_HINT = 'There are no Node APIs here. Do I/O through tools: read(), bash(), tools.Name().'
const NODE_NAMES = /^(require|process|Buffer|fetch|module|exports|__dirname|__filename|global)\b/

function codeFrame(at, line, column) {
  const lines = at.source.split('\n')
  const shown = []
  const width = String(line).length
  for (let n = Math.max(1, line - 1); n <= Math.min(lines.length, line); n++) {
    shown.push(`${n === line ? '>' : ' '} ${String(n).padStart(width)} | ${lines[n - 1]}`)
  }
  if (column) shown.push(`  ${' '.repeat(width)} | ${' '.repeat(column - 1)}^`)
  return shown.join('\n')
}

function parseError(err, at, from) {
  const stack = String(err?.stack ?? '')
  const message = String(err?.message ?? err)
  let line
  let column
  if (from === 'strip') {
    const head = /^:(\d+)\n/.exec(stack)
    if (head) line = Number(head[1]) - 1 + at.fenceLines
    const frame = stack.split('\n').slice(1, 6)
    const stop = frame.indexOf('')
    const caret = frame.slice(0, stop < 0 ? frame.length : stop).find(l => /^\s*\^+\s*$/.test(l))
    if (caret) column = caret.indexOf('^') + 1
  } else {
    const head = /^program:(\d+)\n[^\n]*\n([^\n]*)/.exec(stack)
    if (head) {
      line = Number(head[1])
      if (head[2].includes('^')) column = head[2].indexOf('^') + 1
    }
  }
  const last = at.lineCount + at.fenceLines
  let where = ''
  if (line !== undefined) {
    if (line > last) {
      line = last
      column = undefined
      where = ' (at the end of the program)'
    }
    line = Math.max(line, 1)
  }
  const out = [
    line === undefined
      ? `Program did not parse: ${message}`
      : `Program did not parse. Line ${line}${column ? `:${column}` : ''}: ${message}${where}`,
  ]
  if (line !== undefined) out.push(codeFrame(at, line, column))
  if (/enum|namespace|strip-only/.test(message)) {
    out.push('TypeScript is strip-only: type annotations work; enum and namespace do not. Use a plain object.')
  }
  if (/import/.test(message)) out.push(NODE_HINT)
  return out.join('\n')
}

const FRAME = /^\s*at (?:async )?(?:(.*?) \()?program:(\d+):(\d+)\)?$/

function describeError(err, at) {
  const isErrorLike = err !== null && typeof err === 'object' && typeof err.message === 'string'
  if (!isErrorLike) return `thrown value ${show(err)}`
  const name = typeof err.name === 'string' ? err.name : 'Error'
  const out = [`${name}: ${err.message}`]
  for (const frame of String(err.stack ?? '').split('\n')) {
    const m = FRAME.exec(frame)
    if (!m) continue
    const line = Number(m[2])
    let column = Number(m[3])
    if (at.splice && line === at.splice.line && column > at.splice.indent) {
      column = Math.max(column - PREFIX.length, at.splice.indent + 1)
    }
    const fn = m[1] && m[1] !== 'codemode' ? `${m[1]} ` : ''
    out.push(`  at ${fn}line ${line}:${column}`)
    if (out.length > 6) break
  }
  const missing = name === 'ReferenceError' ? /^(\S+) is not defined/.exec(err.message)?.[1] : undefined
  if (missing !== undefined) {
    if (NODE_NAMES.test(missing)) out.push(NODE_HINT)
    out.push(GLOBALS)
  } else if (/dynamic import|import statement|ERR_ACCESS_DENIED|ERR_VM_DYNAMIC_IMPORT/.test(`${err.code} ${err.message}`)) {
    out.push(NODE_HINT)
  }
  return out.join('\n')
}

function show(v) {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// Result formatting. Multi-line strings longer than 80 chars leave the
// skeleton and follow it as raw sections, so the model can copy exact text.

const KEY = /^[A-Za-z_$][\w$]*$/

function plain(value, path, sections, seen) {
  if (typeof value === 'string') {
    if (path && value.length > 80 && value.includes('\n')) {
      sections.push({ path, text: value })
      return `<see section ${path}>`
    }
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  const kind = Object.prototype.toString.call(value)
  if (kind === '[object Error]') return { name: value.name, message: value.message }
  if (typeof value.toJSON === 'function') return plain(value.toJSON(), path, sections, seen)
  seen.add(value)
  let out
  if (Array.isArray(value) || kind === '[object Set]') {
    out = [...value].map((item, i) => plain(item, `${path}[${i}]`, sections, seen) ?? null)
  } else {
    const entries = kind === '[object Map]' ? [...value] : Object.entries(value)
    out = {}
    for (const [k, item] of entries) {
      const key = String(k)
      const sub = KEY.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`
      const v = plain(item, sub, sections, seen)
      if (v !== undefined) out[key] = v
    }
  }
  seen.delete(value)
  return out
}

function format(value) {
  let text
  if (value === undefined) return '(no return value; add return)'
  if (typeof value === 'string') text = value
  else {
    const sections = []
    const skeleton = plain(value, '', sections, new Set())
    const pretty = JSON.stringify(skeleton, null, 2)
    if (pretty === undefined) return '(no return value; add return)'
    text = pretty.length > 2048 ? JSON.stringify(skeleton) : pretty
    for (const s of sections) text += `\n\n--- ${s.path} (${s.text.length} chars) ---\n${s.text}`
  }
  if (text.length > MAX_VALUE) {
    text = `${text.slice(0, MAX_VALUE)}\n[codemode: the value was cut at ${MAX_VALUE} of ${text.length} chars]`
  }
  return text
}

if (isMainThread) runMain()
else runProgram(workerData.source)
