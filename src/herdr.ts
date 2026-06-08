// Herdr integration (docs/PLANS.md → graduated). Report nerve's lifecycle state to herdr's Unix socket so
// herdr's sidebar shows nerve as working / idle / blocked alongside its other agents. This is
// implicit telemetry, NOT a tool: fire-and-forget, never blocks a turn, and a silent no-op unless nerve was
// launched inside a herdr pane (`$HERDR_PANE_ID`). herdr not running → the connect rejects instantly, ignored.
import { homedir } from "node:os";
import { join } from "node:path";

// herdr's valid pane agent states (verified against the running server — it rejects anything else, e.g.
// `done`: "invalid pane agent state ... expected idle, working, blocked, or unknown"). nerve emits the first
// three; `unknown` exists in herdr but nerve always knows its own state, so it never sends it.
export type HerdrState = "working" | "idle" | "blocked";

/** The herdr pane nerve runs in, or null when it wasn't launched by herdr (→ nothing to report to). */
export function herdrPaneId(): string | null {
  return Bun.env.HERDR_PANE_ID || null;
}

/** herdr's control socket: `$HERDR_SOCKET_PATH` (a leading `~/` expanded) or the default under `~/.config`. */
export function herdrSocketPath(): string {
  const p = Bun.env.HERDR_SOCKET_PATH;
  if (p) return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  return join(homedir(), ".config", "herdr", "herdr.sock");
}

let seq = 0;
/** The newline-delimited JSON-RPC line herdr expects for a pane agent-state report. Pure → unit-testable. */
export function herdrMessage(paneId: string, state: HerdrState): string {
  return JSON.stringify({
    id: `nerve-${++seq}`,
    method: "pane.report_agent",
    params: { pane_id: paneId, source: "nerve:tui", agent: "nerve", state },
  });
}

/** Report a lifecycle state to herdr — fire-and-forget. No-op off a herdr pane; all errors swallowed (herdr
 *  may not be running). Never awaited by the caller, so it can't stall the turn. */
export function herdrReport(state: HerdrState): void {
  const paneId = herdrPaneId();
  if (!paneId) return;
  const line = `${herdrMessage(paneId, state)}\n`;
  void Bun.connect({
    unix: herdrSocketPath(),
    socket: {
      open(socket) {
        socket.write(line);
        socket.flush();
        socket.end();
      },
      data() {},
      error() {},
      close() {},
    },
  }).catch(() => {
    /* socket missing / herdr down — telemetry is best-effort */
  });
}
