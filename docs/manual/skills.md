# skills

**Status:** discovery/listing built (Phase 1.5); invocation lands in Phase 2.
**What:** Claude-compatible skills — discover capabilities from the `skillRoots` and inject one on demand.
**Code:** `src/paths.ts` (`skillRoots`) + `src/tui/affordances.ts` (`discoverSkills`, frontmatter parse).

**How it works:**
- A skill is a folder with a `SKILL.md` whose YAML frontmatter has `name` + `description`.
- On startup nerve discovers skills from the `skillRoots` ([D22](../DECISIONS.md), most-specific first,
  dedup first-wins): `~/.nerve/projects/<slug>/skills` → `./.claude/skills` → `~/.nerve/skills` →
  `~/.claude/skills`. Only each skill's **name + description** sit in context (progressive disclosure).
- **Invoking** a skill injects the full `SKILL.md` body (and referenced files) for that turn (Phase 2).
- Discovery is a **pure function of the filesystem**.

**How to change it:**
- Add/remove a discovery root → edit `skillRoots` in `src/paths.ts`.
- Change what frontmatter is parsed → the parser in `affordances.ts`. Keep it to the **minimal subset**
  (`name`, `description`); advanced Claude frontmatter (`allowed-tools`, model pins) is deliberately
  ignored until a real need appears.
- A new skill needs **no code** — drop a folder with a `SKILL.md` under any skill root (e.g.
  `~/.nerve/skills` for global, or `~/.nerve/projects/<slug>/skills` for this project).

**Gotchas:**
- The bundled `opentui` skill is **not** loaded as a user-skill — it's reached through the `manual`
  tool on demand (see [tui](tui.md) / `manual("opentui")`), so it never costs context until the UI
  is touched.
- Keep `src/context.ts` re-import-safe (no top-level side effects) so `/reload` works.

**See:** [DECISIONS D12](../DECISIONS.md) · [ARCHITECTURE_BRIEF §7](../ARCHITECTURE_BRIEF.md)
