# codemode

A Claude Code mod that adds one tool, `mcp__codemode__exec`. The model writes a short program (JavaScript, TypeScript or Python). The program calls Claude Code tools: Bash, Read, Grep, agents and so on. Only the return value, the printed lines and a call ledger go back into context.

One exec can hold ten greps, three ssh checks and a file read. Without it, each of those is a separate round trip, and its full output lands in context.

## Read this first

I built this for my own use. It is shared as is, with no support promise.

The defaults follow my workflow. I do a lot of read-only probing over ssh, rg and big logs, and I want all of it batched. If your workflow is different, change the mod. Fork it and edit the tool description, the limits and the nudge to fit how you work. See [Adjust it to your workflow](#adjust-it-to-your-workflow).

## Requirements

| What | Version | Why |
|-|-|-|
| Claude Code | 2.1.287 or newer (tested on 2.1.296) | Mods (function-hook plugins) arrived in 2.1.287. |
| Linux | any recent distro | The host side uses `env -i`, GNU `timeout`, `mktemp` and `sh`. macOS and Windows are untested. |
| Node.js | 22.13 or newer on `PATH` (tested on 26.10) | The JS guest uses `--permission` and `node:module` `stripTypeScriptTypes`. |
| bubblewrap (`bwrap`) | Python mode only (tested on 0.13) | The Python guest runs only inside bwrap. Without it, Python mode refuses to run. |
| python3 under `/usr` | Python mode only (tested on 3.14) | The sandbox binds `/usr` alone, so a python3 from pyenv, conda or `/opt` will not work. |
| `ssh` | only if you call `ssh()` | It runs `ssh -o BatchMode=yes`, so key auth must work without a prompt. A `ControlMaster` setup makes repeated calls much faster. |

The mod needs no npm install and has no dependencies.

## Install

1. Clone the repo anywhere. I keep it in `~/.claude/mods/codemode`.

   ```sh
   git clone https://github.com/alppp/claude-codemode ~/.claude/mods/codemode
   ```

2. Load it in every session, and allow the tool. Add this to `~/.claude/settings.json`:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/codemode",
       "CODEMODE_LANG": "python"
     },
     "permissions": {
       "allow": ["mcp__codemode__exec"]
     }
   }
   ```

   Merge it with your existing settings. For one session only, use `claude --plugin-dir ~/.claude/mods/codemode`.

   The allow rule covers the exec call itself. Each tool call inside the program still goes through your normal permission rules and auto mode.

3. Tell the model to use it. The tool description alone is not enough. Models fall back to plain Bash and Grep calls unless your global `~/.claude/CLAUDE.md` says otherwise. These are the lines I use:

   ```markdown
   ## Shell & environment
   - Work in code mode. Every read-only probe (rg, ssh, sed, cat, reads of files you will not edit) goes through `mcp__codemode__exec`, even a single one when another may follow. Before the first probe, list what you need to know and fetch the independent parts in one exec. Plain Bash is for writes and long jobs: builds, deploys, big syncs and anything over about a minute go to Bash with `run_in_background`, several at once when independent. Send independent tool calls together in one message.
   ```

   Edits stay outside exec on purpose. The model needs the Read tool output before Edit, and Edit diffs show in the transcript.

4. Check it. Start a fresh session (a hot reload does not run the session start hook) and ask:

   ```sh
   claude -p 'Use mcp__codemode__exec to return the output of uname -a. Then quote the last line of its description.' --permission-mode auto
   ```

## Settings

All are environment variables. Set them in `settings.json` `env` or at launch.

| Variable | Default | Effect |
|-|-|-|
| `CODEMODE_LANG` | `js` | `python` or `py` makes every exec Python for the session. It is read at session start. `CODEMODE_LANG=js claude` overrides it for one launch. |
| `CODEMODE_NUDGE` | on | `0` turns off the reminder that appears when the model makes 2 direct read-only Bash, Grep or Glob calls in a row. |

I use Python, because Opus and Sonnet preferred it in my sessions. Python mode needs bwrap. Drop `CODEMODE_LANG` from the settings above if you do not have it.

## What the program can call

The tool description holds the full API. The model sees it, and so can you in `hooks/register.tsx` (`DESCRIPTION` and `DESCRIPTION_PY`). In short:

- `sh(cmd)`: runs Bash. Returns `{ok, code, out}`. A non-zero exit is data, so one empty grep does not stop the batch.
- `ssh(host, script)`: runs the script on the remote host's bash through stdin.
- `read(path)`: reads a file. Big files are paged up to about 48k tokens.
- `tools.Name(...)` and `call(name, ...)`: any tool in the session, MCP tools too.
- `agent(prompt, ...)`: starts a subagent and returns its final answer. Use `Promise.all` or `asyncio.gather` to fan out.
- `store`: JSON values kept across execs in one session.
- `q(...)`: POSIX shell quoting.

Limits: 8 calls run at once, 300 per run. `timeoutSeconds` defaults to 120 and stops at 600. It counts program time only, not time spent waiting on tools.

The mod also repairs near-miss tool names and input keys (`read` to `Read`, `path` to `file_path`) and lists each repair in the ledger.

## Preludes: your own helpers

Each exec first runs the prelude files. Their top-level names become globals in the program.

- Global: `~/.claude/codemode/prelude/`
- Per project: `<project>/.codemode/prelude/`. The project is the launch dir, or the nearest dir above it that has a `.codemode` folder.

JS sessions load `*.js` and `*.ts`. Python sessions load `*.py`. If you use both languages, write each helper twice.

Doc lines start with `//: ` (JS) or `#: ` (Python). Their signatures go into the tool description at session start, so the model knows the helpers exist. Keep the list short: the whole description must stay under 4096 characters. Over that, Claude Code drops the tool from new sessions with no clear error.

