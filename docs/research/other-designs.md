# codemode: what other code-mode designs teach

Date: 2026-10-01. Mod examined: this repo at v0.1 (`hooks/register.ts`, `runtime/guest.mjs`).

Repos cloned for source reading:
- `sources/agents` (Cloudflare Agents, `packages/codemode`, commit e780214, 2026-10-01)
- `sources/code-mode` (UTCP code-mode, commit e5fdc31, 2026-08-25)
- `sources/smolagents` (commit c30b115, 2026-09-30)

## 0. Blocker found while testing

The exec tool does not run any program in this session. Every call fails before the program starts:

```
Error: Access to this API has been restricted. Use --allow-fs-read to manage permissions.
    at Object.realpathSync (node:fs:3460:37)
    ...
    at resolveMainPath (node:internal/modules/run_main:37:21)
  resource: '<plugin dir>/codemode'
```

Node v26.10.0 resolves the main module with `realpathSync`. That walks the parent folders, and `--permission` denies it. I reproduced it in a shell with the same argv. Results:

| Flag set | Result |
|-|-|
| as shipped | crash |
| `--allow-fs-read=<runtime dir>/` | crash |
| `--allow-fs-read=<plugin root>` | crash |
| add `--preserve-symlinks-main` | works: `{"ok":true,"value":"2"}` |

Fix: add `--preserve-symlinks-main` to the node argv in `register.ts`. The host also reports this crash as "the program stopped without a result (timeout 120s?)". That text is wrong. See item 3.

## 1. Survey

### Anthropic: Code execution with MCP (engineering post, Nov 2025)
URL: https://www.anthropic.com/engineering/code-execution-with-mcp
- API presentation: a file tree of TS wrappers (`servers/<server>/<tool>.ts`). The model lists folders and reads only the files it needs. An optional `search_tools` takes a detail level: name only, name plus description, or full schema.
- Results: the model sees what the code logs. Intermediate data stays in the sandbox.
- State: the agent writes files to `./workspace/` and resumes later. It saves reusable functions as skills (`./skills/*.ts`).
- Privacy: the client can tokenize PII (`[EMAIL_1]`) so values flow tool to tool without entering context.
- Numbers: 150,000 to 2,000 tokens (98.7%) on one example workflow.
- Pitfall stated: sandboxing, resource limits and monitoring add operational cost.

