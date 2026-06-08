# tools

**Status:** built (Phase 1.5) — read, write, edit, bash, ls, grep, glob, manual, ask_user, **lsp** ([D10](../DECISIONS.md), see [lsp](lsp.md)), **notebook** ([D23](../DECISIONS.md), see [marimo](marimo.md)), todo, fetch, **search** ([D33](../DECISIONS.md)), **task** ([D6](../DECISIONS.md) subagent)
**What:** the local tool set the model calls. Each is a plain object run as a direct Bun call —
no daemon, no RPC. The registry exposes them to the providers and to the dispatcher.
**Code:** `src/tools/types.ts` (the `Tool` contract) · `src/tools/registry.ts` · `src/tools/*.ts`
(tests: `tests/tools.test.ts`)

**How it works:**
- A `Tool` is `{ name, description, parameters (JSON Schema), readonly, deferrable?, run(args, ctx) }`.
  `run` returns the result string shown to the model; recoverable failures return an `Error: …`
  string rather than throwing.
- `readonly` drives PLAN-mode gating in the dispatcher ([D4](../DECISIONS.md)) — `read` is readonly,
  `write`/`edit` are not. In PLAN the registry also **advertises** only the PLAN-visible set (read-only +
  `bash`) via `toolSpecs(planOnly)` ([D39](../DECISIONS.md)); `planVisible` is the shared predicate the
  dispatcher enforces, so the model never sees a mutator it can't run. `deferrable?` ([D40](../DECISIONS.md))
  is reserved (no behavior yet) for future deferred loading.
- `registry.ts` assembles `tools`, `toolByName`, `planVisible`, and `toolSpecs(planOnly)` (the
  name/description/parameters the providers see — `run` never goes on the wire).
- Every tool result except `read` passes through `collapseRuns` ([D41](../DECISIONS.md)) in `dispatch`:
  runs of identical lines / 80+-char runs collapse to `⟨repeated N×⟩` / `⟨×N⟩`, so redundant output can't
  bloat context — the tail is never lost (vs. a truncating cap). The old per-tool output caps are gone.
- `read` emits `hashline.encode` (`LINE#HASH:content`); `edit` drives `hashline.applyEdits` and, on a
  stale anchor, returns the rejection + fresh anchors; on success (small files) it echoes updated
  anchors so the next edit needs no re-read. `write` creates parent dirs (`Bun.write`). On success both fire
  `ctx.onFileChange(path, old, new)` → the TUI shows an inline +/- diff of the change ([D49](../DECISIONS.md),
  `src/diff.ts`); **display-only**, the model's text result is unaffected.
- `bash` runs `$SHELL -c` (zsh on this setup, falls back to `zsh`) via `Bun.spawn` (combined
  stdout+stderr, 2-min kill timeout). The shell is verified at startup (`preflight`).
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
- `fetch` ([D28](../DECISIONS.md), SPA rendering [D54](../DECISIONS.md)) — Bun-native HTTP GET of a URL →
  **HTML to Markdown**, JSON pretty-printed, text as-is (`htmlToMarkdown` is pure/tested). `readonly` →
  PLAN-safe. Times out + skips downloads over 5 MB + binary. **JS-rendered pages (SPAs):** when a plain fetch
  comes back as a near-empty shell (`looksUnrendered`), it auto-renders in `Bun.WebView` (headless Chrome,
  zero deps — D54) and uses the rendered DOM; `render:true` forces it, `render:false` disables it. No browser
  on the box → it degrades to the plain result. Export is `fetchTool` (avoids shadowing global `fetch`).
- `search` ([D33](../DECISIONS.md)) — a thin sibling of `fetch` for when there's **no URL**: GETs
  `lite.duckduckgo.com/lite/?q=…` (minimal JS-free HTML) and parses the rows into a ranked
  `{title, url, snippet}` list; the agent then `fetch`es a result to read it. Unwraps DDG's `/l/?uddg=`
  redirect to the real URL; reuses fetch's entity `decode`. `parseResults` is pure/tested. `readonly` →
  PLAN-safe; included in the subagent toolset.
- `task` ([D6](../DECISIONS.md)) — **delegate to a subagent**: runs the loop on a fresh **ephemeral**
  session (`src/subagent.ts`), **read-only** (PLAN mode), with the registry's `readonly` tools **minus
  `task`/`askUser`/`todo`** (no recursion, no human), on the `subagent`-flagged cheap model, returning
  only the final summary (cap 8 k). `readonly` → PLAN-safe (it spawns a read-only agent). Abortable via
  `ctx.signal`. For context-heavy isolable lookups; do small/edit work inline instead.

**Discovery + hot-swap ([D7](../DECISIONS.md)/[D38](../DECISIONS.md)):** the active set is a **mutable**
`let tools` in `registry.ts`, **discovered** by scanning `src/tools/*.ts` (`Bun.Glob` over
`import.meta.dir`) — each module's `Tool`-shaped exports are collected (export names need not match the
tool name) and **sorted by name** for a deterministic spec order. `loadTools()` populates it once at boot
(`index.ts`); `reloadTools()` re-scans **cache-busted** (`import("./x.ts?t=…")`), so `/reload`/Ctrl+R picks
up edits to a tool's `run` **and newly-added tool files** live, no restart. On any failure (a bad import,
or a module that exports no Tool) the old set is **kept** (rollback, [D11](../DECISIONS.md)). `dispatch`
resolves via `toolByName` against the live set, so the swap needs no engine change. Keep tool files
re-import-safe (no top-level side effects).

**How to change it:**
- **Add a tool** = just drop a new `src/tools/<name>.ts` exporting a `Tool` — discovery
  ([D38](../DECISIONS.md)) picks it up at the next boot, and `/reload` makes it live with **no
  `registry.ts` edit**. Set `readonly` honestly. A tool must earn its rent ([D2](../DECISIONS.md)): high
  frequency × reuse × token-savings vs. an ad-hoc bash call. (A non-tool *helper* file placed under
  `src/tools/` must be listed in `NOT_TOOLS` in `registry.ts`, or the scan rejects it — loud over silent.)
- Keep `run` thin and side-effect-honest (`Bun.file`/`Bun.write`/`Bun.$`/`fetch`). Resolve paths
  via `resolvePath(ctx.cwd, p)` (`src/tools/resolve.ts`), **not** raw `resolve(ctx.cwd, p)` — that's
  what honors the `self:` prefix (target nerve's own source from any cwd, [D36](../DECISIONS.md), see
  [self](self.md)). `read`/`edit`/`write`/`ls`/`grep`/`glob` already do.

**Gotchas:**
- Tools don't know which model called them — provider tool-call shapes are normalized to
  `{ name, args }` before dispatch.
- `read`/`edit` are coupled to [hashline](hashline.md) — changing the anchor format touches both.
- `read` currently loads the whole file (no offset/limit yet); add pagination if large files bite.

**See:** [ARCHITECTURE_BRIEF §5](../ARCHITECTURE_BRIEF.md) · [hashline](hashline.md) · [DECISIONS D2/D4](../DECISIONS.md)
