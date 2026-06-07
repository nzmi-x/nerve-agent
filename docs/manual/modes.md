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
- **`PLAN_NOTE` (prompt-level, not authority).** In PLAN, the surfaces append `PLAN_NOTE` to the system
  prompt so the agent *knows* it's read-only and can **bail out early** — if a request needs edits/shell,
  it stops and tells the user to switch to EDIT instead of flailing against refusals. Pure guidance; the
  gate above is still what enforces the mode (the model can't change it, [D4](../DECISIONS.md)). EDIT gets
  no note. Wired in `runAgentTurn` (TUI) / `runTurn` (headless).
- **Destructive-command guard ([D18](../DECISIONS.md)).** Before the mode gate, `dispatch` runs the
  model's `bash` command through `dangerousCommand(cmd)` — a pure blocklist of catastrophic patterns
  (`rm -rf /`/`~`, fork bomb, `mkfs`, whole-disk `dd`, `> /dev/sd*`, writes to `/etc/passwd|shadow`,
  `curl|sh`). A match returns `Refused (guard): …` in **both** PLAN and EDIT. This is a safety *floor*,
  orthogonal to the mode tier: it never prompts, never changes the mode, and does **not** apply to the
  human's `!`-shell escape ([D14](../DECISIONS.md) — the human is trusted).

**How to change it:**
- Add a safe PLAN command → extend `SAFE_PROGRAMS` / `SAFE_GIT` (only if it's *obviously* read-only).
  Prefer building a dedicated `readonly` tool over loosening the bash filter ([AGENT_RULES §2](../AGENT_RULES.md), D2/D4).
- Add a destructive pattern to refuse → extend `DESTRUCTIVE` / `isRootWipe` (keep it conservative —
  a false positive blocks legit work; it's a floor, not a fence).
- **Never** add a model-reachable path to change `mode`, and never relax `METACHAR` to fit one command.

**Gotchas:**
- The metachar filter is intentionally conservative: a quoted `;`/`$` in a legit filename/pattern is
  rejected too. That's the safe failure — switch to EDIT or use a structured tool.
- Glob chars (`* ? [ ]`) are allowed (they only expand paths for read commands).

**See:** [DECISIONS D4](../DECISIONS.md) · [DECISIONS D11 (hand-built seams)](../DECISIONS.md) · [tools](tools.md)
