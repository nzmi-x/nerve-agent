# context

**Status:** built (D42, delivering [D12](../DECISIONS.md)) — loads `CLAUDE.md` + `AGENTS.md` as agent context.
**What:** project/user memory layered onto the system prompt so nerve reads the repo's own guidance.
**Code:** `src/context.ts` (`loadProjectMemory`) · folded in by `baseSystem()` in `index.ts`
(tests: `tests/context.test.ts`)

**How it works:**
- Sources, most-general → most-specific (project augments user, [D12](../DECISIONS.md)):
  `~/.claude/CLAUDE.md` → `./CLAUDE.md` → `./.claude/CLAUDE.md` → `./AGENTS.md`. Each loads at most once.
- A line that is exactly `@<path>` is **inlined** (recursively, depth + cycle guarded) — nerve's own root
  `CLAUDE.md` is just `@.claude/CLAUDE.md`. A missing/cyclic/already-seen target leaves the line untouched.
- **Whole-file injection** — no structured-section parsing or phase-injection ([D37](../DECISIONS.md)
  rejected those). The base system prompt = `prompts/system.md` **+** the loaded memory.
- Read fresh each turn in headless (an edited memory file hot-swaps); the TUI computes it once at startup.

**See:** [DECISIONS D42/D12](../DECISIONS.md) · [skills](skills.md) · [tools](tools.md)
