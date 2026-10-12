# pi-fabric code mode study: improvements for the codemode mod

Date: 2026-10-01. Read-only study. No mod files were changed.

## Sources

- pi-fabric upstream 0.103.0, cloned to `sources/pi-fabric-upstream` (commit f8c0ebf, 2026-10-02). The installed copy is 0.102.0. The older clone `sources/pi-fabric-current` is 0.29.0 and is stale.
- Paths below are relative to `sources/pi-fabric-upstream` unless they start with `/`.
- Session evidence: 714 pi session files in `~/.pi/agent/sessions/`. They hold 31,586 `fabric_exec` calls in 498 sessions. Most calls came from DeepSeek v4 flash, Grok 4.6, Kimi K3 and GLM 5.3. No Claude model is in this data.
- Mod API: `/tmp/claude-1000/bundled-skills/2.1.286/4cbe4a17c5e2d4bb9361375664f7a462/plugin-authoring/types/claude-code.d.ts` (written below as `cc.d.ts`).
- Mod source: this repo at v0.1 (`hooks/register.ts`, `runtime/guest.mjs`).

## Session numbers (pi-fabric, all models)

| Metric | Value |
|-|-|
| Calls with an error result | 9.3% (2,920) |
| Type-error results (code not run) | 1,131 (3.6%) |
| Exec right after a type error that succeeded | 783 of 1,060 (74%) |
| Runtime errors | 1,720; top kinds: timeout (87), cancelled (56), nonzero shell exit, bash quoting |
| Programs with exactly one nested call | 19,449 (62%) |
| Programs with `Promise.all` | 3,289 (10%) |
| Programs that set `display` | 21,886 (69%) |
| Programs that used `payloads`/`strings` | 1,501 (5%) |
| Result size, chars p50 / p90 / p99 | 731 / 6,000 / 31,603 |
| Code size, chars p50 / p90 | 479 / 1,606 |
| "multi-line string, see section" markers | 11,348 |
| "Completed before the outer failure" notes | 556 |
| Full-output spill notices | 32 |
| Repeat guard warn / block | 0 / 0 |
| `agents.run` / `agents.spawn` in programs | 147 / 18 |

First diagnostic of type-error results, by kind: syntax `'X' expected` (271), Node globals `Buffer`/`require`/`process` (233), unknown name (199), unterminated string or template (118), excess property (45). Many "Cannot find name" hits are English words and shell tokens (`the`, `echo`, `$`, `head`). Shell or prose text broke out of a string literal there.

Claude transcripts with the mod: 3 runs so far. One run shows a real gap. In an 18-tool session, `bash("id")` failed with `no tool named "Bash" in this session`. The program had no way to know this beforehand.

## How pi-fabric does it (answers to the 8 questions)

### 1. How the model learns the API

- The tool description is one sentence (`src/fabric-exec-tool.ts:166-170`). The `code` parameter description lists the globals and says "See session guidance / `fabric-exec` skill for exact signatures" (`:209`).
- `promptGuidelines` add 6 rules: batch with `Promise.all`, search before reading, return only the compact final value, keep payloads out of code, and use `display` (`src/fabric-exec-tool.ts:173-186`).
- The system prompt gets a turn-stable block (`src/index.ts:995-1061`, `src/core/system-guidance.ts:11-33`). It shows one example call and the return shape per core tool, for example "`pi.read('/x')` ... return strings; `pi.bash({cmd:'ls'})` ... return `{ok, output, details}`".
- Extension tools appear as a names-only roster grouped by package (`src/core/system-guidance.ts:70-108`). The comment says "the standing prompt cost is a bare name index". Schemas come on demand through `tools.search` / `tools.describe({ref})`.
- The 26.8 KB skill `skillsets/typescript/fabric-exec/SKILL.md` loads only on demand: "load this skill only after an argument-shape error" (`:3-7`).
- The model never sees a .d.ts. The 1,580-line hand-written `GUEST_TYPE_DECLARATIONS` (`src/runtime/guest-types.ts:32-1616`) feeds the type checker only. Typed stubs for MCP and extension tools are generated from live input schemas, again for the checker only (`src/runtime/dynamic-guest-types.ts:17-24, 80-134`). Over-budget schemas fall back to `Record<string, unknown>`.
- The flat parameter schema is deliberate. The comment at `src/fabric-exec-tool.ts:188-202` says nested escaped-JSON fields make models invent keys. `display` accepts a bare string and is repaired to `{name}`, because models sent strings (I saw these validation failures in the logs).

