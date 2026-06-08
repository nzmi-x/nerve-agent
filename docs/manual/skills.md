# skills

**Status:** discovery + listing + **invocation** built (Phase 1.5).
**What:** Claude-compatible skills — discover capabilities from the `skillRoots`, list them in the `/`
popup, and invoke one on demand (load its `SKILL.md` for that turn).
**Code:** `src/paths.ts` (`skillRoots`) + `src/tui/affordances.ts` (`discoverSkills`/`loadSkillBody`).
Invocation is wired in `src/tui/app.ts` (`invokeSkill`). Tests: `tests/affordances.test.ts`.

**How it works:**
- A skill is a folder with a `SKILL.md` whose YAML frontmatter has `name` + `description`.
- On startup nerve discovers skills from the `skillRoots` ([D47](../DECISIONS.md), most-authoritative first,
  dedup first-wins): the ecosystem ladder — `~/.nerve/projects/<slug>/skills` (personal per-project) → then
  **nerve > claude > agent**, project over user (`.nerve` → `~/.nerve` → `.claude` → `~/.claude` → `.agent` →
  `~/.agent`, each `/skills`). Only each skill's **name + description** (and the `SKILL.md` path) sit in context —
  the body isn't read until invoked (**progressive disclosure**).
- **Invoking** `/<skill> [args]` ([D12](../DECISIONS.md)): `loadSkillBody` reads the `SKILL.md`,
  strips frontmatter, `expandCommand` substitutes args (like a slash command, [D16](../DECISIONS.md)),
  and it runs as a turn — the model gets the full instructions; the transcript shows a compact
  `❯ /<skill> (skill)`, not the whole body. Built-in commands and file commands win on a name clash.
- Relevant skills are *also* injected **automatically** by the language packs ([D24](../DECISIONS.md))
  when their language is in play — `/<skill>` is the manual escape hatch.
- Discovery + body-load are **pure functions of the filesystem**.

**How to change it:**
- Add/remove a discovery root → edit `skillRoots` in `src/paths.ts`.
- Change what frontmatter is parsed → the parser in `affordances.ts`. Keep it to the **minimal subset**
  (`name`, `description`); advanced Claude frontmatter (`allowed-tools`, model pins) is deliberately
  ignored until a real need appears.
- A new skill needs **no code** — drop a folder with a `SKILL.md` under any skill root (e.g.
  `~/.nerve/skills` for global, or `~/.nerve/projects/<slug>/skills` for this project).

**Gotchas:**
- The bundled `opentui` skill *is* discoverable (it lives in `./.claude/skills/opentui`), but its
  full reference is reached through the `manual` tool (`manual("opentui")`), so it doesn't cost context
  until the UI is touched.
- A skill body is submitted as a **user turn** (persisted to the session) — invoking a long skill adds
  that text to context. Built-in/file commands shadow a skill of the same name.

**See:** [DECISIONS D12](../DECISIONS.md) · [ARCHITECTURE_BRIEF §7](../ARCHITECTURE_BRIEF.md)
