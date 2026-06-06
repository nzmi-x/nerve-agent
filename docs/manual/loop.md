# loop

**Status:** built (Phase 1)
**What:** the agent turn loop — drives a session through the provider, interceptors, and tool
dispatch until the model stops calling tools.
**Code:** `src/loop.ts` (tests: `tests/loop.test.ts`). See [ARCHITECTURE_BRIEF §3](../ARCHITECTURE_BRIEF.md).

**How it works:**
- `loop(opts)` is a **pure, re-entrant function over a `Session`** — a subagent later is just "call
  it with a fresh session + a cheaper profile" ([D6](../DECISIONS.md)). No turn state in module globals.
- Per turn: build a neutral `ProviderRequest` from `session.messages` → `provider.stream(req, signal)`
  → `pipe(source, interceptors, ac)` → `session.apply(ev)` (+ `onEvent`) → `commitAssistant()`.
- If the committed assistant turn has tool calls: `dispatch(name, args, mode, ctx)` each (mode-gated),
  `session.addToolResult(...)` (+ `onToolResult`), and loop again. No tool calls → done.
- **One `AbortController` per turn** carries both ESC (`opts.signal`) and a `stopGuard`'s `ctl.abort()`;
  it's the signal the provider fetch and the pipeline watch. An aborted turn commits its partial
  message and stops (no dispatch).
- `maxTurns` (default 24) caps a runaway tool-calling model.

**How to change it:**
- Keep `loop` pure over the session and free of UI — the TUI observes via `onEvent`/`onToolResult`.
- New per-turn behavior usually belongs in an **interceptor** or a **tool**, not in `loop`.

**Gotchas:**
- Tool `args` arrive as a JSON string; `parseArgs` tolerates malformed/empty → `{}`.
- On ESC mid-stream the partial assistant message is committed (it's real, possibly-shown content).

**See:** [ARCHITECTURE_BRIEF §3](../ARCHITECTURE_BRIEF.md) · [session](session.md) · [dispatch/modes](modes.md) · [interceptors](interceptors.md)
