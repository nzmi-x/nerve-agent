# Plans — speculative designs & integration guides

This file holds designs for things **not yet built**. Once a plan is implemented, its guide
graduates to `docs/manual/<x>.md` and its decision to `docs/DECISIONS.md`. Until then, this is
the scratchpad: no rotted docs, no stale DECISIONS entries.

---

## Herdr integration — report nerve state to the herdr multiplexer

**Status:** spec (not built)
**What:** Report nerve's live state (working/idle/blocked/done) to herdr's Unix socket, so herdr's sidebar shows nerve's real-time status alongside 14+ supported agents.

### Background

- herdr auto-detects agents via **process name + terminal output** — nerve already appears in the sidebar. But state is fuzzy (herdr doesn't know `working` vs `idle`).
- herdr exposes a **Unix socket** (`~/.config/herdr/herdr.sock`) accepting JSON-RPC calls, notably `pane.report_agent`.
- ~30-line module: connect via `Bun.connect({ path })`, send one newline-delimited JSON line, fire-and-forget.

### State mapping

| nerve lifecycle | herdr state | trigger point in `src/tui/app.ts` |
|---|---|---|
| Turn starts (busy=true) | `working` | `sendPrompt` line ~880 |
| Turn ends (busy=false) | `idle` | `sendPrompt` line ~897 |
| `ask_user` picker open | `blocked` | `ask()` line ~553 |
| ESC abort | `idle` | key handler line ~1274 |
| Shutdown | `done` | `shutdown()` line ~1138 |
| Compact starts | `working` | `compact()` line ~624 |

### Build plan

**Stage 1 — Socket reporter (~45 min)**

Create `src/herdr.ts` (~30 lines):
- Resolve socket path: env `$HERDR_SOCKET_PATH` → `~/.config/herdr/herdr.sock` (expand `~`)
- Detect pane_id from `$HERDR_PANE_ID` env (herdr sets this in panes it creates)
- Connect via `Bun.connect({ path: socketPath })` (Unix domain)
- Send `{"id":"nerve-N","method":"pane.report_agent","params":{"pane_id":"…","source":"nerve:tui","agent":"nerve","state":"…"}}`
- Fire-and-forget, errors silently ignored (herdr might not be running)

Hooks in `src/tui/app.ts` (~15 lines across 5 sites):
- Import `herdrState` at the top
- Call at each transition point
- Guard: skip if no socket path (`herdrSocketPath()` returns null)

Test: `tests/herdr.test.ts` — path resolution + message shape (no socket needed for unit test).

**Stage 2 — Custom status labels (optional)**
Report what nerve is doing: `custom_status: "thinking"` / tool name / `"asking"`.

**Stage 3 — herdr skill (optional)**
Write `.nerve/skills/herdr/SKILL.md` for community sharing — a skill other nerve users can install.

**Stage 4 — Native herdr integration plugin (future, herdr-side PR)**
For session restore (nerve → restart → resume previous session). Would need a herdr integration that installs a hook into nerve's config dir + a `nerve` entry in herdr's supported agents list. Not needed until session restore is a problem.

### What NOT to do

- Don't block the turn on socket I/O — fire-and-forget only.
- Don't make it a tool — implicit telemetry, not model-driven.
- Don't implement native session restore yet (herdr-side PR).

### Gotchas

- Socket path varies per machine; respect `$HERDR_SOCKET_PATH` first.
- `$HERDR_PANE_ID` absent → skip reporting (nerve isn't in a herdr pane).
- `Bun.connect({ path })` on a missing Unix socket rejects instantly — catch + return.
- Rapid state transitions (common during tool calls) are fine — herdr shows the latest.

---

## Future plan template

When adding a new speculative design, follow this structure:

```
## <Title>

**Status:** spec (not built) | in progress | abandoned
**What:** one-line summary.

### Background
Context — why this matters, what gap it fills.

### Design
Key modules, data flow, integration points.

### Build plan
Numbered stages from minimum viable to full scope.

### What NOT to do
Anti-patterns that look tempting.

### Gotchas
Traps and edge cases.
```