### 2. Static type checking

- It uses the real TypeScript 6 compiler in the host process, not in QuickJS (`src/runtime/type-checker.ts:2`, `src/runtime/typescript-kernel.ts:25-43`, `src/execution-service.ts:322-341`).
- The options are loose: non-strict, `lib.es2022` only, `skipLibCheck` (`src/runtime/type-checker.ts:16-33`).
- It drops "type correctness" codes by default: 2339 (no such property), 2551, 2322, 2345 (assignability), 2367, null checks, and implicit any (`:35-40`). What remains is mostly syntax, unknown names, excess properties on tool inputs, and "not callable". Wrong argument types are left to runtime validation.
- The checker is cached: an LRU of 4, `oldProgram` reuse, and cached lib SourceFiles (`:100-181`). The repo has no latency measurement.
- Error format (`src/fabric-exec-tool.ts:972-993`): `Type errors; code was not executed:\nLine L:C — msg`, then an optional `Recovery hint:` from `src/type-error-guidance.ts:117-154`. In the logs the hint fired 180 times. 149 of those were the payload hint.
- Before the check, `src/runtime/guest-code-repair.ts` quietly quotes unquoted paths and URLs, such as `pi.read(/tmp/x)`.
- Defect found: `src/runtime/guest-types.ts:385-386` opens `interface FabricToolsApi {` and then at once `interface FabricActionListEnvelope {`. The checker reports only guest-file diagnostics, so this stays hidden. The typing of `tools.*` is likely degraded.
- My measurement on this machine (TS from `~/.pi/agent/npm/node_modules/typescript`, Node 26.10, a small stub .d.ts): loading `typescript.js` takes 116 ms, the first check 120 ms, and a warm check 5 ms. It caught `{ path }` against Read's input as an excess property, `x.lenght`, and an unknown name.

### 3. Result shaping

- The model text is logs, then the formatted value, then `Runtime error: ...`, then failure progress (`src/fabric-exec-tool.ts:921-947`). Empty output becomes `(no output)`.
- `resultFormat` is `auto|yaml|json|text`. The default `auto` emits YAML. Multi-line strings are hoisted out of the skeleton into raw sections, `<multi-line string, see section: PATH>` plus `--- PATH (N chars) ---` (`src/ui/structured.ts:40-60, 87-119`). The comment explains why: escaped or indented strings get copied wrong into `edit` oldText.
- Budget: `maxOutputChars` is 50,000 by default, and failed runs are capped at 20,000 (`src/output-budget.ts:6-13`, `src/config.ts:460`). Over budget, the full text goes to a 0600 scratch file. The body is cut in the middle and ends with `[Full output (N chars) saved to: PATH]` (`src/output-budget.ts:28-57`).
- A nested result over 2 MB becomes `{fabricTruncated, originalChars, preview}` in the guest (`src/core/action-result.ts:75-103`).
- Intermediate tool output never reaches the model. The UI keeps per-call audits, and a compact card shows `✓ Tools · N calls · k failed` (`src/fabric-exec-tool.ts:123-135`).
- Runtime stacks are mapped back to `guest code:L:C` (`src/runtime/guest-stack-map.ts:118-133`).
- On failure, `src/failure-progress.ts:12-33` adds: "Completed before the outer failure (outputs not returned): pi.bash; pi.edit(src/x.ts) ... Successful calls may already have changed the workspace; inspect before repeating mutations." It lists up to 8 calls.

### 4. Speculation, repairs, entropy

