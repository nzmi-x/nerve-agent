// The agent turn loop — pure and re-entrant over a Session, so a subagent later is just "call it
// with a fresh session + a cheaper profile" (D6). One turn = stream → interceptors → accumulate →
// dispatch any tool calls → repeat until the model stops calling tools. See ARCHITECTURE_BRIEF §3.
import { pipe, type Interceptor } from "./stream.ts";
import { dispatch, type Mode } from "./dispatch.ts";
import { isTransient, isContextOverflow, backoffMs, sleep } from "./retry.ts";
import type { Provider, ProviderRequest, StreamEvent, ToolSpec } from "./providers/types.ts";
import type { Session } from "./session.ts";
import type { ToolContext } from "./tools/types.ts";

/** A model to run a turn on. The first is the primary; the rest are the fallback ladder (D15). */
export interface Candidate {
  provider: Provider;
  model: string;
  thinking?: boolean;
  temperature?: number;
}

export interface RetryPolicy {
  /** Backoff attempts on the same candidate after the fallback ladder is exhausted. Default 2. */
  maxRetries?: number;
  baseDelayMs?: number; // default 1000
  maxDelayMs?: number; // default 30000
}

export interface LoopOptions {
  provider: Provider;
  session: Session;
  model: string;
  mode: Mode;
  ctx: ToolContext;
  interceptors: readonly Interceptor[];
  /** External cancellation (ESC). Aborts the in-flight turn between/within streams. */
  signal: AbortSignal;
  system?: string;
  tools?: ToolSpec[];
  thinking?: boolean;
  temperature?: number;
  /** Model-ladder fallbacks tried (delay 0) before backing off on a transient error (D15). */
  fallbacks?: Candidate[];
  retry?: RetryPolicy;
  /** Runaway guard — max tool-calling round-trips. */
  maxTurns?: number;
  onEvent?: (ev: StreamEvent) => void;
  onToolResult?: (name: string, result: string) => void;
  /** A transient failure is being retried (fallback or backoff). `delayMs:0` = ladder switch. */
  onRetry?: (info: { attempt: number; delayMs: number; model: string; error: unknown }) => void;
  /** The turn failed for good (non-transient, context overflow, or retry budget exhausted). */
  onError?: (error: unknown) => void;
}

export async function loop(opts: LoopOptions): Promise<void> {
  const maxTurns = opts.maxTurns ?? 24;
  const candidates: Candidate[] = [
    { provider: opts.provider, model: opts.model, thinking: opts.thinking, temperature: opts.temperature },
    ...(opts.fallbacks ?? []),
  ];
  const maxRetries = opts.retry?.maxRetries ?? 2;
  const baseDelay = opts.retry?.baseDelayMs ?? 1000;
  const maxDelay = opts.retry?.maxDelayMs ?? 30_000;

  let ci = 0; // current candidate (advances down the ladder, never back — avoids flapping)
  let retries = 0; // backoff attempts on the current candidate

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal.aborted) return;
    const cand = candidates[ci]!;

    const req: ProviderRequest = {
      model: cand.model,
      messages: opts.session.messages,
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(cand.thinking !== undefined ? { thinking: cand.thinking } : {}),
      ...(cand.temperature !== undefined ? { temperature: cand.temperature } : {}),
    };

    // One controller per turn: ESC (opts.signal) and a stop-guard's ctl.abort() both feed it, and it
    // is the signal the provider's fetch + the interceptor pipeline watch.
    const ac = new AbortController();
    if (opts.signal.aborted) ac.abort();
    const onAbort = () => ac.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });

    // The loop owns `error` events (for retry); everything else reaches the session + onEvent.
    let streamError: unknown = null;
    try {
      for await (const ev of pipe(cand.provider.stream(req, ac.signal), opts.interceptors, ac)) {
        if (ev.type === "error") {
          streamError = ev.error;
          continue;
        }
        opts.session.apply(ev);
        opts.onEvent?.(ev);
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }

    if (ac.signal.aborted) {
      opts.session.commitAssistant(); // ESC / stop-guard: preserve the partial turn, then stop
      return;
    }

    if (streamError) {
      opts.session.discardAssistant(); // never commit a failed turn
      if (!isContextOverflow(streamError) && isTransient(streamError)) {
        if (ci + 1 < candidates.length) {
          ci++; // fall down the model ladder — no delay
          retries = 0;
          opts.onRetry?.({ attempt: 0, delayMs: 0, model: candidates[ci]!.model, error: streamError });
          turn--; // a retry is not a tool round-trip
          continue;
        }
        if (retries < maxRetries) {
          retries++;
          const delayMs = backoffMs(retries, baseDelay, maxDelay);
          opts.onRetry?.({ attempt: retries, delayMs, model: cand.model, error: streamError });
          if (!(await sleep(delayMs, opts.signal))) return; // aborted during backoff
          turn--;
          continue;
        }
      }
      opts.onError?.(streamError); // non-transient, overflow, or budget exhausted
      return;
    }

    retries = 0; // a clean turn resets the backoff budget
    const assistant = opts.session.commitAssistant();

    const calls = assistant.toolCalls;
    if (!calls || calls.length === 0) return; // the model answered without calling a tool — done

    for (const call of calls) {
      const result = await dispatch(call.name, parseArgs(call.args), opts.mode, opts.ctx);
      opts.session.addToolResult(call.id, result);
      opts.onToolResult?.(call.name, result);
    }
  }
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
