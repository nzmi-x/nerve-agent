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
- **Commands:** `/help /model [id] /mode plan|edit /clear /compact [focus] /reload /sessions /resume [id] /drop /balance /quit` + skill listing
  + **markdown command files** ([D16](../DECISIONS.md), `src/commands.ts`): a `/<name>` matching a
  `<name>.md` under `~/.claude/commands`, `./.claude/commands`, or `./.nerve/commands` expands its body
  (`$1`/`$@`/`$ARGUMENTS` substitution) and submits it as a prompt. A built-in name always wins.
- **`ask_user`:** the loop's `ctx.ask` opens an interactive picker (↑/↓ + Enter) in the popup and
  blocks the turn until you choose; the recommended option is preselected.
- **Sessions:** `/resume [id]` closes the current session and reloads an existing one (default = most
  recent that isn't current), replaying its messages into the transcript (`renderHistory`). `/sessions`
  lists them (id · #msgs · age · first-message preview, current marked ●); `/sessions delete <id>`
  removes one (refuses the current — use `/drop`). Discovery via `src/sessions.ts`.
- **Hot-swap ([D7](../DECISIONS.md)):** `/reload` (or **Ctrl+R**) re-imports tools + interceptors from
  disk (cache-busted), conversation preserved; `reload()` calls `reloadTools()` + re-imports
  `interceptors.ts`, refreshes the provider specs, and on failure keeps the running set (rollback).
  Takes effect from the next turn.
- **Keys:** Enter with a popup open **accepts the highlighted suggestion** before acting — a `/`
  command runs (`/ex`↵ → `/exit`); an `@` **file** completes and sends, an `@` **directory** completes
  and stays open to drill in. With no popup, Enter just sends. · **Tab accept suggestion** (or
  **toggle mode** when no popup) · ↑/↓ navigate · Shift+Tab mode · **Ctrl+R reload** · ESC stop ·
  Ctrl+C quit. (`/exit` aliases `/quit`.)

**How to change it:**
- The parsing/suggestion/command *logic* is pure in `affordances.ts` (tested) — change behavior there;
  `app.ts` only renders + routes keys. For the OpenTUI API, `manual("opentui")`.
- New built-in `/command` → add to `BUILTIN_COMMANDS` (affordances) + a `case` in `runCommand`.
- New *file* command → drop a `<name>.md` in `./.nerve/commands` (or `./.claude/commands`); no code
  change. Expansion/discovery live in `src/commands.ts` (tested).

**Gotchas:**
- Interactive rendering isn't unit-testable — verify in a real terminal (`bun index.ts`). Watch:
  Tab-accept (if the Input eats Tab, switch to a consumed input handler), the popup row when empty
  (should be 0 height), and the ask picker blocking.
- ESC latency differs by terminal (Kitty protocol) — crisp in Ghostty, timing-based in VS Code.

**See:** [ARCHITECTURE_BRIEF §8](../ARCHITECTURE_BRIEF.md) · [affordances/D14](../DECISIONS.md) · [usage](usage.md) · [balance](balance.md)
