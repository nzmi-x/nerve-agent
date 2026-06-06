# tui

**Status:** built (Phase 1). Base layout verified in a real terminal; affordances/status need a verify pass.
**What:** the interactive terminal UI — transcript, autosuggest row, status line, and an input with
`@`/`!`/`/` affordances + an interactive `ask_user` picker.
**Code:** `src/tui/app.ts` (`runTui`) + `src/tui/affordances.ts` (parsing/suggestions, [D14](../DECISIONS.md)).

**How it works:**
- Paneled layout (Tokyo-Night palette): a **bordered transcript** `Box` (rounded, title " ◆ nerve ")
  wrapping a `ScrollBox` (`stickyScroll: bottom`) · a `popup` `Box` (autosuggest **or** ask picker, with
  per-row bg highlight) · a **bordered input** `Box` (`❯` prompt + `Input`) · a styled status bar.
- **Assistant answers render as markdown** — a streaming `MarkdownRenderable` (`SyntaxStyle` from the
  palette) whose `.content` grows per delta, `streaming=false` on finish. User lines use the `t`/`fg`/
  `bold` template (green `❯`); reasoning dim/italic (`✻`); tool results dim (`⎿`); shell `$`. Lines are
  appended (`transcript.add`) and removed by id (`transcript.remove(id)`) for `/clear` & `/drop`.
- **Status bar:** `model · [MODE badge] · cost · ctx · bal` via `t` styled segments + a `bg` mode badge.
- **Status line:** `model · mode · cost · context% · balance`, fed by `UsageMeter` (on `usage` events)
  + `fetchBalance` (startup / `/model` / `/balance`). See [usage](usage.md), [balance](balance.md).
- **Affordances** ([D14](../DECISIONS.md)): `@path` autocompletes files (reference-only); `!cmd` runs
  shell with **full authority, ungated, not added to the session**; `/cmd` runs a command. Autosuggest
  popup updates on every keystroke (`parseAffordance` → `at`/`slash` suggestions).
- **Commands:** `/help /model [id] /mode plan|yolo /clear /drop /balance /resume /quit` + skill listing.
- **`ask_user`:** the loop's `ctx.ask` opens an interactive picker (↑/↓ + Enter) in the popup and
  blocks the turn until you choose; the recommended option is preselected.
- **Keys:** Enter send · **Tab accept suggestion** · ↑/↓ navigate · Shift+Tab mode · ESC stop · Ctrl+C quit.

**How to change it:**
- The parsing/suggestion/command *logic* is pure in `affordances.ts` (tested) — change behavior there;
  `app.ts` only renders + routes keys. For the OpenTUI API, `manual("opentui")`.
- New `/command` → add to `BUILTIN_COMMANDS` (affordances) + a `case` in `runCommand`.

**Gotchas:**
- Interactive rendering isn't unit-testable — verify in a real terminal (`bun index.ts`). Watch:
  Tab-accept (if the Input eats Tab, switch to a consumed input handler), the popup row when empty
  (should be 0 height), and the ask picker blocking.
- ESC latency differs by terminal (Kitty protocol) — crisp in Ghostty, timing-based in VS Code.

**See:** [ARCHITECTURE_BRIEF §8](../ARCHITECTURE_BRIEF.md) · [affordances/D14](../DECISIONS.md) · [usage](usage.md) · [balance](balance.md)