### Anthropic: Advanced tool use + Claude API docs (Nov 2025, docs current to Oct 2026)
URLs: https://www.anthropic.com/engineering/advanced-tool-use, https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling, https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool, https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Programmatic tool calling (PTC), GA. A tool opts in with `allowed_callers: ["code_execution_20260120"]`. Claude writes Python. Each tool is an async function that takes one dict and returns a string (the tool_result text). Claude parses it with `json.loads` when needed. Results go to the code, not to context. Only stdout of the cell reaches the model.
- Versions: `code_execution_20260120` adds PTC and REPL state persistence. Variables persist across requests that reuse the container. `code_execution_20260521` is the same runtime, but its description tells Claude about the 90-second per-cell limit "so Claude can budget long-running cells".
- Errors: a tool error string goes back to the code. A pending call times out after about 4 minutes and raises `TimeoutError` in the code. Claude sees it in stderr and usually retries.
- Doc guidance: document the output format (JSON structure, field types). Return structured data. Keep responses concise. Choose `direct` or code-only per tool, not both.
- Measured: 75-tool project-management benchmark: about 38% fewer billed input tokens, no change in accuracy. tau2-bench (one or two sequential calls per turn): no score change, about 8% higher cost. Production traffic with 10 to 49 tools: 20% to 40% savings. Blog figures: 43,588 to 27,297 tokens (37%); internal retrieval 25.6% to 28.5%; GIA 46.5% to 51.2%.
- Weak fit (docs): strictly sequential work where each step needs model reasoning; few calls with small results; tools that need user feedback between calls.
- Code execution doc warns of "multicomputer" confusion: Claude can assume state is shared between the code sandbox and a client Bash tool.
- Tool search: deferred tools load on demand. 85% token reduction. Opus 4 49% to 74%, Opus 4.5 79.5% to 88.1% on MCP evals. Selection accuracy degrades past 30 to 50 tools. Keep the 3 to 5 most used tools non-deferred.
- Tool use examples (`input_examples`): 72% to 90% on complex parameter handling.
- Writing tools for agents (https://www.anthropic.com/engineering/writing-tools-for-agents): Claude Code caps tool responses at 25,000 tokens by default. Truncate with steering text. Give actionable errors, not tracebacks.

### Cloudflare Agents Code Mode (Sep 2025, package current Oct 2026)
URLs: https://blog.cloudflare.com/code-mode/, https://blog.cloudflare.com/code-mode-mcp/; source `sources/agents/packages/codemode/`
- API presentation, v1: one tool. Its description embeds generated TS declarations (`declare const codemode: { tool: (input: XInput) => Promise<...> }`) with JSDoc from schema descriptions (`src/json-schema-types.ts`, `src/shared.ts`).
- API presentation, runtime/connector design: the description lists namespaces only. Inside the sandbox, `codemode.search("intent")` returns ranked matches and `codemode.describe("conn.method")` returns TS declarations for one method (`src/connectors/search.ts`, `src/connectors/describe.ts`, `src/proxy-tool.ts` `buildDescription`). The description says: "Never guess method names. ... run a discovery pass first."
- Cloudflare's own API MCP server: two tools (`search`, `execute`), about 1,000 tokens against 1.17M for the full OpenAPI as tools (99.9%).
- Sandbox: V8 isolate per run via Worker Loader. `globalOutbound: null` blocks fetch. Bindings hold credentials. Timeout 60 s by default.
- Code normalization (`src/normalize.ts`): strips Markdown fences. Accepts a bare arrow function, `export default`, or a named function. Splices `return` before a trailing expression.
- Errors (`src/proxy-tool.ts` `withGlobalsHint`): on "x is not defined" it appends the list of real globals "so the retry is informed instead of another guess". Outcomes are returned as `{status}`, not thrown.
- Output (`src/truncate.ts`, CHANGELOG #2224): truncates JSON structurally so it stays valid JSON, marked `--- TRUNCATED ---`. The old cut-at-N-chars gave the model "half a JSON document". Default budget 6,000 tokens.
- Audit: echoes a `calls` log (args and result per call, CHANGELOG #1904). Later projected out of the model's view because of size (#2224).
- Approvals: `requiresApproval` pauses the run durably. Replay is deterministic. Rollback is supported through `revert`.
- Snippets: the developer promotes a good run to a named snippet. The model runs it with `codemode.run(name, input)`.
- History of model failures fixed: the model wrote TS syntax into a JS-only executor (#961, #1760). It invented globals like `host.writeFile` (anti-hallucination description). No accuracy numbers were published.

### UTCP code-mode (`@utcp/code-mode`, MCP server, CLI)
Source: `sources/code-mode/typescript-library/src/code_mode_utcp_client.ts`, `code-mode-mcp/index.ts`
- API presentation: generated TS interfaces per tool under namespaces (`namespace github { interface get_pull_requestInput ... }`). In the sandbox, `__interfaces` (all) and `__getToolInterface('manual.tool')` (one). MCP meta-tools: `search_tools`, `list_tools`, `tools_info` (TS interfaces for a list), `call_tool_chain`.
- Sandbox: `isolated-vm` with a memory limit and a 30 s default timeout. Tool calls look synchronous to the code.
- Results: `{success, nonMcpContentResults, logs}` as JSON. MCP content blocks such as images pass through. `max_output_size` defaults to 200,000 chars and is cut at the head.
- Prompt guidance: "Discover first, code second". "Wrap tool calls in try/catch". The second rule encourages swallowed errors.
- Benchmarks cited are small third-party ones (`imran31415/codemode_python_benchmark`: 6/8 against 7/8 tasks).

### smolagents CodeAgent and the CodeAct paper
Source: `sources/smolagents/src/smolagents/prompts/code_agent.yaml`, `tools.py` `to_code_prompt`, `utils.py`
- API presentation: each tool is a Python `def name(arg: type) -> type:` with a docstring. A tool with an output schema gets "This tool ALWAYS returns a dictionary that strictly adheres to the following JSON schema".
- Key rule (prompt rules 4 and 5): for tools without an output schema, do not chain dependent calls in one block, because the format is unpredictable. Print, then use the result next step. With a schema, chain freely.
- State: "The state persists between code executions". Variables and imports carry over.
- Output: observations are truncated head plus tail (`truncate_content`, 20,000 chars, middle dropped).
- CodeAct (Wang et al., ICML 2024, https://arxiv.org/abs/2402.01030): up to 20% higher success than JSON or text actions across 17 LLMs, with fewer turns. The gains come from control flow, data flow between calls, library use, and self-debugging from interpreter errors.

### Other code-mode servers
- pctx (https://portofcontext.com/blog/introducing-pctx-unified-code-mode-mcp-server): compact TS signatures, about 15 tokens per tool against 200 for JSON schema. Type-checks the code with an embedded TS compiler before running and returns compiler errors. Deno sandbox. Audit log per call.
- Bifrost (https://docs.getbifrost.ai/mcp/code-mode): meta-tools `listToolFiles`, `readToolFile` (`.pyi` stubs per server or per tool), `getToolDocs`, `executeToolCode` (Starlark). Before running, it extracts every `server.tool()` call from the code. It auto-executes only when all of them are pre-approved. Vendor benchmark: 58% to 93% fewer input tokens at 96 to 508 tools, 100% pass rate (about 65 queries).
- Toolscript (https://github.com/mKeRix/toolscript): Claude Code plugin. Deno subprocess, embedding search, hooks that inject tool suggestions into context.
- codemode-x, lootbox, replicate-mcp-code-mode: same shape. Replicate uses a docs-search tool instead of putting types in the description.

### Measured results and critiques
- "The Bitter Lesson of Tool Calling" (arXiv 2608.06370, Aug 2026): BFCL v4, 14 models, tools as typed Python stubs. PTC matched or beat JSON in 11 of 14 models. All five Anthropic models were at or above baseline (+0.0 to +6.5 points). Under context rot, baseline lost 2.3% on average while PTC held steady. Chaining ran in about half the wall time. Cost: 1.5x input tokens, because the stubs sit in the system prompt. Failure: older GPT models wrote literal `\n` instead of newlines.
- AIMultiple (via search summary, unverified): one server, GPT-4.1. Input tokens -78.5%, output tokens +120%, latency +7%.
- Arize (https://arize.com/blog/code-mode/), contextbolt (https://contextbolt.com/blog/code-mode-mcp/): harder to debug, because intermediate results never leave the sandbox. The approval prompt becomes code instead of a named action. Sandbox errors are generic, so retries are less informed. Not worth it under about 10 tools or with small results.
- ToolFailBench (arXiv 2607.04686) names "Result-Ignore": the model calls a tool and ignores the output. In code mode the same risk shows up as an unchecked `isError`.

## 2. Probes of the current guest (Node 26.10, run locally with `--preserve-symlinks-main`)

| Program | Result | Problem |
|-|-|-|
| `async () => { return 42 }` | `(no return value)` | Model wrote a whole function. The arrow is evaluated and dropped. |
| ```` ```ts\nreturn 1\n``` ```` | `TypeError: "" is not a function` | A fenced program gives a baffling error. |
| `const x = 5\nx * 2` | `(no return value)` | No implicit return of the last expression. |
| ReferenceError on program line 2 | reports `<anonymous>:3:11` plus `guest.mjs` frames | Line off by one. Host paths leak. No hint about the real globals. |
| `Promise.reject(...)` not awaited | guest crashes; host says "timeout 120s?" plus raw stderr | Unhandled rejection is not caught. The message is misleading. |

## 3. Host facts that shape the fixes

From `.claude-plugin/types/claude-code/index.d.ts` (Claude Code 2.1.286):
- `$.tool.list()` returns `ToolInfo = { name, description, mcp }` (line ~12074). It has no input schema. The current `listTools()` returns names only.
- `tool.describe` (lines 3876-3886, 11980-12013): a hook can return `isDeferred: false` to keep a tool's schema in the prompt. MCP tools, including `mcp__codemode__exec`, are deferred by default. In this session `mcp__codemode__exec` was in the deferred list, and I had to ToolSearch it before I could call it.
- `$.tool.check` returns `{decision, reason?, rule?}` with no side effects. It is usable for preflight.
- `BuiltinToolInputs`, `BuiltinToolResults`, `McpToolInputs` are empty here. `/plugin-types <dir>` fills them from each tool's input and output schemas and from connected MCP servers. `$.command.run` exists but is queued until the session is idle.
- `$.mcp.call` exists. There is no MCP list-tools call.

## 4. Ranked improvements

Value and effort: H, M, L. "Fit" says whether the change works inside a Claude Code mod limited to `$.tool.list`/`$.tool.call` and flat registered schemas.

### 1. Fix guest startup: add `--preserve-symlinks-main`
- Evidence: section 0, live failure plus local repro.
- Change: add the flag to the argv in `register.ts`.
- Value H (nothing works without it). Effort L. Risk L: it skips realpath for the entry file only. Fit: yes.

### 2. Keep `exec` in front of ToolSearch
- Evidence: the d.ts `tool.describe` docs. This session listed `mcp__codemode__exec` as deferred. Anthropic: keep the 3 to 5 most used tools non-deferred.
- Change: `on('tool.describe', { tool: TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))`. Return a stable answer to protect the prompt cache.
- Value H: today the model sees only the name until it searches, so it rarely chooses the tool. Effort L. Risk L: about 450 tokens always in the prompt. Fit: yes.

### 3. Normalize programs and harden errors in the guest
- Evidence: Cloudflare `src/normalize.ts`, `withGlobalsHint` in `src/proxy-tool.ts`; probes in section 2; Anthropic "actionable errors, not tracebacks".
- Changes:
  - Strip a surrounding Markdown fence.
  - If the stripped source evaluates as an expression to a function (`(0,eval)('(' + src + ')')` inside try), call it. This covers `async () => {...}` and `async function main(){}`.
  - If the program returns `undefined` and its last line looks like an expression, retry it with `return (...)` spliced in (check that it parses first). Otherwise make the message say "(no return value: add `return`)".
  - Subtract the wrapper offset (1 line) from `<anonymous>:L:C`. Drop frames that name `guest.mjs` or `node:internal`.
  - On `is not defined`, append the in-scope names: `tools, call, read, bash, listTools, ToolError, console`.
  - On an unknown tool name, list the 3 closest names from `$.tool.list()` (edit distance).
  - Add `process.on('unhandledRejection' | 'uncaughtException')` that calls `finish({ok:false,...})`.
  - On the host side, say "the program crashed" when stderr has a stack, and "timed out after Ns" only when `timeout` exits with 124 or 137.
- Value H. Effort L. Risk L: the auto-return heuristic could return a value the model did not intend, so mark it ("returned last expression"). Fit: yes.

### 4. Call ledger footer against swallowed errors
- Evidence: Cloudflare `calls` echo (CHANGELOG #1904) and its later cut for size (#2224); Arize and contextbolt on debugging; ToolFailBench Result-Ignore; UTCP's prompt pushes try/catch.
- Change: the host already serves every call. Count them by tool and outcome. Append one line, for example `calls: 14 (Read 10, Grep 3, Bash 1); failed: Bash x1 "exit 3"; denied: none`. Print only first-line error snippets, capped at about 300 chars. On a failed run, also list which calls completed before the throw. If calls are still in flight when `done` arrives (un-awaited promises), say so: those side effects still happen after the program returned.
- Value H: makes an ignored `isError` and a partial failure visible at near-zero token cost. Effort L. Risk L. Fit: yes.

### 5. Docs on demand: `describe(name)` and a richer `listTools()`
- Evidence: Anthropic `search_tools` with detail levels; Cloudflare `codemode.search`/`describe` plus "never guess method names"; UTCP `__getToolInterface`; Bifrost `readToolFile`/`getToolDocs`; pctx 15 tokens per signature; Anthropic says parameter errors drop with examples (72% to 90%).
- Changes:
  - `listTools(filter?)` returns `[{name, mcp, summary}]` with the first sentence of each description. It filters by substring or regex, the same idea as Cloudflare's search.
  - `describe(name)` returns the full description plus a TS-style input signature and the result shape. Schema sources, since `$.tool.list` has none:
    - (a) Built-ins: run `/plugin-types` once per Claude Code version and ship the generated `BuiltinToolInputs`/`BuiltinToolResults` text in the mod. Serve slices by tool name. Regenerate when the first line of `index.d.ts` changes version.
    - (b) MCP tools: ToolSearch `select:<name>` returns the JSON schema in a `<functions>` block. Unverified: whether calling ToolSearch through `$.tool.call` also loads that tool into the main loop. Test it before you rely on it.
    - (c) Ask for an `inputSchema` field on `ToolInfo` upstream. That is the clean fix.
  - Description line: "If unsure of a tool's input, call `describe(name)` first. Do not guess."
- Value M-H: fewer bad-input round trips, and MCP tools become usable without loading their schemas into the main context. Effort M. Risk M: snapshot drift across versions, and (b) is unverified. Fit: (a) and (c) yes; (b) depends on the test.

### 6. Document result shapes and add structured helpers
- Evidence: smolagents rules 4 and 5 (chain only when the output schema is known); PTC "document return format"; advanced-tool-use example of documented return fields.
- Change: in the description, give one line per core tool `result` record, for example Read `result.file.content`, Bash `result.stdout/stderr`, Grep and Glob file lists. Take the exact field names from the `/plugin-types` output (I did not verify them here). Add `glob(pattern, path?) -> string[]` and `grep(pattern, opts) -> {files|lines}` helpers that return arrays, so the model stops splitting text.
- Value M-H: most model code today parses text with `split("\n")`, which breaks on headers and truncation notes. Effort L-M. Risk L. Fit: yes.

### 7. Better output budget: smaller cap, structural cut, spill to file
- Evidence: Cloudflare `src/truncate.ts` and #2224 (half-JSON problem; 6,000-token default); smolagents head plus tail; Anthropic 25,000-token cap with steering text.
- Change: drop `MAX_OUTPUT` from 80,000 chars to about 40,000. For non-string returns, shrink largest values first and keep valid JSON. For strings, keep head and tail. Write the full output to a host temp file (outside `runDir`, which gets deleted) and give its path: "full output: /tmp/codemode-out-XXXX.txt (N chars); Read it with offset/limit".
- Value M. Effort L-M. Risk L-M: spill files hold tool data, so delete them at session end. Fit: yes.

### 8. Opt-in state across exec calls
- Evidence: PTC `code_execution_20260120` REPL persistence; smolagents rule 10; Anthropic `./workspace` files. Counter-evidence: the "multicomputer" warning in the code-execution doc.
- Change: a `state` object (JSON-serializable) that the host keeps per session and agent. Send it in with the program and read it back from `done`. Cap it at a few MB and say so when dropped. Alternative: a `memo(key, fn)` helper backed by the same store. Keep the persistent process idea out of scope: it fights the one-shot `--permission` model.
- Value M: fetch a big result once, then query it in later calls without re-reading. Effort M. Risk M: stale data, and the model may assume Bash sees `state`. Say "state lives only inside exec" in the description. Fit: yes.

### 9. Timeout that respects permission dialogs
- Evidence: PTC 20260521 puts the limit in the description so Claude budgets; PTC pending-call timeout semantics.
- Change: the external `timeout` keeps counting while a permission dialog waits, so a slow human answer kills the run. Move the timer into the host. Pause it while any served call is awaiting a dialog, or count only time with no call in flight. Keep a hard ceiling. Optionally run `$.tool.check` per call and put "waiting for approval: <tool>" in `$.ui.status`.
- Value M. Effort M. Risk L. Fit: yes, though the host cannot see "dialog open" directly. `$.tool.check` returning `ask` is the proxy for it.

### 10. Description tuning: when to use, when not to
- Evidence: PTC weak-fit list and the tau2 +8% cost; Arize and contextbolt; Cloudflare anti-hallucination lines.
- Change: add 2 short lines. "Use for 3+ calls, fan-out, or large outputs you will filter. For one small call, call the tool directly." And: "Types: annotations only; enum and namespace are not supported" (strip mode rejects them). Show `describe()` and the ledger in the example.
- Value M. Effort L. Risk L. Fit: yes.

### 11. Saved snippets
- Evidence: Cloudflare snippets (`codemode.run(name, input)`); Anthropic skills folder.
- Change: `run(name, input)` loads `~/.claude/codemode/snippets/<name>.js` through the host's Read and evaluates it with `input`. A `/codemode-save` command could store the last good program.
- Value L-M: Claude Code already has skills and files. Effort M. Risk M: reused code runs with new permissions context. Fit: yes.

### 12. Static preflight of tool names
- Evidence: Bifrost extracts calls and auto-executes only if all are allowed; pctx type-checks before running.
- Change: before spawning, scan for `tools.X(` and `call("X"`. Reject unknown names at once with suggestions. Optionally run `$.tool.check` on literal inputs.
- Value L-M: item 3 already catches unknown names at run time. Effort L. Risk L: dynamic names slip through. Fit: yes.

### 13. Non-text results
- Evidence: UTCP passes MCP content blocks (images) through.
- Change: none now. `r.text` joins only text blocks, so image results are lost. Document "returns text only".
- Value L. Fit: limited by the hook result shape. Not checked.

### Not a fit
- `allowed_callers` and per-tool code-only exposure: the mod cannot change how built-in tools are presented, except to defer them. Deferring Read, Grep and Bash behind ToolSearch, Cloudflare style, would push all work into exec and remove direct reviewable calls. Not recommended.
- Embedding the TS types of every tool in the description (Cloudflare v1, the "Bitter Lesson" stubs): it costs 1.5x input tokens. Without schemas from `$.tool.list`, docs on demand (item 5) fits better.
- Durable pause/resume and rollback (Cloudflare approvals): Claude Code already blocks inside `$.tool.call` for the dialog. There is nothing to replay.

## 5. Verified here and still open

Verified locally:
- The startup crash and the `--preserve-symlinks-main` fix (same argv, Node 26.10.0).
- The section 2 probes (no-tool programs only).
- The `ToolInfo` shape, the `tool.describe` deferral and `$.tool.check`, from the shipped d.ts.

Not verified:
- How `$.tool.call` reports a Bash non-zero exit (my probe could not run because of the blocker).
- The exact `result` field names per built-in tool.
- Whether ToolSearch called from inside a program loads tools into the main loop.
- The AIMultiple numbers (search summary only).
