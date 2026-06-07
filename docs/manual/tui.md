# tui

**Status:** built (Phase 1; sidebar D29 Phase 1.5). Base layout verified in a real terminal; the
**responsive sidebar + affordances/status need a verify pass** (no TTY in the build env).
**What:** the interactive terminal UI — a main column (transcript, autosuggest row, status line, input
with `@`/`!`/`/` affordances + an interactive `ask_user` picker) plus a collapsible sidebar.
**Code:** `src/tui/app.ts` (`runTui`) + `src/tui/affordances.ts` (parsing/suggestions, [D14](../DECISIONS.md)).

**How it works:**
- **Responsive row layout** ([D29](../DECISIONS.md)): the root is a flex **row** — a **`mainCol`**
  (`flexGrow:1`, `minWidth:0`) holding the stack below, plus a fixed **34-col sidebar**.
- **Theme** ([D30](../DECISIONS.md)): the palette comes from `src/tui/theme.ts` (`pickTheme()`), inheriting
  ghostty's Adwaita / Adwaita Dark by reading the GNOME `color-scheme` (`gsettings`) — `$NERVE_THEME=light|dark`
  forces it. It **live-follows** the system: a `gsettings monitor` subprocess re-themes the UI **in place**
  on a dark/light flip (palette reassigned, `SyntaxStyle` rebuilt, chrome recoloured, and every transcript
  line re-rendered from a stored thunk → zero loss). A flip mid-stream is deferred to turn end.
- Main column: a **bordered transcript** `Box` (rounded, title " ◆ &lt;title&gt; ") wrapping a `ScrollBox`
  (`stickyScroll: bottom`) · a **todo panel** ([D25](../DECISIONS.md): pinned, colored `☑ todos`, updated
  in place by the `todo` tool via `ctx.setTodos`; height 0 when empty) · a `popup` `Box` (autosuggest
  **or** ask picker, per-row bg highlight) · a **bordered input** `Box` (`❯` prompt + `Input`) · a styled
  status bar.
- **Sidebar** ([D29](../DECISIONS.md)): two stacked bordered panels — **session** (title · model · mode
  badge · cost · ctx · balance, mirroring the status bar) and **files** (this session's touched files,
  most-recent first; `✎` = written/edited, `·` = read-only). Built from the same fixed-pool-of-rows
  pattern as the todo panel; the files pool is height-capped so it never overflows. **`Ctrl+B`** toggles
  it; it **auto-hides below 100 cols** (guarded `renderer.on("resize")`). `renderSidebar()` is a no-op
  while hidden and is driven off `setStatus()` + the per-turn `langTouched`/`sessionEdited` sets — no
  engine bookkeeping. Resets with the session (`/drop`, `/resume`).
- **Assistant answers render as markdown** — a streaming `MarkdownRenderable` (`SyntaxStyle` from the
  palette) whose `.content` grows per delta, `streaming=false` on finish. User lines use the `t`/`fg`/
  `bold` template (green `❯`); reasoning dim/italic (`✻`); tool results dim (`⎿`); shell `$`. Lines are
  appended (`transcript.add`) and removed by id (`transcript.remove(id)`) for `/clear` & `/drop`.
- **Status bar:** `model · [MODE badge] · cost · ctx · bal` via `t` styled segments + a `bg` mode badge,
  fed by `UsageMeter` (on `usage` events) + `fetchBalance` (startup / `/model` / `/balance`). **Shown only
  when the sidebar is hidden** (the session panel carries the same fields, D29) — when the sidebar is up the
  bar collapses (`height 0`) and the streaming `●` shows in the session panel instead.
  See [usage](usage.md), [balance](balance.md).
- **Affordances** ([D14](../DECISIONS.md)): `@path` autocompletes files (reference-only); `!cmd` runs
  shell with **full authority, ungated, not added to the session**; `/cmd` runs a command. Autosuggest
  popup updates on every keystroke (`parseAffordance` → `at`/`slash` suggestions).
- **Commands:** `/help /model [id] /mode plan|edit /clear /compact [focus] /reload /sessions /resume [id] /drop /balance /quit`
  + **markdown command files** ([D16](../DECISIONS.md), `src/commands.ts`): a `/<name>` matching a
  `<name>.md` under any `commandRoots` dir (`~/.nerve/projects/<slug>/commands` · `./.claude/commands` ·
  `~/.nerve/commands` · `~/.claude/commands`, D22) expands its body (`$1`/`$@`/`$ARGUMENTS` substitution)
  and submits it as a prompt + **skills** ([D12](../DECISIONS.md), `skills.md`): `/<skill> [args]` loads
  that skill's `SKILL.md` on demand and runs it. Precedence on a name clash: built-in > command > skill.
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
  **toggle mode** when no popup) · ↑/↓ navigate · Shift+Tab mode · **Ctrl+B sidebar** · **Ctrl+R reload** ·
  ESC stop · Ctrl+C quit. **Ctrl+Shift+C is left for the terminal's copy** (never our quit). (`/exit`
  aliases `/quit`.)
- **No redundant logs:** state changes that already have a visible indicator don't also print a transcript
  line — mode (PLAN/EDIT badge), model (`/model`, shown in the bar/panel), and the sidebar toggle are silent.

**How to change it:**
- The parsing/suggestion/command *logic* is pure in `affordances.ts` (tested) — change behavior there;
  `app.ts` only renders + routes keys. For the OpenTUI API, `manual("opentui")`.
- New built-in `/command` → add to `BUILTIN_COMMANDS` (affordances) + a `case` in `runCommand`.
- New *file* command → drop a `<name>.md` in any `commandRoots` dir (e.g. `~/.nerve/commands` or
  `./.claude/commands`, D22); no code change. Expansion/discovery live in `src/commands.ts` (tested).

**Gotchas:**
- Interactive rendering isn't unit-testable — verify in a real terminal (`bun index.ts`). Watch:
  Tab-accept (if the Input eats Tab, switch to a consumed input handler), the popup row when empty
  (should be 0 height), and the ask picker blocking.
- **Sidebar (D29) needs a live pass:** confirm the main column keeps full width/usability with the
  sidebar hidden and on a narrow (<100-col) terminal; that the session/files panels size correctly and
  the files pool clips (no overflow past the bottom); that `Ctrl+B` toggles and resize re-applies the
  breakpoint. A non-TTY run falls back to **headless**, so the TUI path can't be exercised in the build env.
- ESC latency differs by terminal (Kitty protocol) — crisp in Ghostty, timing-based in VS Code.

**See:** [ARCHITECTURE_BRIEF §8](../ARCHITECTURE_BRIEF.md) · [affordances/D14](../DECISIONS.md) · [usage](usage.md) · [balance](balance.md)