Example, `~/.claude/codemode/prelude/logs.py`:

```python
#: errors(path, n=50): the last n ERROR lines of a log file
async def errors(path, n=50):
    r = await sh(f"rg -n ERROR {q(path)} | tail -n {int(n)}")
    return r.out
```

My own helpers (game server panels, Mongo, ticket fetchers) live in a private repo. They are not part of this one.

## Sandbox

The program cannot touch the host by itself. All I/O goes through tool calls, and those pass the normal permission checks.

- JS: `node --permission` under `env -i`. The guest can read only its run dir and its own file. The program runs in a worker inside a `vm` context.
- Python: CPython under bwrap with `--unshare-all` (no network) and an empty environment. Only `/usr`, the run dir and `guest.py` are visible. If bwrap fails to start, the program does not run.

This sandbox keeps a confused program from reading secrets or reaching the network outside the tools. It is not built to stop a determined attacker.

## Adjust it to your workflow

These parts reflect how I work. Change them in your fork:

- **Tool description** (`DESCRIPTION`, `DESCRIPTION_PY` in `hooks/register.tsx`). It tells the model to send every read-only probe through exec. It also names ssh and Mongo. Keep the full text under 4096 characters. The MCP client cuts listed descriptions at 2048 characters. A `tool.describe` hook puts the full text back, so the "truncated" line in the debug log is expected.
- **The nudge** (`PROBE_TOOLS`, `NEUTRAL_TOOLS`, `NUDGE_MAX`). It decides which direct calls count as probes.
- **read() cap** (`PAGE_TOKENS` and the 48k-token cap in both guests).
- **Transcript row**. It shows 3 lines: header, first output line, click to expand.
- **ssh() options**: `BatchMode=yes`, `ConnectTimeout=10`, a 90 s default timeout.

## Measure whether it helps

`scripts/usage.py` reads your transcripts in `~/.claude/projects/` and counts "wasted" rounds. A wasted round is a direct read-only probe that follows another one, where one exec could have held both.

```sh
python3 scripts/usage.py --days 7
python3 scripts/usage.py --days 7 --agents --examples 2
```

For me the wasted share dropped from about 50% to under 5% once the CLAUDE.md lines were in place.

## Known gaps

- `read()` of a file the session already read can get Claude Code's "file unchanged" stub with no content, and then it fails.
- An agent spawned from inside a subagent's exec reports to the main loop. The engine drops the parent id.
- Pressing Esc during a long inner call is untested.
- `tsc` reports TS2589 (type instantiation too deep) on the `tool.call` hook. The mod still runs.

## Layout

| Path | Content |
|-|-|
| `hooks/register.tsx` | Host side: tool registration, descriptions, permissions, ledger, nudge, transcript row. |
| `runtime/guest.mjs` | JS/TS guest. |
| `runtime/guest.py` | Python guest. |
| `scripts/usage.py` | Usage metric. |
| `docs/research/` | Notes on pi-fabric and other code-mode designs that shaped v0.2. |

Type checking is optional. `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, and those mod type files are not in this repo.

## License

MIT. See `LICENSE`.
