// The v1 interceptors (the "nerve"). Each is a small factory returning an Interceptor; the loop
// composes them in order: secret-redaction → reasoning-router → stop-guard → token-tap (tap last,
// so it logs the final post-transform event). Hot-swappable (D7). See docs/manual/interceptors.md.
import type { Interceptor } from "./stream.ts";
import type { Session } from "./session.ts";

/** token-tap: tee every text/reasoning delta + usage to the session JSONL (telemetry). Observe-only. */
export function tokenTap(session: Session): Interceptor {
  return (ev) => {
    session.tap(ev);
  };
}

/** reasoning-router: forward reasoning deltas to a sink (e.g. the TUI's folded region). Observe-only. */
export function reasoningRouter(onReasoning: (delta: string) => void): Interceptor {
  return (ev) => {
    if (ev.type === "reasoning") onReasoning(ev.delta);
  };
}

// Crude secret shapes (OpenAI sk-, Google AIza, GitHub gh*_). Per-delta — a secret split across two
// deltas won't match (see manual). Must run before the tap so a key never hits the log/UI.
const SECRET = /(sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/g;

/** secret-redaction: scrub secret-looking tokens from text/reasoning deltas. Rewrite. */
export function secretRedaction(): Interceptor {
  return (ev) => {
    if (ev.type === "text" || ev.type === "reasoning") {
      const scrubbed = ev.delta.replace(SECRET, "[redacted]");
      if (scrubbed !== ev.delta) return { ...ev, delta: scrubbed };
    }
    return; // unchanged → forward as-is
  };
}

/** stop-guard: abort the turn the instant accumulated visible text matches a banned pattern. */
export function stopGuard(patterns: readonly (string | RegExp)[]): Interceptor {
  return (ev, ctl) => {
    if (ev.type !== "text" || patterns.length === 0) return;
    const text = ctl.text + ev.delta;
    for (const p of patterns) {
      if (typeof p === "string" ? text.includes(p) : p.test(text)) {
        ctl.abort(`stop-guard matched ${p}`);
        return;
      }
    }
  };
}
