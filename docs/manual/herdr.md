# herdr

**Status:** built ([D51](../DECISIONS.md)) — Stage 1 (the socket reporter). Stages 2–4 (custom status
labels, a shareable skill, native session-restore) stay deferred.
**What:** report nerve's lifecycle state (`working` / `idle` / `blocked` / `done`) to the
[herdr](https://github.com/) multiplexer's Unix socket, so herdr's sidebar shows nerve's real-time status
next to its other agents. Implicit telemetry, **not** a tool — the model never drives it.
**Code:** `src/herdr.ts` (the reporter) · hooks in `src/tui/app.ts` (tests: `tests/herdr.test.ts`)

**How it works:**
- **Opt-in by environment.** `herdrReport(state)` is a **no-op unless `$HERDR_PANE_ID` is set** — herdr sets
  it in panes it spawns, so nerve only reports when it's actually running inside herdr. Off a herdr pane,
  every call returns immediately.
- **Socket.** `$HERDR_SOCKET_PATH` (a leading `~/` expanded) or the default `~/.config/herdr/herdr.sock`.
  `herdrReport` does `Bun.connect({ unix })`, writes one **newline-delimited JSON-RPC line** in the `open`
  handler (`pane.report_agent` · `{ pane_id, source: "nerve:tui", agent: "nerve", state }`), flushes, ends.
- **Fire-and-forget.** The connect promise is never awaited and its rejection is swallowed — herdr might not
  be running (the socket rejects instantly), and telemetry must **never block or fail a turn**.
- **State mapping** (hook sites in `app.ts`): turn start → `working`; turn end → `idle`; `ask_user` picker
  open → `blocked` (answered → `working`); ESC → `idle`; `/compact` → `working`/`idle`; shutdown → `done`
  (reported first, before the teardown awaits, so it has a chance to flush before `process.exit`).

**Not done (deferred):** Stage 2 custom status labels (tool name / "thinking"), Stage 3 a shareable
`herdr` skill, Stage 4 native herdr-side session restore. Add them only when a real need shows up.

**See:** [DECISIONS D51](../DECISIONS.md) · [tui](tui.md)
