# tools

**Status:** read/write/edit built (Phase 1) · bash/search/manual pending
**What:** the local tool set the model calls. Each is a plain object run as a direct Bun call —
no daemon, no RPC. The registry exposes them to the providers and to the dispatcher.
**Code:** `src/tools/types.ts` (the `Tool` contract) · `src/tools/registry.ts` · `src/tools/*.ts`
(tests: `tests/tools.test.ts`)

**How it works:**
- A `Tool` is `{ name, description, parameters (JSON Schema), readonly, run(args, ctx) }`.
  `run` returns the result string shown to the model; recoverable failures return an `Error: …`
  string rather than throwing.
- `readonly` drives PLAN-mode gating in the dispatcher ([D4](../DECISIONS.md)) — `read` is readonly,
  `write`/`edit` are not.
- `registry.ts` assembles `tools`, `toolByName`, and `toolSpecs()` (the name/description/parameters
  the providers see — `run` never goes on the wire).
- `read` emits `hashline.encode` (`LINE#HASH:content`); `edit` drives `hashline.applyEdits` and, on a
  stale anchor, returns the rejection + fresh anchors; on success (small files) it echoes updated
  anchors so the next edit needs no re-read. `write` creates parent dirs (`Bun.write`).

**How to change it:**
- **Add a tool** = a new `src/tools/<name>.ts` exporting a `Tool`, then add it to `tools` in
  `registry.ts`. Set `readonly` honestly. A tool must earn its rent ([D2](../DECISIONS.md)): high
  frequency × reuse × token-savings vs. an ad-hoc bash call.
- Keep `run` thin and side-effect-honest (`Bun.file`/`Bun.write`/`Bun.$`/`fetch`). Resolve paths
  against `ctx.cwd`.

**Gotchas:**
- Tools don't know which model called them — provider tool-call shapes are normalized to
  `{ name, args }` before dispatch.
- `read`/`edit` are coupled to [hashline](hashline.md) — changing the anchor format touches both.
- `read` currently loads the whole file (no offset/limit yet); add pagination if large files bite.

**See:** [ARCHITECTURE_BRIEF §5](../ARCHITECTURE_BRIEF.md) · [hashline](hashline.md) · [DECISIONS D2/D4](../DECISIONS.md)
