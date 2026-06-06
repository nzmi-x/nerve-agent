# tools

**Status:** built (Phase 1.5) — read, write, edit, bash, ls, grep, glob, manual, ask_user, **lsp** ([D10](../DECISIONS.md), see [lsp](lsp.md)), **notebook** ([D23](../DECISIONS.md), see [marimo](marimo.md))
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
- `lsp` ([D10](../DECISIONS.md), [lsp](lsp.md)) — read-only language-server queries (definition/
  references/hover/documentSymbol/…) via `ctx.lsp`. **Separately**, `read`/`write`/`edit` append
  language-server **diagnostics** to their results (the agent sees breakage immediately). Both no-op
  when `ctx.lsp` is absent (`--no-lsp`, or no server for the file's language).
- `notebook` ([D23](../DECISIONS.md), [marimo](marimo.md)) — run a **marimo** notebook (`.py`) headlessly
  via uv and report each cell's output/error. `readonly:false` (executes code → EDIT only). Editing
  cells uses the normal file tools (marimo notebooks are pure Python).
- `todo` ([D25](../DECISIONS.md)) — the agent's task list for multi-step work (pass the full list each
  call). `readonly` → PLAN-safe (only UI state). Shown via `ctx.setTodos`: a **pinned colored panel**
  in the TUI, a printed checklist headless.

**Hot-swap ([D7](../DECISIONS.md)):** the active set is a **mutable** `let tools` in `registry.ts`;
`reloadTools()` re-imports every entry in `TOOL_MODULES` **cache-busted** (`import("./x.ts?t=…")`) and
swaps it — so `/reload`/Ctrl+R picks up edits to a tool's `run` live, no restart. On any failure the old
set is **kept** (rollback, [D11](../DECISIONS.md)). `dispatch` resolves via `toolByName` against the live
set, so the swap needs no engine change. Keep tool files re-import-safe (no top-level side effects).

**How to change it:**
- **Add a tool** = a new `src/tools/<name>.ts` exporting a `Tool`, then add it to `tools` **and**
  `TOOL_MODULES` in `registry.ts` (the latter so it hot-reloads). Set `readonly` honestly. A tool must
  earn its rent ([D2](../DECISIONS.md)): high frequency × reuse × token-savings vs. an ad-hoc bash call.
- Keep `run` thin and side-effect-honest (`Bun.file`/`Bun.write`/`Bun.$`/`fetch`). Resolve paths
  against `ctx.cwd`.

**Gotchas:**
- Tools don't know which model called them — provider tool-call shapes are normalized to
  `{ name, args }` before dispatch.
- `read`/`edit` are coupled to [hashline](hashline.md) — changing the anchor format touches both.
- `read` currently loads the whole file (no offset/limit yet); add pagination if large files bite.

**See:** [ARCHITECTURE_BRIEF §5](../ARCHITECTURE_BRIEF.md) · [hashline](hashline.md) · [DECISIONS D2/D4](../DECISIONS.md)
