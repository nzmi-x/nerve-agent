# interceptors

**Status:** built (Phase 1)
**What:** the v1 interceptors — the concrete users of the "nerve" (the `pipe` seam in [stream](stream.md)).
**Code:** `src/interceptors.ts` (tests: `tests/interceptors.test.ts`). See [DECISIONS D9](../DECISIONS.md).

**How it works:**
- Each is a small factory returning an `Interceptor` (`(ev, ctl) => ev | null | void`):
  - **`tokenTap(session)`** — tees text/reasoning/usage to the session JSONL (observe).
  - **`reasoningRouter(onReasoning)`** — forwards reasoning deltas to a sink, e.g. the TUI fold (observe).
  - **`secretRedaction()`** — scrubs secret-looking tokens from text/reasoning deltas (rewrite).
  - **`stopGuard(patterns)`** — `ctl.abort()`s the turn when `ctl.text + delta` matches a banned pattern.
- The loop composes them **in order**: `secret-redaction → reasoning-router → stop-guard → token-tap`
  — redaction before the tap (or a secret is logged), tap last (it records the final event).

**How to change it:**
- A new behavior = a new factory here + place it in the loop's interceptor array at the right spot.
  Don't touch `pipe`. Keep them **synchronous** (the per-delta path stays fast).
- Order is load-bearing — re-read the chain above before inserting one.

**Gotchas:**
- `secretRedaction` is **per-delta** — a secret split across two deltas won't match. Buffer in the
  interceptor if that matters.
- `stopGuard` only watches `text` (not reasoning); it sees prior text via `ctl.text` plus the current delta.

**See:** [stream](stream.md) · [DECISIONS D9](../DECISIONS.md) · [loop](loop.md)
