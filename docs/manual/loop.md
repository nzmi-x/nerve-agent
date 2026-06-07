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
- If the committed assistant turn has tool calls: read-only ones `dispatch` **concurrently** (`Promise.all`),
  mutating ones (`write`/`edit`/`bash`) **sequentially** ([D32](../DECISIONS.md), split by `isReadOnlyTool`);
  results are `session.addToolResult`'d in the model's **original call order**. `onToolStart` fires before
  each dispatch and `onToolResult` after, both carrying the call **id** (read-only calls finish out of
  order). No tool calls → done.
- **One `AbortController` per turn** carries both ESC (`opts.signal`) and a `stopGuard`'s `ctl.abort()`;
  it's the signal the provider fetch and the pipeline watch. An aborted turn commits its partial
  message and stops (no dispatch).
- **Auto-retry + model-ladder fallback ([D15](../DECISIONS.md), `src/retry.ts`).** The loop *owns*
  `error` StreamEvents (they don't reach `onEvent`). On a **transient** error (`isTransient`: 429/5xx,
  overloaded, rate-limit, socket/timeout) it `discardAssistant()`s the failed turn and retries:
  first it falls to the next **`fallbacks` candidate** (the model ladder, delay 0), then — once the
  ladder is exhausted — it backs off exponentially on the same model (`retry.maxRetries`, default 2).
  `onRetry(info)` fires each attempt; `onError(err)` fires when it gives up. **Context overflow is not
  transient** (`isContextOverflow`) — it's left for compaction ([D17](../DECISIONS.md)), never retried.
- The caller builds `fallbacks` from the catalog via `fallbacksFor(models, active)` (`config.ts`),
  which skips unimplemented/unkeyed providers. The ladder only advances (no flapping back).
- `maxTurns` (default 24) caps a runaway tool-calling model; a retry is **not** counted as a turn.

**How to change it:**
- Keep `loop` pure over the session and free of UI — the TUI observes via `onEvent`/`onToolResult`.
- New per-turn behavior usually belongs in an **interceptor** or a **tool**, not in `loop`.

**Gotchas:**
- Tool `args` arrive as a JSON string; `parseArgs` tolerates malformed/empty → `{}`.
- On ESC mid-stream the partial assistant message is committed (it's real, possibly-shown content);
  a *failed* (transient-error) turn is **discarded**, not committed, before the retry.
- Retry classification is regex over the error *message* (`retry.ts`) — two providers, so patterns
  beat typed codes. A new transient shape = add a pattern there, not loop logic.

**See:** [ARCHITECTURE_BRIEF §3](../ARCHITECTURE_BRIEF.md) · [DECISIONS D15](../DECISIONS.md) · [session](session.md) · [dispatch/modes](modes.md) · [interceptors](interceptors.md)
