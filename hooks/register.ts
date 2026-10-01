import type { Register } from 'claude-code'

const TOOL = 'mcp__codemode__exec'
const MARK = '\u001ecm '
const MAX_OUTPUT = 80_000
const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600

const DESCRIPTION = `Run one JavaScript or TypeScript program that calls Claude Code tools. Only the value it returns comes back to you.

Use it to batch work: many reads, greps, globs or shell commands, loops over their results, filtering and aggregation. Intermediate tool output stays inside the program.

The program is the body of an async function: use await and return. TypeScript types are stripped and not checked.

In scope:
- tools.<Name>(input): calls a tool with its normal input. Resolves to the text you would read. Throws ToolError when the tool fails or permission is denied.
- call(name, input): the same call, never throws. Resolves { text, result, isError, deny }; result is the tool's structured record.
- read(path, opts?): file content without line numbers (Read limits apply; pass { offset, limit }).
- bash(command, opts?): stdout of a Bash call. A non-zero exit throws; use call("Bash", ...) when the exit code matters.
- listTools(): the names of the tools you can call.
- console.log(...): lines added after the result.

Every call goes through the normal permission rules and hooks. Run independent calls together with Promise.all. The program has no file system, network or process access of its own: all I/O goes through tools. A string return comes back as is; any other value comes back as JSON. Return compact data.

Example:
const files = (await tools.Glob({ pattern: "**/*.ts", path: "src" })).split("\\n").filter(Boolean)
const sizes = await Promise.all(files.map(async f => ({ f, lines: (await read(f)).split("\\n").length })))
return sizes.sort((a, b) => b.lines - a.lines).slice(0, 10)`

type Call = { type: 'call'; id: number; tool: string; input: Record<string, unknown> }
type Done = { type: 'done'; ok: boolean; value?: string; error?: string; logs: string[] }
type Reply = { text?: string; result?: unknown; isError?: boolean; deny?: string }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'exec',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          program: { type: 'string', description: 'Body of an async function. Use await and return.' },
          timeoutSeconds: {
            type: 'number',
            description: `Kill the program after this many seconds. Default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.`,
          },
        },
        required: ['program'],
      },
    })
    return started
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const program = typeof e.program === 'string' ? e.program : ''
    const timeoutS = Math.min(
      Math.max(Number(e.timeoutSeconds) || DEFAULT_TIMEOUT_S, 1),
      MAX_TIMEOUT_S,
    )
    const made = await $.process.run(['mktemp', '-d', '-t', 'codemode.XXXXXX'])
    const runDir = made.stdout.trim()
    const guest = `${$.plugin.root}/runtime/guest.mjs`

    let calls = 0
    const serve = async ({ id, tool, input }: Call) => {
      calls += 1
      $.ui.status(`codemode: ${calls} tool calls`)
      let reply: Reply
      try {
        if (tool === '$list') {
          reply = { result: (await $.tool.list()).map(t => t.name) }
        } else if (tool === TOOL) {
          reply = { deny: 'codemode cannot call itself.' }
        } else {
          const r = await $.tool.call({ ...input, tool } as never)
          reply =
            r.deny !== undefined
              ? { deny: r.deny }
              : { text: r.text ?? '', result: r.result, isError: r.isError === true }
        }
      } catch (err) {
        reply = { isError: true, text: err instanceof Error ? err.message : String(err) }
      }
      let json: string
      try {
        json = JSON.stringify(reply)
      } catch {
        json = JSON.stringify({ ...reply, result: undefined })
      }
      await $.fs.write(`${runDir}/r${id}.json`, json)
    }

    let done: Done | undefined
    let stderr = ''
    const inflight: Promise<void>[] = []
    try {
      const child = $.process.spawn({
        argv: [
          'timeout', '-k', '2', String(timeoutS),
          'node', '--permission', `--allow-fs-read=${runDir}`, `--allow-fs-read=${guest}`,
          '--no-warnings', guest, runDir,
        ],
        input: program,
      })
      let buffer = ''
      for await (const piece of child) {
        if (piece.stream === 'stderr') {
          stderr += piece.text
          continue
        }
        buffer += piece.text
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          if (!line.startsWith(MARK)) continue
          const msg = JSON.parse(line.slice(MARK.length)) as Call | Done
          if (msg.type === 'call') inflight.push(serve(msg))
          else done = msg
        }
      }
      await Promise.allSettled(inflight)
    } finally {
      $.ui.status(undefined)
      await $.process.run(['rm', '-rf', runDir])
    }

    const parts: string[] = []
    if (done?.ok) parts.push(done.value ?? '')
    else if (done) parts.push(`Error: ${done.error}`)
    else parts.push(`Error: the program stopped without a result (timeout ${timeoutS}s?).\n${stderr.slice(-4000)}`)
    if (done?.logs.length) parts.push(`console:\n${done.logs.join('\n')}`)
    let text = parts.join('\n\n')
    if (text.length > MAX_OUTPUT) {
      text = `${text.slice(0, MAX_OUTPUT)}\n[codemode: output cut at ${MAX_OUTPUT} of ${text.length} chars. Return less.]`
    }
    return { result: text, isError: !done?.ok }
  })
}
