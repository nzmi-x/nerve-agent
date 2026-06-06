# modes

**Status:** built (Phase 1)
**What:** the PLAN/EDIT permission gate — the safety boundary on every tool call.
**Code:** `src/dispatch.ts` (tests: `tests/dispatch.test.ts`). One of the **hand-built** seams ([D11](../DECISIONS.md)).

**How it works:**
- Two modes: **PLAN** (read-only) and **EDIT** (everything auto). The mode is passed *into* `dispatch`
  from the human-controlled TUI — there is **no** `set_mode` tool and **no** model-writable flag. The
  model cannot escalate ([D4](../DECISIONS.md)).
- `allowed(tool, args, mode)` is the pure policy: EDIT → always ok; PLAN → `tool.readonly` ok, `bash`
  via `planBashAllowed`, everything else (mutations) refused.
- `planBashAllowed(command)`: rejects any shell **metacharacter** (`< > | ; & $ \` ( ) { }` newline),
  then requires the program to be an obviously-safe read-only one (`SAFE_PROGRAMS`), with `git`
  limited to read-only subcommands (`SAFE_GIT`: log/diff/status/show/blame/…, never commit/add/push/…).
- `dispatch(name, args, mode, ctx)` resolves the tool from the registry, gates it, runs it, and
  returns the result — or `Refused (MODE): …` / `Error: …`. It never throws and never mutates the mode.

**How to change it:**
- Add a safe PLAN command → extend `SAFE_PROGRAMS` / `SAFE_GIT` (only if it's *obviously* read-only).
  Prefer building a dedicated `readonly` tool over loosening the bash filter ([AGENT_RULES §2](../AGENT_RULES.md), D2/D4).
- **Never** add a model-reachable path to change `mode`, and never relax `METACHAR` to fit one command.

**Gotchas:**
- The metachar filter is intentionally conservative: a quoted `;`/`$` in a legit filename/pattern is
  rejected too. That's the safe failure — switch to EDIT or use a structured tool.
- Glob chars (`* ? [ ]`) are allowed (they only expand paths for read commands).

**See:** [DECISIONS D4](../DECISIONS.md) · [DECISIONS D11 (hand-built seams)](../DECISIONS.md) · [tools](tools.md)
