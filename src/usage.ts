// Session usage metering: accumulate `usage` events into running token totals + cost, and track the
// latest turn's input as the current context occupancy. Pure (no I/O) so it's unit-tested. The TUI
// feeds it from the loop's usage events and shows the result in the status line. See docs/manual/usage.md.

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
    if (pricing) {
      this.costUsd += (usage.input / 1e6) * pricing.input + (usage.output / 1e6) * pricing.output;
    }
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
