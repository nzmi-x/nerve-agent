# tui

**Status:** built (Phase 1; sidebar D29 Phase 1.5). Base layout verified in a real terminal; the
**responsive sidebar + affordances/status need a verify pass** (no TTY in the build env).
**What:** the interactive terminal UI — a main column (transcript, autosuggest row, status line, input
with `@`/`!`/`/` affordances + an interactive `ask_user` picker) plus a collapsible sidebar.
**Code:** `src/tui/app.ts` (`runTui`) + `src/tui/affordances.ts` (parsing/suggestions, [D14](../DECISIONS.md)) +
`src/tui/sidebar.ts` (the D29 dashboard — `createSidebar`/`render(state)`) · `theme.ts` (palette) · `format.ts` (string helpers).

**How it works:**
- **Responsive row layout** ([D29](../DECISIONS.md)): the root is a flex **row** — a **`mainCol`**
  (`flexGrow:1`, `minWidth:0`) holding the stack below, plus a fixed **34-col sidebar**.
- **Theme** ([D30](../DECISIONS.md)): the palette comes from `src/tui/theme.ts` (`pickTheme()`), inheriting
  ghostty's Adwaita / Adwaita Dark by reading the GNOME `color-scheme` (`gsettings`) — `$NERVE_THEME=light|dark`
  forces it. It **live-follows** the system: a `gsettings monitor` subprocess re-themes the UI **in place**
  on a dark/light flip (palette updated in place, `SyntaxStyle` rebuilt, chrome recoloured, and every transcript
  line re-rendered from a stored thunk → zero loss). A flip mid-stream is deferred to turn end.
- Main column: a **bordered transcript** `Box` (rounded, title " ◆ &lt;title&gt; ") wrapping a `ScrollBox`
  (`stickyScroll: bottom`) · a **todo panel** ([D25](../DECISIONS.md): pinned, colored `☑ todos`, updated
  in place by the `todo` tool via `ctx.setTodos`; **hidden by default — `Ctrl+T` toggles it** (`todoVisible`/
  `renderTodoPanel`), since the sidebar carries a 1-line summary; a turn that **ends with todos unfinished**
  triggers a **bounded auto-continue** ([D34](../DECISIONS.md)) — nerve re-prompts the model to keep going
  (≤8 rounds, stops on no progress / ESC) and prints a dim `· N todos still pending` hint only once it gives
  up with work left; type **while it runs** to **queue a steer** ([D46](../DECISIONS.md)) — the status shows
  `↳N queued` and the message injects as a user turn between turns, preempting auto-continue; ESC drops it) ·
  a `popup` `Box` (autosuggest
  **or** ask picker, per-row bg highlight) · a **bordered input** `Box` (`❯` prompt + `Input`) · a styled
  status bar.
