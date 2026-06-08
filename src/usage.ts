// Session usage metering: accumulate `usage` events into running token totals + cost, and track the
// latest turn's input as the current context occupancy. Pure (no I/O) so it's unit-tested. The TUI
// feeds it from the loop's usage events and shows the result in the status line. See docs/manual/usage.md.

import type { Todo } from "./tools/types.ts";

/** USD per 1,000,000 tokens (from config/models.json). */
export interface Pricing {
  input: number;
  cachedInput?: number;
  output: number;
}

export interface Usage {
  input: number;
  output: number;
}

/** USD for a usage at a pricing (cache-miss rate). The one home for the cost formula — used by the meter
 *  and by the `task` tool to bill subagent spend (D6). Absent pricing → 0. */
export function costOf(usage: Usage, pricing?: Pricing): number {
  return pricing ? (usage.input / 1e6) * pricing.input + (usage.output / 1e6) * pricing.output : 0;
}

export interface UsageSnapshot {
  inputTokens: number; // cumulative
  outputTokens: number; // cumulative
  costUsd: number; // cumulative
  contextTokens: number; // latest turn's input ≈ current context occupancy
  turns: number;
}

export class UsageMeter {
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private contextTokens = 0;
  private turns = 0;

  /** Record one turn's usage. Cost uses the pricing active for that turn (absent pricing → no cost). */
  record(usage: Usage, pricing?: Pricing): void {
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.contextTokens = usage.input; // the model re-reads the whole history each turn, so latest input ≈ context size
    this.turns += 1;
    this.costUsd += costOf(usage, pricing);
  }

  /** Add cost that didn't run on the main thread (a subagent, D6): it spends money on the session but
   *  runs in its OWN context window, so it must NOT move the `contextTokens` occupancy gauge. */
  addCost(usd: number): void {
    this.costUsd += usd;
  }

  snapshot(): UsageSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      contextTokens: this.contextTokens,
      turns: this.turns,
    };
  }
}

// --- display helpers (pure) -------------------------------------------------

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k`;
  return String(n);
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** "200k/1M (20%)" when a window is known, else just the used count. */
export function formatContext(contextTokens: number, window?: number): string {
  const used = formatTokens(contextTokens);
  if (!window) return used;
  return `${used}/${formatTokens(window)} (${Math.round((contextTokens / window) * 100)}%)`;
}

/** Clip to a short single-line label (the in-progress todo in the status line). */
function clip(s: string, n = 48): string {
  const line = (s.split("\n")[0] ?? "").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

/** The ambient `[status]` line appended to the request tail (D43): the model's running spend, context
 *  occupancy, and todo progress, so it can pace itself. Not a stop signal (see prompts/system.md). Pure. */
export function formatModelStatus(snap: UsageSnapshot, window: number | undefined, todos: Todo[]): string {
  const parts = [formatCost(snap.costUsd), `ctx ${formatContext(snap.contextTokens, window)}`];
  if (todos.length) {
    const done = todos.filter((t) => t.status === "completed").length;
    const doing = todos.find((t) => t.status === "in_progress");
    parts.push(`todos ${done}/${todos.length}${doing ? ` · doing: ${clip(doing.content)}` : ""}`);
  }
  return `[status] ${parts.join(" · ")}`;
}
