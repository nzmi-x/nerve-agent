# context

**Status:** built (D42/D47/D48, delivering [D12](../DECISIONS.md)) — loads `CLAUDE.md` + `AGENTS.md` as context.
**What:** project/user memory layered onto the system prompt so nerve reads the repo's own guidance.
**Code:** `src/context.ts` (`loadProjectMemory` + `nestedMemory`) · folded into `sys` via `baseSystem()` +
`nestedMemory()` in `index.ts` / `src/tui/app.ts` (tests: `tests/context.test.ts`)

**How it works:**
- **Base** (`loadProjectMemory`, once) — the ecosystem dirs ([`ecosystemDirs`, D47](../DECISIONS.md)) reversed
  to least→most authoritative, each contributing its `CLAUDE.md`/`AGENTS.md`, then the project-root files
  (`./CLAUDE.md`, `./AGENTS.md`) last. Project (`.x`) over user (`~/.x`); nerve > claude > agent.
- **Nested** (`nestedMemory`, per turn, [D48](../DECISIONS.md)) — `**/CLAUDE.md` / `**/AGENTS.md`,
  **touched-driven**: for files the agent has read/edited, load their ancestor dirs' memory (strictly below
  cwd), shallow→deep. Claude Code's nearest-CLAUDE.md semantics without an eager whole-tree scan; reuses the
  D24 touched set. Part of the prefix, so a *new* subtree only shifts the cache the turn it's first touched.
- A line that is exactly `@<path>` is **inlined** (recursively, depth + cycle guarded) — nerve's own root
  `CLAUDE.md` is just `@.claude/CLAUDE.md`. Missing target → kept visible; already-included → dropped.
- **Whole-file injection** — no structured-section parsing/phase-injection ([D37](../DECISIONS.md)). Each file
  loads at most once. Base read fresh per turn in headless (edited memory hot-swaps); the TUI computes base once.
- **`<environment>` block** ([D55](../DECISIONS.md)) — `baseSystem` also injects a live block stating the OS
  (`/etc/os-release` PRETTY_NAME + `process.platform`), the project cwd, **nerve's own source dir** (reachable
  via `self:`), the shell, and the date. It explicitly says *POSIX paths, never assume Windows* — DeepSeek
  otherwise assumes a Windows box and invents `C:\…` paths to nerve.

**See:** [DECISIONS D42/D47/D48/D12/D55](../DECISIONS.md) · [skills](skills.md) · [tools](tools.md)
