// SSE reader + the synchronous interceptor pipeline (the "nerve").
// See docs/ARCHITECTURE_BRIEF.md §2 and docs/manual/stream.md.
import type { StreamEvent } from "./providers/types.ts";

/**
 * Parse a fetch SSE body into `data:` payload strings.
 *
 * Skips `:`-comment lines — DeepSeek sends `: keep-alive` under load (providers.md §1.5) — and
 * handles CRLF, multi-line `data:` events, payloads split across network chunks, and a final event
 * with no trailing blank line. Yields raw payloads; the caller parses them (DeepSeek's terminal
 * `[DONE]` sentinel is yielded verbatim, Gemini just ends the stream).
 */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF
        if (line === "") {
          if (data.length) { yield data.join("\n"); data = []; } // blank line = event boundary
        } else if (line[0] === ":") {
          // comment / keep-alive — ignore
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, "")); // strip "data:" + one optional leading space
        }
        // other SSE fields (event:, id:, retry:) are irrelevant here
      }
    }
    if (data.length) yield data.join("\n"); // flush a trailing event with no final blank line
  } finally {
    reader.releaseLock();
  }
}

/**
 * Runs on every StreamEvent before it reaches the session/TUI. Return the event (possibly mutated),
 * `null` to drop it, or call `ctl.abort()` to kill the turn. Synchronous on purpose — the per-delta
 * path stays fast. See docs/manual/interceptors.md.
 */
export type Interceptor = (ev: StreamEvent, ctl: StreamCtl) => StreamEvent | null | void;

export interface StreamCtl {
  /** Cancel the in-flight provider fetch (also what ESC calls). */
  abort(reason?: string): void;
  /** Inject a synthetic event downstream (after the current one; not re-intercepted). */
  emit(ev: StreamEvent): void;
  /** Visible answer text accumulated so far this turn (post-transform), for guard/stop-sequence logic. */
  readonly text: string;
}

/**
 * Push `source` events through `interceptors` (in array order) and yield the survivors.
 * The caller passes the interceptor array fresh each turn, so it stays hot-swappable (D7).
 */
export async function* pipe(
  source: AsyncGenerator<StreamEvent>,
  interceptors: readonly Interceptor[],
  ac: AbortController,
): AsyncGenerator<StreamEvent> {
  let text = "";
  const injected: StreamEvent[] = [];
  const ctl: StreamCtl = {
    abort: (reason) => ac.abort(reason),
    emit: (ev) => injected.push(ev),
    get text() {
      return text;
    },
  };

  for await (const incoming of source) {
    let ev: StreamEvent = incoming;
    let dropped = false;
    for (const ic of interceptors) {
      const out = ic(ev, ctl);
      if (out === null) {
        dropped = true;
        break;
      }
      if (out !== undefined) ev = out;
      if (ac.signal.aborted) break;
    }
    if (!dropped) {
      if (ev.type === "text") text += ev.delta;
      yield ev;
    }
    while (injected.length) {
      const q = injected.shift()!;
      if (q.type === "text") text += q.delta;
      yield q;
    }
    if (ac.signal.aborted) break;
  }
}