- **Speculative PTC** (`docs/speculation.md`, `src/speculation/`). It taps the streaming `code` argument, parses it every 50 ms, and launches read-only calls whose arguments are all literals. Results are keyed by (call id, ref, args hash) and served once. A mutation bumps an epoch that invalidates them, and `pi.read` re-checks mtime and size. Defaults: on, 4 concurrent, 64 entries, 180 s TTL. `agents.*` is excluded because "a wrong speculation spends real tokens". No benefit is measured. `speculated:true` does not appear in the persisted session logs.
- **Catalog repairs** (`docs/repairs.md`, `src/repairs/`). It learns key and action aliases from near-miss calls with exactly one unique fix. The store is global at `~/.pi/agent/fabric/repairs/current.json`, capped at 256 rows. The goal is "repeat invocation fingerprints → 0". No outcome data.
- **Tool entropy** (`docs/entropy.md`). Metric: rejections per action call. "Normal forms" are derived statically from each schema: key case and separators, enum spelling, numeric strings, and null on an optional field. They are applied at the validation boundary and compiled in the background at turn end. The doc reports compiled delta 0 and says it is "not a task-success metric".
- The SKILL lists the static aliases models need most (`skillsets/typescript/fabric-exec/SKILL.md:38-40`): `cmd`→`command`, `file_path`→`path`, `old_string`→`oldText`, numeric-string coercion, null dropped for optional fields.

### 5. Limits, approvals, cancellation

- Wall time: 120 s by default, 900 s max. The per-call `timeoutMs` can only raise the limit (`src/config.ts:455-456`, `src/execution-service.ts:518-523`). The deadline grows while a nested shell with its own timeout runs, by its timeout plus 5 s (`:537-552`).
- QuickJS memory is 64 MiB and its stack 256 KiB.
- There is no general cap on nested calls. Agents are capped at 4 concurrent, 100 per execution and depth 2 (`src/config.ts:503-512`).
- Approvals: each risk class is allow, ask, auto or deny. Prompts are serialized. Without a UI the call fails closed (`src/core/approval-controller.ts:44-220`).
- Cancel: an abort interrupts QuickJS and aborts host calls after 250 ms of grace. Leftover promises are rejected. Owned work is reported as "Owned work stopped".
- Repeat guard: it warns after 3 identical programs and blocks at 6 (`src/repeat-guard.ts:8-12`). It fired 0 times in 31.5k runs.

### 6. Persistent state

- No sandbox state survives between calls. "Each invocation starts fresh" (`src/fabric-exec-tool.ts:207-208`).
- `state.*` is a world-model transition log, not a key/value store. Key/value storage is `mesh.get/put/list/delete` with compare-and-swap, kept per project on disk (`src/providers/mesh-provider.ts:211-260`). `memory.recall/expand` searches past transcripts. `programs.save/run` stores reusable programs by content hash.

### 7. Prompt cache and token savings

- The system prompt is kept byte-stable. Text that changes per turn goes into hidden messages instead (`src/index.ts:1034-1060`).
- `cache.hold` needs a host API that stock Pi lacks, so it returns `unsupported`.
- No savings are measured. `docs/prompt-cache.md:91` says "No live cache-hit rate ... is claimed". `bench/` defines a paired harness but holds no results.

### 8. Agents and model calls from programs

- Programs get `agents.run/spawn/wait` with a JSON Schema `schema` that returns validated `value`, plus `workflow`, `council`, `rlm` and `jev.evaluate` (typed Choice/Score answers only).
- Every advanced workflow skill is `disable-model-invocation: true`. "never load them autonomously" (`skillsets/typescript/fabric-exec/SKILL.md:161`).
- Usage is rare: `agents.run` appears in 147 programs and `agents.spawn` in 18, out of 31.5k. The only evidence of value is anecdote (the ARC-AGI-3 run in README.md:25).

## Ranked improvements for the mod

Fit marks: **API-fit** means it fits the current mod API as is. **Partial** needs a workaround. **No-fit** does not fit.

### 1. Better result format: hoist multi-line strings, compact JSON, middle cut, spill file. API-fit.

- pi-fabric: `src/ui/structured.ts:40-119` (hoisting, fair split of the budget across sections), `src/output-budget.ts:6-57` (50k cap, 20k on failure, middle cut, saved-file path). 11,348 hoist markers in the logs.
- Change in `guest.mjs`: replace `JSON.stringify(value, null, 2)` with a serializer that does three things:
  - It writes flat arrays of objects one item per line.
  - It replaces each string that contains `\n` with `<see section PATH>`.
  - It appends raw `--- PATH (N chars) ---` sections.
