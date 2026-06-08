# git

**Status:** built ([D49](../DECISIONS.md)) — read-only git for the TUI's location + git panels, and the
inline agent-edit diff.
**What:** the always-on cwd/branch panel, the `Ctrl+G` git view (a `git log --graph` of how branches relate),
and the +/- diff shown when the agent edits a file.
**Code:** `src/git.ts` (read-only git) · `src/diff.ts` (line differ) · `shortenPath`/`displayPath` in `src/tui/format.ts` ·
`src/tui/sidebar.ts` (panels) · `src/tui/app.ts` (`renderEditDiff`/`refreshGit`/Ctrl+G)
(tests: `tests/git.test.ts`, `tests/diff.test.ts`, `tests/format.test.ts`)

**How it works:**
- **`git.ts` — read-only only.** `gitBranch` reads `.git/HEAD` directly (cheap, no subprocess);
  `gitStatus` / `gitGraph` spawn `git status -sb` / `log --graph --all` (`Bun.spawn`, like `bash.ts`).
  The pure parsers (`parseStatus`/`parseGraph`) are tested. Off a repo → null/empty. No mutation
  (consistent with the `SAFE_GIT` set in `dispatch.ts`).
- **Location panel** (top of the sidebar): `shortenPath(cwd)` (`$HOME → ~`, deep paths → `…/last/three`) +
  `⎇ branch · ● dirty · ↑a ↓b`. Branch + status are cached in `app.ts` (`refreshGit`) and refreshed at
  startup, on Ctrl+G, and after **anything that can change git state** — every turn, the `!`-shell escape,
  and each `bash`/`edit`/`write` tool result (so a commit or working-tree change shows **live**, not only at
  turn end). `refreshGit` **coalesces**: a burst of edits collapses to the in-flight run + one trailing run,
  so it never spawns N `git status` subprocesses at once.
- **Git view** (`Ctrl+G` or `/git`): the sidebar's bottom flex-grow slot **swaps `files` ↔ `git`**
  (`bottomView`; `setBottom` add/removes the panel from the layout — a bordered box can't collapse to height
  0). The git panel shows the branch/status header,
  a `git log --graph --all` of how branches relate (rail · hash · subject), **capped** to the panel height (a
  bordered box can't scroll). The graph is fetched only while the view is open (a subprocess).
- **Agent-edit diffs** (like Claude Code, **not** `git diff`): `edit`/`write` call `ctx.onFileChange(path,
  old, new)`; the TUI renders `diffRows(old, new)` as **colored, line-numbered `+`/`-` rows** under a bold
  filename header, and skips the generic tool-result line. **Display-only** — the model's tool result (anchors
  + diagnostics) is unchanged. `diffRows`/`diffStat` (`src/diff.ts`) are a zero-dep LCS line differ.

**See:** [DECISIONS D49](../DECISIONS.md) · [tui](tui.md) · [tools](tools.md)
