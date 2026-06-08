# self

**Status:** built (Phase 1.5) — the `self:` tool-path prefix ([D36](../DECISIONS.md))
**What:** how you (nerve) modify your **own** source — to adapt your tools, prompts, and docs to the
user's workflow — even while launched in some *other* project. This is the point of being self-hackable
([D7](../DECISIONS.md)): the user shouldn't have to `cd` into the nerve repo to tune you.
**Code:** `src/tools/resolve.ts` (`resolvePath`/`self:`) · `src/paths.ts` (`nerveSourceRoot`) ·
`src/tools/registry.ts` (`reloadTools`) (tests: `tests/resolve.test.ts`)

**The `self:` prefix:**
- A normal file path is relative to the **working dir** (the user's project). A path prefixed with
  `self:` instead resolves against nerve's **own source tree** — the repo it's running from — regardless
  of cwd. The remainder is repo-relative: `self:src/tools/grep.ts` → `<repo>/src/tools/grep.ts`.
- Works in every file tool: `read`, `edit`, `write`, `ls`, `grep`, `glob`. So
  `grep("X", "self:src")`, `read("self:prompts/system.md")`, `edit("self:src/tools/grep.ts", …)`.
- `read`/`grep`/`ls`/`glob` are read-only → usable in **PLAN** (inspect + plan a self-change). `edit`/
  `write` mutate → **EDIT mode only**: in PLAN you can design the change but not apply it ([D4](../DECISIONS.md)).

**The self-hack loop:**
1. `manual()` for the index, then `manual(<subsystem>)` for the page on what you're changing (e.g.
   `manual("tools")`, `manual("modes")`). Read the source with `read("self:…")`.
2. `edit`/`write` the source with `self:` paths. **Update the subsystem's `docs/manual/<x>.md` page in
   the same change** ([AGENT_RULES §2](../AGENT_RULES.md)).
3. Apply it:
   - **Tools** (`self:src/tools/*.ts`) and **interceptors** (`self:src/interceptors.ts`) hot-reload —
     run `/reload` (or the user hits `Ctrl+R`). `reloadTools` re-imports them cache-busted from disk,
     cwd-independent; a tool that fails to import **rolls back** to the running set ([D11](../DECISIONS.md)).
   - **Prompts** (`self:prompts/*.md`) are re-read fresh each turn — no reload needed.
   - **Engine** (`self:src/loop.ts`, providers, `dispatch.ts`, session, the registry/reload machinery
     itself) does **not** hot-swap by design — the user restarts nerve. No rebuild: it runs from source
     ([D35](../DECISIONS.md)), so a restart picks up the edit.
4. Verify: `bash("bun run typecheck")`, `bash("bun run test")` — run from the repo, e.g.
   `bash("cd <repo> && bun run typecheck")` or `bash` after the reload.

**Cautions:**
- **Global blast radius.** A self-edit changes nerve for *every* project, not just this one. `/reload`
  rolls back a tool that won't *import*, but not a logic bug, and engine edits have no rollback. Keep
  self-edits small and verify before relying on them.
- **Never author your own guardrails.** The PLAN/EDIT boundary (`src/dispatch.ts`), the destructive-bash
  floor ([D18](../DECISIONS.md)), and the hot-reload rollback are hand-built safety seams ([D11](../DECISIONS.md)).
  Don't weaken or route around them. There is no `set_mode` tool and there must never be one — the human
  owns the mode (`Shift+Tab`).

**See:** [tools](tools.md) · [modes](modes.md) · [interceptors](interceptors.md) ·
[DECISIONS D7/D11/D35/D36](../DECISIONS.md)