- Change in `register.ts`:
  - Cut the middle, not the tail.
  - Lower `MAX_OUTPUT` to about 40k, and to 20k on failure.
  - Write the full text with `$.fs.write` to the session scratch dir, and append `[Full output (N chars) saved to: PATH. Read it with offset/limit.]`.
  - Cap logs on their own (pi-fabric: `[Pi Fabric log output truncated]`).
- Value: high. Claude often returns file slices for later edits. Escaped `\n` in JSON costs tokens and breaks exact `old_string` copies. The tail of a long output often holds the conclusion.
- Effort: S (about 80 lines).
- Risk: low. A path inside a result may contain `\n`. Hoist only strings longer than about 80 chars.

### 2. Failure progress note. API-fit.

- pi-fabric: `src/failure-progress.ts:12-33`, which fired 556 times.
- Change: `serve()` already sees every call. Record `{tool, short arg (file_path | command head | pattern), ok}`. When `done.ok` is false or the program timed out, add: `Completed before the failure (outputs not returned): Bash(git status); Edit(src/a.ts) ... Inspect before repeating writes.` Show up to 8 calls.
- Value: high for programs with writes. It stops blind retries that apply an Edit twice.
- Effort: XS.
- Risk: none.

### 3. Correct error positions and recovery hints. API-fit.

- pi-fabric: `src/runtime/guest-stack-map.ts:118-133` maps to `guest code:L:C`. `src/type-error-guidance.ts:117-154` gives short hints.
- Current mod behaviour, which I tested on Node 26.10:
  - A parse error returns only `err.message`, for example "Unknown regular expression flags." The `stripTypeScriptTypes` error's `stack` has a code frame with a caret, but on wrapper line `:3` when the user's line is 2. The mod drops it.
  - Runtime stacks read `at codemode (eval at <anonymous> ([eval]:6:15), <anonymous>:3:6)`. That is off by one, with noise frames.
- Change:
  - For parse errors, return `Line L:C — message` plus the code frame, with the line shifted by -1.
  - For runtime errors, compile with `vm.Script(wrapped, { filename: "program.ts", lineOffset: -1 })`, or rewrite `<anonymous>:N:C`, and keep only `program.ts` frames.
  - Add 3 hints:
    - Unquoted path or regex-flag error: "quote paths as strings".
    - ReferenceError on `Buffer`/`require`/`process`/`fetch`: "no Node APIs here; use tools".
    - A syntax error inside a template literal containing `${` or shell text: "build the string with concatenation, or keep shell text in single quotes".
- Value: medium-high. In the pi logs, 74% of type-error retries succeeded, because the model got a line and a reason.
- Effort: S.
- Risk: low.

### 4. Tool roster and environment facts in guidance. API-fit.

- pi-fabric: a names-only roster in a turn-stable system-prompt section (`src/core/system-guidance.ts:70-108`). Discovery stays on demand.
- Mod evidence: `bash()` failed in a session without Bash.
- Change:
  - At `session.start`, read `$.tool.list()` once. Add a short line through a `prompt.section` hook: "Callable inside exec: Read, Edit, ..., mcp__x__y ...". Keep it a stable string and call `$.ui.invalidate("prompt.section")` only when the list changes.
  - Make `read()`/`bash()` throw a clear `ToolError` naming the missing tool when it is absent.
  - Do not edit the tool description per session after the first turn. A description change busts the prompt cache.
- Value: medium. Deferred MCP tools (behind ToolSearch) become visible to programs.
- Effort: S.
- Risk: a large MCP list adds prompt tokens. Cap the list at about 60 names and say "plus N more, see listTools()".

### 5. Static argument normalization for built-in tools (a cheap form of "entropy normal forms"). API-fit.

- pi-fabric: the alias table at `skillsets/typescript/fabric-exec/SKILL.md:38-40` and the 4 normal-form rules in `docs/entropy.md:100-140`. Canonical keys always win. Unknown keys still fail.
- Change: in `serve()`, before `$.tool.call`, map known near-misses only when the canonical key is absent:
  - `path`/`file`→`file_path` for Read, Write, Edit.
  - `cmd`→`command`.
  - `old`/`oldText`→`old_string`, `new`/`newText`→`new_string`.
  - Numeric strings→numbers for `offset`, `limit`, `timeout`.
  - Drop `null` on optional keys.
