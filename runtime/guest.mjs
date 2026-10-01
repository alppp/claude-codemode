// Guest side of codemode. Runs one program under `node --permission`:
// it may read only its run folder, with no writes, network or subprocesses.
// Tool calls go out on stdout as marked JSON lines. The mod answers each
// one with a file r<id>.json in the run folder.
import fs from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const runDir = process.argv[2]
const MARK = '\u001ecm '
const send = msg => process.stdout.write(MARK + JSON.stringify(msg) + '\n')

const logs = []
const show = v => {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
const log = (...args) => logs.push(args.map(show).join(' '))
const guestConsole = { log, info: log, warn: log, error: log, debug: log }
globalThis.console = guestConsole

const finish = msg => {
  send({ type: 'done', logs, ...msg })
  process.exit(0)
}

// Replies. fs.watch is fast. The poll covers a missed or partial write.
const waiting = new Map()
const take = id => {
  let reply
  try {
    reply = JSON.parse(fs.readFileSync(`${runDir}/r${id}.json`, 'utf8'))
  } catch {
    return
  }
  const resolve = waiting.get(id)
  waiting.delete(id)
  resolve?.(reply)
}
fs.watch(runDir, (_, name) => {
  const id = /^r(\d+)\.json$/.exec(name ?? '')?.[1]
  if (id && waiting.has(Number(id))) take(Number(id))
})
setInterval(() => {
  for (const id of [...waiting.keys()]) take(id)
}, 100)

let seq = 0
const call = (tool, input = {}) => {
  const id = ++seq
  return new Promise(resolve => {
    waiting.set(id, resolve)
    send({ type: 'call', id, tool, input })
  })
}

class ToolError extends Error {}
const ok = async (tool, input) => {
  const r = await call(tool, input)
  if (r.deny !== undefined) throw new ToolError(`${tool} denied: ${r.deny}`)
  if (r.isError) throw new ToolError(`${tool} failed: ${r.text}`)
  return r
}

const tools = new Proxy(
  {},
  {
    get: (_, name) =>
      typeof name === 'string' ? async input => (await ok(name, input)).text : undefined,
  },
)
const read = async (path, opts = {}) => {
  const r = await ok('Read', { file_path: path, ...opts })
  return r.result?.file?.content ?? r.text
}
const bash = async (command, opts = {}) => {
  const r = await ok('Bash', { command, ...opts })
  return r.result?.stdout ?? r.text
}
const listTools = async () => (await ok('$list', {})).result

const source = fs.readFileSync(0, 'utf8')
const wrapped = `(async function codemode(tools, call, read, bash, listTools, ToolError, console) {\n${source}\n})`
let program
try {
  program = (0, eval)(stripTypeScriptTypes(wrapped, { mode: 'strip' }))
} catch (err) {
  finish({ ok: false, error: `Program did not parse: ${err.message}` })
}

try {
  const value = await program(tools, call, read, bash, listTools, ToolError, guestConsole)
  const text =
    value === undefined
      ? '(no return value)'
      : typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2)
  finish({ ok: true, value: text })
} catch (err) {
  const where = err?.stack?.split('\n').slice(0, 4).join('\n') ?? String(err)
  finish({ ok: false, error: where })
}
