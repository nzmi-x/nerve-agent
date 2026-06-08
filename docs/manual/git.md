# git

**Status:** built ([D49](../DECISIONS.md)) — read-only git for the TUI's location + git panels, and the
inline agent-edit diff.
**What:** the always-on cwd/branch panel, the `Ctrl+G` git view (branches + commits), and the +/- diff shown
when the agent edits a file.
**Code:** `src/git.ts` (read-only git) · `src/diff.ts` (line differ) · `shortenPath` in `src/tui/format.ts` ·
`src/tui/sidebar.ts` (panels) · `src/tui/app.ts` (`renderEditDiff`/`refreshGit`/Ctrl+G)
(tests: `tests/git.test.ts`, `tests/diff.test.ts`, `tests/format.test.ts`)

**How it works:**
- **`git.ts` — read-only only.** `gitBranch` reads `.git/HEAD` directly (cheap, no subprocess);
  `gitStatus`/`gitBranches`/`gitLog` spawn `git status -sb` / `branch` / `log` (`Bun.spawn`, like `bash.ts`).
  The pure parsers (`parseStatus`/`parseBranches`/`parseLog`) are tested. Off a repo → null/empty. No mutation
  (consistent with the `SAFE_GIT` set in `dispatch.ts`).
- **Location panel** (top of the sidebar): `shortenPath(cwd)` (`$HOME → ~`, deep paths → `…/last/three`) +
  `⎇ branch · ● dirty · ↑a ↓b`. Branch + status are cached in `app.ts` (`refreshGit`) and refreshed at
  startup / after each turn / on Ctrl+G.
- **Git view** (`Ctrl+G` or `/git`): the sidebar's bottom flex-grow slot **swaps `files` ↔ `git`**
  (`bottomView`; the inactive panel collapses to height 0). The git panel shows the branch/status header,
  local branches (● current), and recent commits (hash + subject). Branches/log are fetched only while the
  view is open (they're subprocesses).
- **Agent-edit diffs** (like Claude Code, **not** `git diff`): `edit`/`write` call `ctx.onFileChange(path,
  old, new)`; the TUI renders `lineDiff(old, new)` as a syntax-highlighted ```diff block + a `✎ path +a -b`
  line, and skips the generic tool-result line. **Display-only** — the model's tool result (anchors +
  diagnostics) is unchanged. `lineDiff`/`diffStat` (`src/diff.ts`) are a zero-dep LCS line differ.

**See:** [DECISIONS D49](../DECISIONS.md) · [tui](tui.md) · [tools](tools.md)