- **Sidebar** ([D29](../DECISIONS.md)): stacked bordered panels, each with a **distinct accent border**
  (the title rides on the border colour — session=cyan, todos=accent, skills=magenta, lsp=accent,
  tools=green, subagents=yellow, files=orange, git=green; the transcript box is accent-blue).
  **session** tops the stack and now **carries the cwd + git branch** (task 3 — the old standalone cwd panel
  was merged in): working dir (starship-style `shortenPath`) · `⎇ branch · ● dirty · ↑↓` · model ·
  mode badge + thinking effort (`mode [EDIT]  think high`, D52) · cost · ctx · balance — the *session title*
  lives in the transcript box header, not here),
  **todos** (a **1-line summary** of the task list — `▸ done/total <current focus>`, the always-visible
  counterpart to the Ctrl+T full panel), **lsp** (spawned
  language servers + state `●`/`◌`/`✗`, from `Lsp.serverStatus()`), **tools** also shows the **post-edit
  hooks** (ruff/prettier/…) as they run, **skills** (the skills *loaded into context now* —
  always-on defaults + active language packs via `activeSkillNames`), **tools** (the main agent's tool calls
  this exchange + status `●`/`✓`/`✗`, fed by the loop's `onToolStart`/`onToolResult`), **subagents** (this
  exchange's `task` runs + status `●`/`✓`/`✗`, [D6](../DECISIONS.md)), and a bottom flex-grow slot that
  **`Ctrl+G` swaps between files ↔ git** ([D49](../DECISIONS.md)): **files** (touched files, most-recent
  first; `✎` written, `·` read-only) or **git** (branch/status header + a `git log --graph` of how branches
  relate). All use the same fixed-pool-of-rows pattern as the todo panel. **Panels with no value yet are
  hidden** ([D50](../DECISIONS.md)): a bordered box can't collapse to height 0, so `panelLayout`/`syncPanels`
  drop empty panels (todos/skills/lsp/tools/subagents, and files until a file is touched) **out of the layout**
  rather than draw an empty box — and **tools/subagents are transient**: reset at the start of each exchange
  and auto-hidden ~60 s after the turn, so they show *current* activity, not a session-long log. The files/git
  pool is height-capped (subtracting the visible panels above) so it never overflows. **`Ctrl+B`** toggles the sidebar; it **auto-hides below 100 cols** (guarded
  `renderer.on("resize")`). `renderSidebar()` is a no-op while hidden, driven off `setStatus()` + the
  per-turn `langTouched`/`sessionEdited`/`toolCalls`/`subagents` state — no engine bookkeeping beyond the
  loop's tool hooks. Resets with the session (`/drop`, `/resume`).
- **Assistant answers render as markdown** — a streaming `MarkdownRenderable` (`SyntaxStyle` from the
  palette) whose `.content` grows per delta, `streaming=false` on finish. User lines use the `t`/`fg`/
  `bold` template (green `❯`); reasoning dim/italic (`✻`); shell `$`. **Tool-result lines** are
  `⎿ <name>  <arg>` — the call's salient argument (`toolArgSummary`: `read app.ts`, `bash mkdir …`,
  `grep "foo"`), not the result dump — with the `⎿` + name **colored by outcome** (green/cyan ok, red on
  `Error`/`Refused`, with the error message tailing it). **Turn separation + density:** each new exchange
  gets a faint full-width `rule()` divider + blank lines (`lines.length>1` guard skips the first), and a
  blank line is inserted after a tool block before the next prose/reasoning (`proseGap`/`gapIfNeeded`), so
  steps and turns don't run together. Lines are appended (`transcript.add`) and removed by id
  (`transcript.remove(id)`) for `/clear` & `/drop`.
- **Chronological interleave (one turn = many steps).** A single `runAgentTurn` can be several
  model↔tool round-trips. The prose block is created **lazily** (on the first text delta) and **sealed
  when the next tool call starts** (`onToolStart` → `streaming=false`, `answer=null`; `reasoningLine`
  reset too) — so each step's prose opens a **fresh block below** that step's `⎿` tool lines, reading
  prose → tools → prose → tools in order, instead of pooling all prose at the top and all tool lines at
  the bottom. (`sealBlock` closes the final block in the `finally`; a free helper because TS can't narrow
  the closure-mutated `answer`.)
- **Status bar:** `cwd · ⎇ branch · model · [MODE badge] · think <effort> · cost · ctx · bal` via `t` styled segments + a
  `bg` mode badge, fed by `UsageMeter` (on `usage` events) + `fetchBalance` (startup / `/model` / `/balance`).
  **Shown only when the sidebar is hidden** (the session panel carries the same fields, D29) — when the
  sidebar is up the bar collapses (`height 0`) and the indicator shows in the session panel instead. The
  **cwd + branch are mirrored here** (task 3) because the sidebar is otherwise their only home; the `t`
  template stays **flat** (a nested `t` renders as `[object Object]`), so each branch piece is its own
  conditional chunk. See [usage](usage.md), [balance](balance.md).
- **Working indicator (is it alive?):** while a turn runs, a **static `●` bullet** + `working` shows on
  whichever surface is visible (session panel with the sidebar up, status bar otherwise). It used to be an
  animated braille spinner re-rendered every ~90ms, but that repaint **lagged** when the sidebar was hidden
  (the wider status bar repaints), so it's now a static bullet (task 2 — no `activityTimer`). On **ESC** the
  label flips to a red **`stopping…`** immediately (`aborting` latch, re-rendered right there) so the keypress
  visibly registers before the in-flight stream/tool unwinds; when the turn ends the indicator **disappears**
  (`busy=false`). `aborting` resets at the start of the next turn.
