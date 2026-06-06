// The agent turn loop — pure and re-entrant over a Session, so a subagent later is just "call it
// with a fresh session + a cheaper profile" (D6). One turn = stream → interceptors → accumulate →
// dispatch any tool calls → repeat until the model stops calling tools. See ARCHITECTURE_BRIEF §3.
import { pipe, type Interceptor } from "./stream.ts";
import { dispatch, type Mode } from "./dispatch.ts";
import type { Provider, ProviderRequest, StreamEvent, ToolSpec } from "./providers/types.ts";
import type { Session } from "./session.ts";
import type { ToolContext } from "./tools/types.ts";

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
  /** Runaway guard — max tool-calling round-trips. */
  maxTurns?: number;
  onEvent?: (ev: StreamEvent) => void;
  onToolResult?: (name: string, result: string) => void;
}

export async function loop(opts: LoopOptions): Promise<void> {
  const maxTurns = opts.maxTurns ?? 24;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal.aborted) return;

    const req: ProviderRequest = {
      model: opts.model,
      messages: opts.session.messages,
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };

    // One controller per turn: ESC (opts.signal) and a stop-guard's ctl.abort() both feed it, and it
    // is the signal the provider's fetch + the interceptor pipeline watch.
    const ac = new AbortController();
    if (opts.signal.aborted) ac.abort();
    const onAbort = () => ac.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const ev of pipe(opts.provider.stream(req, ac.signal), opts.interceptors, ac)) {
        opts.session.apply(ev);
        opts.onEvent?.(ev);
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }

    const assistant = opts.session.commitAssistant();
    if (ac.signal.aborted) return; // ESC or stop-guard ended this turn

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
