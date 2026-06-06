# skills

**Status:** spec (code lands in Phase 2)
**What:** Claude-compatible skills — discover capabilities from `~/.claude/skills` and
`./.claude/skills` and inject one on demand.
**Code:** `src/context.ts` (discovery + layering; shared with CLAUDE.md loading)

**How it works:**
- A skill is a folder with a `SKILL.md` whose YAML frontmatter has `name` + `description`.
- On startup nerve discovers skills from `~/.claude/skills/*/` (user) and `./.claude/skills/*/`
  (project) and keeps only each skill's **name + description** in context (progressive disclosure).
- **Invoking** a skill injects the full `SKILL.md` body (and referenced files) for that turn.
- Discovery is a **pure function of the filesystem**, so it hot-swaps with `/reload`.

**How to change it:**
- Add/remove a discovery root → edit the roots list in `src/context.ts`.
- Change what frontmatter is parsed → the skill-metadata parser in `src/context.ts`. Keep it to the
  **minimal subset** (`name`, `description`); advanced Claude frontmatter (`allowed-tools`, model
  pins) is deliberately ignored until a real need appears.
- A new skill needs **no code** — drop a folder with a `SKILL.md` under `.claude/skills/`.

**Gotchas:**
- The bundled `opentui` skill is **not** loaded as a user-skill — it's reached through the `manual`
  tool on demand (see [tui](tui.md) / `manual("opentui")`), so it never costs context until the UI
  is touched.
- Keep `src/context.ts` re-import-safe (no top-level side effects) so `/reload` works.

**See:** [DECISIONS D12](../DECISIONS.md) · [ARCHITECTURE_BRIEF §7](../ARCHITECTURE_BRIEF.md)
