# langpack (language packs)

**Status:** built (Phase 1.5), live-verified. Ships the **python** pack.
**What:** per-language **skills** (toolchain guidance injected into the system prompt when the language
is in play) + **post-edit hooks** (auto-run fixers/checkers on the files edited that turn) — both
native, [D24](../DECISIONS.md).
**Code:** `src/langpack.ts` + `skills/<tool>/SKILL.md`. Wired in `src/tui/app.ts` + `index.ts`; fed by
`ToolContext.touched`/`edited` (recorded by `read`/`write`/`edit`). Tests: `tests/langpack.test.ts`.

**How it works:**
- **Trigger:** touching a file of the pack's language (`read`/`write`/`edit` add its path to
  `ctx.touched`; writes/edits also add to `ctx.edited`). This is the same moment the LSP spawns, but
  independent of it (works with `--no-lsp`).
- **Skills** (`activePacks` → `langSkills`): the pack's `SKILL.md` bodies (frontmatter stripped) are
  **appended to the system prompt** once its language is active (cached). They live under `skills/`,
  **not** `skillRoots` — so they're hidden from the `/` popup until needed (progressive disclosure).
  First injection is the turn *after* the first touch (the prompt is fixed per turn).
- **Post-edit hooks** (`runHooks`): after an **EDIT-mode** turn that edited files of the pack, nerve runs
  the **fixers** (edit in place) then the **checkers** (report) on just those files, and prints a
  `⚙ post-edit hooks (<lang>)` summary. Python: `pyrefly infer` → `ruff check --select I --fix` →
  `ruff check --fix` → `ruff format`, then `pyrefly check` + `ruff check`.
- **Auto-fix loop** (D24): if the checkers still report issues, nerve feeds the summary back to the
  agent (`autofixPrompt`) for another turn so it fixes them — **bounded by `MAX_AUTOFIX` (2)**; a clean
  check stops it. Wired in `runAgentTurn` (TUI) / `runTurn` (headless), which recurse with `autoDepth+1`.

**How to change it:**
- **Add a language** = a `LANGPACK` entry (`extensions`, `skillFiles` under `skills/`, `fixers`,
  `checkers`) + the `SKILL.md` files. Binaries must be on PATH (a missing one is skipped + noted).
- Tune what auto-runs → the pack's `fixers`/`checkers` arrays. Tweak the guidance → the `SKILL.md` files.

**Gotchas:**
- Hooks **edit files at the turn boundary** — anchors from that turn go stale, but the next turn
  re-reads (hashline hard-rejects a stale anchor, [D3](../DECISIONS.md)). This is *why* auto-format is
  safe here and not mid-edit ([D10](../DECISIONS.md)).
- Fixers modify in place (`pyrefly infer` adds types, `ruff` removes unused imports / formats) — expect
  the agent's just-written code to come back cleaned.
- The hooks are only as strict as the **user's pyrefly/ruff config** — the default pyrefly "basic"
  preset (no `pyrefly.toml`) catches undefined names etc., not every type mismatch. Stricter project
  config → the auto-fix loop fires on more.
- The auto-fix loop is **bounded** (`MAX_AUTOFIX`) so the agent can't spin on un-fixable errors; ESC
  during an auto-fix turn stops it (the abort check skips hooks/continuation).
- Missing `pyrefly`/`ruff` → that step is skipped with a note (`uv tool install pyrefly`/`ruff`).

**See:** [DECISIONS D24](../DECISIONS.md) · [lsp](lsp.md) · [tools](tools.md) · [marimo](marimo.md)
