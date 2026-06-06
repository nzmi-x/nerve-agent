# tools

**Status:** built (Phase 1) — read, write, edit, bash, ls, grep, glob, manual, ask_user · `lsp` joins in Phase 2
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
- `bash` runs `$SHELL -c` (zsh on this setup, falls back to `zsh`) via `Bun.spawn` (combined
  stdout+stderr, 2-min kill timeout, output capped). The shell is verified at startup (`preflight`).
  `ls`/`glob`/`grep` are readonly search — `Bun.Glob` for matching, pure-JS line scan for grep
  (dependency-free; skips `node_modules`/`.git`/`references`/binary/huge files). `bash` is *not*
  interruptible by ESC yet (only the timeout stops it) — `ToolContext` has no signal.
- `manual` (self-docs, [D13](../DECISIONS.md)) serves `docs/manual/*.md` + `docs/*.md` + the `opentui`
  skill, resolved against nerve's **install dir** (`import.meta.dir`), not `cwd`. OpenTUI is lazy:
  `manual("opentui"[/<slug>])`. Topic index is the filesystem; manual pages win same-name collisions.
- `ask_user` ([D14](../DECISIONS.md)) asks the human a question via `ctx.ask` (the surface supplies it:
  the TUI renders an interactive picker, headless auto-recommends). `readonly` → usable in PLAN. The
  contract: 2–4 options, mark one `recommended` unless they're equivalent.

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