- Take the key sets from `BuiltinToolInputs` in `cc.d.ts:14717` at build time.
- Value: medium. It avoids a `ToolError` in the middle of a program after earlier calls already ran.
- Effort: S.
- Risk: a wrong alias could change meaning. Keep the table small and exact. Skip learned repairs.

### 6. Concurrency cap, call budget, host robustness. API-fit.

- pi-fabric has no general nested-call cap. It caps speculation at 4, agents at 4 concurrent and 100 per run, and nested programs at 16.
- Mod gaps in `register.ts`:
  - A `Promise.all` over 1,000 files fires 1,000 `$.tool.call`s at once. Each can open a permission dialog.
  - `JSON.parse` of a marked line has no try, so one bad line aborts the loop.
  - `buffer` and `stderr` grow without bound.
  - The guest can print forged marked lines with `process.stdout.write`. This gives no privilege gain, because forged calls still pass permissions.
- Change:
  - Add a host semaphore (8 to 16) in `serve`.
  - Add a per-exec call cap (about 300) that replies `{deny: "call budget reached"}`.
  - Wrap the parse in try.
  - Cap `buffer` and keep the last 4 KB of stderr only.
- Value: medium.
- Effort: XS.
- Risk: none.

### 7. Timeout and cancel semantics. Partial fit.

- pi-fabric: default 120 s, max 900 s. The deadline grows while a nested shell with an explicit timeout runs. On abort or timeout, host calls are aborted after 250 ms and the result says what was stopped.
- Mod gap: `timeout` kills the child, but `await Promise.allSettled(inflight)` then waits for every in-flight tool call. A 10-minute Bash keeps exec open well past its timeout.
- Change:
  - After the child exits, race `inflight` against a 2 s grace. Report the unfinished calls as "still running, result dropped".
  - Optionally drop the `timeout` binary and keep the deadline on the host (`$.clock`). The host can then extend it while a `Bash` call with its own `timeout` runs.
- Unconfirmed: whether a nested `$.tool.call` aborts when `next.signal` aborts. `cc.d.ts` documents a signal for `$.model.complete` and `$.process.spawn`, but none for `$.tool.call`. Test this with a long `sleep` and Esc.
- Value: medium.
- Effort: S.
- Risk: low.

### 8. Pre-execution type check against generated declarations. Partial fit.

- pi-fabric: `src/runtime/type-checker.ts` (TS compiler on the host, loose options, type-correctness codes filtered out).
- Fit with the mod API:
  - Built-in tool input and result types exist in `cc.d.ts` as `BuiltinToolInputs` (line 14717) and `BuiltinToolResults` (line 14891). Generate `runtime/guest.d.ts` from them at build time: `tools.Read(input: BuiltinToolInputs["Read"]): Promise<string>`, `call<T>()` returning `{ result: BuiltinToolResults[T] }`, and the helpers.
  - MCP schemas are not available: `ToolInfo` is `{name, description, mcp}` (`cc.d.ts:12073`), and `tool.describe` gives no schema. Type MCP tools as `Record<string, unknown>`.
  - The hooks module cannot eval. The check must run in a child process. Either the guest loads TypeScript itself (add `--allow-fs-read` for its directory, about 240 ms cold per exec by my measurement), or a persistent checker child uses the same file-reply protocol (about 5 ms warm).
- Change: report only syntax, unknown names (2304), excess properties on tool inputs (2353), and "not callable" (2349). Copy pi-fabric's filter. Put `Type errors; code was not executed:` first.
- Value: medium. It catches mistakes before any side effect. In the pi logs 3.6% of runs hit this gate. Most of those were syntax errors, which `stripTypeScriptTypes` already catches. Claude likely makes fewer key mistakes than flash-tier models (unconfirmed, as no Claude data exists).
- Effort: M.
- Risk: it needs a TypeScript dependency on disk. False positives would block valid programs. Do items 3 and 5 first, then measure Claude's runtime error rate before building this.

### 9. Optional `title` parameter for the UI. API-fit.

