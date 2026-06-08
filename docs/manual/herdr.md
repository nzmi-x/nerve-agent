# herdr

**Status:** built ([D51](../DECISIONS.md)) — Stage 1 (the socket reporter). Stages 2–4 (custom status
labels, a shareable skill, native session-restore) stay deferred.
**What:** report nerve's lifecycle state (`working` / `idle` / `blocked`) to the
[herdr](https://github.com/) multiplexer's Unix socket, so herdr's sidebar shows nerve's real-time status
next to its other agents. Implicit telemetry, **not** a tool — the model never drives it.
**Code:** `src/herdr.ts` (the reporter) · hooks in `src/tui/app.ts` (tests: `tests/herdr.test.ts`)

**Custom harness = a "reported agent".** herdr's built-in integrations are a fixed list (`pi`/`omp`/`claude`/
`codex`/`copilot`/`opencode`/`hermes`/`qodercli`) — nerve isn't one. But the socket API's `pane.report_agent`
accepts an **arbitrary `agent` label**, so any harness can surface itself without being on that list (verified:
reporting `--agent nerve` makes `herdr agent list` show a `nerve` agent next to `claude`). That's exactly what
this module does.

**How it works:**
- **Opt-in by environment.** `herdrReport(state)` is a **no-op unless `$HERDR_PANE_ID` is set** — herdr sets
  it in panes it spawns, so nerve only reports when it's actually running inside herdr. Off a herdr pane,
  every call returns immediately. (`$HERDR_PANE_ID` is a *legacy* pane id like `p_10`; herdr resolves it to
  the real pane in `report_agent` — verified.)
- **Socket.** `$HERDR_SOCKET_PATH` (a leading `~/` expanded) or the default `~/.config/herdr/herdr.sock`.
  `herdrReport` does `Bun.connect({ unix })`, writes one **newline-delimited JSON-RPC line** in the `open`
  handler (`pane.report_agent` · `{ pane_id, source: "nerve:tui", agent: "nerve", state }`), flushes, ends.
- **Fire-and-forget.** The connect promise is never awaited and its rejection is swallowed — herdr might not
  be running (the socket rejects instantly), and telemetry must **never block or fail a turn**.
- **Valid states are `idle` / `working` / `blocked` / `unknown`** (the server rejects anything else — `done`
  errors with *"invalid pane agent state"*). nerve emits the first three.
- **State mapping** (hook sites in `app.ts`): **launch → `idle`** (registers nerve with herdr the moment it
  starts — without this, an idle nerve that never runs a turn stays invisible, since herdr only knows
  *reported* agents); turn start → `working`; turn end → `idle`; `ask_user` picker open → `blocked` (answered →
  `working`); ESC → `idle`; `/compact` → `working`/`idle`. **No report on exit** — `done` isn't valid and herdr
  detects `PaneExited` when nerve's pane closes.
- **Engine-loaded, not hot-swappable:** `herdr.ts` is imported by `app.ts` (the engine), so a running nerve
  must be **restarted** to pick up the integration — `/reload` won't.

**Not done (deferred):** Stage 2 custom status labels (tool name / "thinking"), Stage 3 a shareable
`herdr` skill, Stage 4 native herdr-side session restore. Add them only when a real need shows up.

**See:** [DECISIONS D51](../DECISIONS.md) · [tui](tui.md)
