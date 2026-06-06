# tui

**Status:** spec (code lands in Phase 1)
**What:** the terminal UI — a streaming transcript, reasoning fold, prompt, and status line, built
on OpenTUI (our only dependency).
**Code:** `src/tui/app.ts`

**How it works:**
- OpenTUI **imperative core** (`@opentui/core`): `createCliRenderer`, then `Box`/`Text` +
  `markdown`/`code`/`diff`/`scrollbox`/`input` factory functions (first arg props, rest children).
- A scrolling transcript; a streaming region fed by `text` deltas as they arrive; a dimmed/foldable
  region fed by `reasoning` deltas (from the reasoning-router interceptor); an `input`/`textarea`.
- A **status line** shows the active mode (PLAN/YOLO) and model profile.
- Render is a cheap function of `session` state, called per applied event; OpenTUI diffs the frame.
- Keybinds: `Shift+Tab` (mode), `Ctrl+R`/`/reload` (hot-swap), `ESC` (abort turn), `Ctrl+C` (exit).

**How to change it:**
- Edit `src/tui/app.ts`. Stay on the **imperative core** by default; only reach for a React/Solid
  binding if a screen genuinely needs reactive state — and justify it.
- **For the OpenTUI API, call `manual("opentui")`** — it lazy-loads the vendored skill's `SKILL.md`
  routing table + `docs/**/*.mdx` (it is *not* always in context). Drill into sub-pages, e.g.
  `manual("opentui/core-concepts/layout")`, `manual("opentui/components/scrollbox")`.

**Gotchas:**
- `--watch` (full restart) is the dev loop for the TUI, not `--hot` — a stateful renderer doesn't
  survive in-place module swaps cleanly.
- Naive repaint-per-delta is fine to start (OpenTUI diffs); optimize only if it shows up.

**See:** [ARCHITECTURE_BRIEF §8](../ARCHITECTURE_BRIEF.md) · OpenTUI skill: `.claude/skills/opentui/SKILL.md`