- **Affordances** ([D14](../DECISIONS.md)): `@path` autocompletes files (reference-only); `!cmd` runs
  shell with **full authority, ungated, not added to the session**; `/cmd` runs a command. Autosuggest
  popup updates on every keystroke (`parseAffordance` → `at`/`slash` suggestions). An `@`-ref to an **image**
  (`.png/.jpg/.webp/.heic/.heif`) **attaches it to a Gemini turn** ([D53](../DECISIONS.md)): `submit`'s
  `prepareImages` reads the bytes (request-scoped, not persisted), swaps the ref for a `[image: name]`
  placeholder, and threads it to the turn; on a text-only model (DeepSeek) it's dropped with a warning.
- **Paste shortening:** a long (>200 char) or multi-line paste collapses to a `[Pasted N lines #id]`
  token **at the cursor** (so the caret moves past it and you keep typing), with the full text stashed
  under that id. On send, `expandPastes` substitutes each surviving token back **by id** — so dropping a
  token simply drops that paste (no effect on the others, undo-safe), and tokens needn't stay in paste order.
  A token is **atomic on delete**: backspacing *any* character of it removes the whole token, never a broken
  `[Pasted …]` (`dropBrokenPaste`, diffed against the prior input in `onContentChange`). Logic in
  `affordances.ts` (`pasteToken`/`expandPastes`/`dropBrokenPaste`, tested); the `paste` event handler in
  `app.ts` does the insert.
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
  and stays open to drill in. With no popup, Enter just sends. · **Tab accepts a suggestion** (it does
  **not** toggle the mode — only **Shift+Tab** / `/mode` do, to avoid an accidental mode flip) · ↑/↓
  navigate · **Ctrl+↑/↓ (or Alt+↑/↓) scroll the transcript** (`key.preventDefault` so the key doesn't also
  hit the input; the ScrollBox drops sticky-bottom on manual scroll) · **Ctrl+B sidebar** · **Ctrl+T todo
  list** · **Ctrl+G git/files** · **Ctrl+R reload** · ESC stop · Ctrl+C quit. (`/exit` aliases `/quit`.) Scroll keys are
  deliberately ones ghostty **passes to the app** and the input's Textarea doesn't bind — **PgUp/PgDn were
  dropped** (terminals like ghostty grab them for their own scrollback, so they never arrived); `Shift+↑/↓`
  is avoided too (the input uses it for text-select).
- **The terminal owns the mouse + clipboard** (`useMouse:false` + `useKittyKeyboard:null`): native selection,
  `Ctrl+Shift+C/V`, and the right-click menu are the terminal's, not the app's. Mouse capture is **off for
  good** — no runtime toggle: the side panels break rectangular selection, so capturing the wheel would cost
  native select + right-click copy for a scroll the keyboard already covers (Ctrl/Alt+↑/↓) — a bad trade.
  `Shift+Enter` still can't be distinguished from `Enter` without Kitty (newline is Alt+Enter). See the
  [terminal-owns-the-mouse micro-default](../DECISIONS.md).
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
  back-tab (`ESC[Z`) — if it stops toggling, **`/mode`** is the fallback (plain Tab no longer toggles).
- **Scroll keys can be grabbed by the terminal:** ghostty binds `shift+page_up/down` (scrollback),
  `ctrl+page_up/down` (tabs), `shift+home/end` (scroll) — those never reach the app (`ghostty
  +list-keybinds` lists them). **Plain PgUp/PgDn turned out not to arrive either in practice, so they were
  removed**; nerve scrolls on **Ctrl/Alt+↑/↓** (verified arriving).

**See:** [ARCHITECTURE_BRIEF §8](../ARCHITECTURE_BRIEF.md) · [affordances/D14](../DECISIONS.md) · [usage](usage.md) · [balance](balance.md)