- pi-fabric: `display {name, description}`, set in 69% of calls. A bare string is repaired to `{name}` (`src/run-display.ts:27-40`).
- Change: add an optional `title` string. Show it in `$.ui.status` as `codemode: <title> · N calls`. Accept a string only, and keep the schema flat.
- Value: low-medium (UX and transcript readability).
- Effort: XS.
- Risk: none.

### 10. Session key/value store between exec calls. API-fit.

- pi-fabric: no sandbox state. Project-scoped `mesh` key/value with compare-and-swap on disk.
- Change: `store.get(key)`, `store.set(key, value)` and `store.keys()` as pseudo-tools `$get`/`$set` served from `$.state` or `$.store`. Scope them to the session and cap them (for example 256 keys, 1 MB each).
- Value: low-medium. A later program can reuse a large intermediate result (a file list, a parsed index) without it passing through context.
- Effort: S.
- Risk: stale state across edits. Document it as a cache the model owns.

### 11. `ask()` via `$.model.complete`. API-fit, but use with care.

- pi-fabric: `agents.run` with a `schema`, and `jev.evaluate` for typed judgments. Usage was tiny (165 of 31.5k programs). The advanced skills are blocked from autonomous use. Budgets: 4 concurrent, 100 per run.
- Change: `ask(prompt, { model: "haiku", maxTokens, effort })` returns text. Cap it at 4 concurrent and about 20 per exec. Add a usage footer to the result (`ask: 12 calls, 18k in / 2k out`). `ModelCompleteRequest` has no schema field (`cc.d.ts:5670`), so the guest must parse JSON itself.
- Value: low-medium. It helps map-style work, such as classifying 200 files without loading them into context.
- Effort: S.
- Risk: spend the main model cannot see. Text from files reaches a sub-model, which is a prompt-injection path, though the sub-model has no tools. Keep this off by default or behind a setting.

### 12. Payloads parameter. API-fit, low value here.

- pi-fabric: `payloads` → `π.key` (`src/fabric-exec-tool.ts:211-216`), used in 5% of calls. 149 hints fired where payload text broke the code.
- In Claude Code the native Write and Edit tools stay available. Programs rarely need to carry large literal content.
- Port it only if exec becomes the main write path. Effort S.

### Do not port

- **Speculative PTC.** No-fit in practice. `turn.step` exposes input chunks (`TurnStepInputChunk`, `cc.d.ts:12476`). But serving a speculated Read means one of two things. Either it bypasses `$.tool.call` hooks and permissions (through `$.fs.read`), or it runs visible, possibly prompting calls before the model commits. Local reads take milliseconds, and pi-fabric shows no measured gain.
- **Learned catalog repairs and the entropy compiler.** They are heavy, the store is global, and pi-fabric measured no benefit. Item 5 covers the useful part.
- **Repeat guard.** It fired 0 times in 31.5k runs.
- **`$.agent.spawn` in programs.** The answer arrives only through a `turn.complete` hook, which needs a correlation map. The model already has the Agent tool natively. Programs may also be able to call `tools.Agent` (unconfirmed). Usage in pi-fabric was rare.
- **A full .d.ts in the prompt.** pi-fabric never shows its declarations to the model. Claude already sees native tool schemas in its tool list.

## Follow-ups outside the ranked list

- Guest environment: `$.process.spawn` `env` is "set over the host process's own environment" (`cc.d.ts`, `ProcessRunInit`). A program can therefore read `process.env` and return secrets into context. Network is blocked: I confirmed `getaddrinfo ERR_ACCESS_DENIED` under `--permission` on Node 26.10. Consider starting the guest through `env -i PATH=... node ...`.
- pi-fabric upstream bug: `src/runtime/guest-types.ts:385-386` has an unclosed `interface FabricToolsApi {`.
- `sources/pi-fabric-current` is 0.29.0. The new clone is `sources/pi-fabric-upstream`.

## Suggested order

1. Items 1, 2, 3 and 6 together (about half a day). They touch only `guest.mjs` and `register.ts` and carry no new dependencies.
2. Items 4, 5 and 9.
3. Item 7, after testing whether nested calls abort.
4. Measure Claude's error mix over a week of real use, then decide on items 8, 10 and 11.
