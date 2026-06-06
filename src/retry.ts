// Transient-error classification + backoff for the loop's auto-retry (D15). Pure and string-pattern
// based: with only two providers, regex over the error message beats modelling typed provider codes.
// Context overflow is deliberately NOT "transient" — that's compaction's job (D17), not retry's.

const TRANSIENT =
  /\b(429|500|502|503|504)\b|too many requests|rate.?limit|usage limit|overloaded|server error|service unavailable|internal error|temporar|try again|timeout|timed out|connection (reset|refused|closed)|econnreset|econnrefused|etimedout|socket hang up|fetch failed|network error|terminated/i;

// Context-window overflow — excluded from retry (retrying the same too-big input loops forever).
const OVERFLOW =
  /context (length|window)|maximum context|context.{0,12}exceed|too many tokens|token limit|reduce the (length|size)|prompt is too (long|large)|input is too long/i;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Is this a provider error worth retrying (rate-limit / 5xx / network), and NOT context overflow? */
export function isTransient(error: unknown): boolean {
  const m = messageOf(error);
  return !OVERFLOW.test(m) && TRANSIENT.test(m);
}

/** Is this a context-window overflow? (Handled by compaction, never by retry — D15/D17.) */
export function isContextOverflow(error: unknown): boolean {
  return OVERFLOW.test(messageOf(error));
}

/** Exponential backoff: base · 2^(attempt-1), capped at max. (attempt is 1-based.) */
export function backoffMs(attempt: number, base = 1000, max = 30000): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

/** Sleep `ms`, resolving early to `false` if `signal` aborts (ESC). `true` = slept the full duration. */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
