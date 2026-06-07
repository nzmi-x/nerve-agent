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
- **Sidebar** ([D29](../DECISIONS.md)): stacked bordered panels, each with a **distinct accent border**
  (the title rides on the border colour — session=cyan, skills=magenta, tools=green, subagents=yellow,
  files=orange; the transcript box is accent-blue). **session** (model · mode badge · cost · ctx · balance —
  the *session title* lives in the transcript box header, not here), **skills** (the skills *loaded into context now* —
  always-on defaults + active language packs via `activeSkillNames`), **tools** (the main agent's tool calls
  this session + status `●`/`✓`/`✗`, fed by the loop's `onToolStart`/`onToolResult`), **subagents** (this
  session's `task` runs + status `●`/`✓`/`✗`, [D6](../DECISIONS.md)), and **files** (touched files,
  most-recent first; `✎` written, `·` read-only — `flexGrow` fills the rest). All use the same
  fixed-pool-of-rows pattern as the todo panel; each compact panel keeps a **`(none …)` placeholder** when
  empty (so it never collapses to a thin border), and the files pool is height-capped (subtracting the other
  panels) so it never overflows. **`Ctrl+B`** toggles the sidebar; it **auto-hides below 100 cols** (guarded
  `renderer.on("resize")`). `renderSidebar()` is a no-op while hidden, driven off `setStatus()` + the
  per-turn `langTouched`/`sessionEdited`/`toolCalls`/`subagents` state — no engine bookkeeping beyond the
  loop's tool hooks. Resets with the session (`/drop`, `/resume`).
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
- **Commands:** `/help /models /mode /clear /compact /reload /sessions /resume /drop /balance /quit`
  — **none take parameters**; what used to need an argument is now an **interactive picker** (`/help` is
  color-coded). System lines are consistently iconned: `·` info · `✦` ok · `⚠` warn · `✗` error.
  + **markdown command files** ([D16](../DECISIONS.md), `src/commands.ts`): a `/<name>` matching a
  `<name>.md` under any `commandRoots` dir (`~/.nerve/projects/<slug>/commands` · `./.claude/commands` ·
  `~/.nerve/commands` · `~/.claude/commands`, D22) expands its body (`$1`/`$@`/`$ARGUMENTS` substitution)
  and submits it as a prompt + **skills** ([D12](../DECISIONS.md), `skills.md`): `/<skill> [args]` loads
  that skill's `SKILL.md` on demand and runs it. Precedence on a name clash: built-in > command > skill.
- **Pickers:** `ask_user` and the parameter-commands share one popup picker (`openPicker`/`renderPicker`,
  next to the `ask_user` `renderAsk`): a list with **↑/↓ navigate · Enter = primary action · `d` = delete
  (where offered) · Esc close**; the current item is marked `●` and preselected. `ask_user` additionally
  blocks the turn until you choose (the recommended option is preselected).
- **Sessions:** **`/sessions`** opens the picker — **Enter resumes** the highlighted session, **`d` deletes**
  it (refuses the current — use `/drop`), and it re-lists after a delete. **`/resume`** just reloads the
  **last** session (the per-session choice lives in `/sessions` now). Resuming replays the messages
  (`renderHistory`); discovery via `src/sessions.ts`.
- **Model:** **`/models`** opens the model picker (current marked `●`, Enter to switch).
- **Hot-swap ([D7](../DECISIONS.md)):** `/reload` (or **Ctrl+R**) re-imports tools + interceptors from
  disk (cache-busted), conversation preserved; `reload()` calls `reloadTools()` + re-imports
  `interceptors.ts`, refreshes the provider specs, and on failure keeps the running set (rollback).
  Takes effect from the next turn.
- **Keys:** Enter with a popup open **accepts the highlighted suggestion** before acting — a `/`
  command runs (`/ex`↵ → `/exit`); an `@` **file** completes and sends, an `@` **directory** completes
  and stays open to drill in. With no popup, Enter just sends. · **Tab accept suggestion** (or
  **toggle mode** when no popup) · ↑/↓ navigate · Shift+Tab mode · **PgUp/PgDn scroll** · **Ctrl+B sidebar** ·
  **Ctrl+R reload** · ESC stop · Ctrl+C quit. (`/exit` aliases `/quit`.)
- **The terminal owns the mouse + clipboard** (`useMouse:false` + `useKittyKeyboard:null`): native
  selection, `Ctrl+Shift+C/V`, and the right-click menu are the terminal's, not the app's. So there's no
  mouse-wheel scroll (PgUp/PgDn instead), and `Shift+Enter` can't be distinguished from `Enter` without
  Kitty (a multi-line newline would be Alt+Enter). See the [terminal-owns-the-mouse micro-default](../DECISIONS.md).
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
- ESC latency is now **timing-based everywhere** (Kitty disambiguation is off) — a lone ESC is
  recognized after a short delay vs. an escape sequence. Fine in Ghostty.
- **Verify the keybinds still parse without Kitty**: Shift+Tab (mode) relies on the terminal's legacy
  back-tab (`ESC[Z`) — if it stops toggling, plain Tab (no popup) and `/mode` are the fallbacks.

**See:** [ARCHITECTURE_BRIEF §8](../ARCHITECTURE_BRIEF.md) · [affordances/D14](../DECISIONS.md) · [usage](usage.md) · [balance](balance.md)
