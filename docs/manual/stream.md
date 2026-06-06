# stream

**Status:** built (Phase 1)
**What:** the SSE reader + the synchronous interceptor pipeline (the "nerve").
**Code:** `src/stream.ts` (event types in `src/providers/types.ts`; tests in `tests/stream.test.ts`)

**How it works:**
- `sse(body)` turns a fetch SSE body into `data:` payload strings — skips `:` keep-alive comments
  and blank lines, tolerates CRLF, joins multi-line `data:` events, reassembles payloads split
  across network chunks, and flushes a final event with no trailing blank line. Yields `[DONE]`
  verbatim (DeepSeek's sentinel; Gemini just ends the stream).
- `pipe(source, interceptors, ac)` runs every `StreamEvent` through the interceptors **in array
  order**, then yields the survivors. An interceptor returns the event (maybe mutated), `null` to
  drop it, or calls `ctl.abort()`. `ctl.emit(ev)` injects a synthetic event downstream; `ctl.text`
  is the accumulated visible text so far.
- The caller passes the interceptor array fresh each turn, so it stays hot-swappable ([D7](../DECISIONS.md)).

**How to change it:**
- New stream behavior = a **new `Interceptor` in the array**, not a change to `pipe`. Order is
  load-bearing (redaction before tap — see [interceptors](../DECISIONS.md), D9).
- A new SSE quirk (a different keep-alive shape, a provider that frames differently) → `sse()`.
  Keep it dependency-free (`fetch` + `TextDecoder` only).

**Gotchas:**
- `ctl.text` is the text accumulated *before* the current event; an interceptor that needs the
  current delta uses `ctl.text + ev.delta` (that's how stop-guard works).
- Emitted events are **not** re-run through the interceptors (avoids recursion).
- After `ctl.abort()`, the current event is still yielded, then the pipe stops pulling `source`.

**See:** [ARCHITECTURE_BRIEF §2](../ARCHITECTURE_BRIEF.md) · [providers.md §1.5](../providers.md) · [DECISIONS D9](../DECISIONS.md)
