# usage

**Status:** built (Phase 1) — metering + formatters. Wired into the status line with the TUI slice.
**What:** session token/cost metering and the context-used indicator.
**Code:** `src/usage.ts` (tests: `tests/usage.test.ts`).

**How it works:**
- `UsageMeter.record(usage, pricing?)` folds one turn's `{input, output}` token counts (from the
  loop's `usage` StreamEvent) into running totals + **cost** (`tokens/1e6 × price`, USD). Pricing
  comes from the active model's `config/models.json` `pricing` — passed per turn, so a `/model`
  switch costs each turn at the right rate. Absent pricing → tokens count, cost stays `$0`.
- `contextTokens` = the **latest** turn's input (the model re-reads the whole history each turn, so
  the last `prompt_tokens` ≈ current context occupancy) — not the cumulative sum.
- `UsageMeter.addCost(usd)` folds in spend that **didn't run on the main thread** — a **subagent**'s token
  cost (D6). The `task` tool sums the subagent's `usage` events (forwarded via `runSubagent`'s `onUsage`),
  prices them at the **subagent model's** rate, and calls `ctx.onCost` → `addCost`. It adds to `costUsd`
  only, deliberately **not** to `contextTokens` (the subagent has its own context window, so it must not
  move the main thread's occupancy gauge). So the session **cost** includes subagent spend; the **ctx**
  gauge stays the main thread's.
- `formatTokens`/`formatCost`/`formatContext` produce status-line strings, e.g.
  `formatContext(200_000, 1_000_000)` → `"200k/1M (20%)"`.

**How to change it:**
- Display lives here; the source of pricing/window is `config/models.json` (edit numbers there, not code).
- The TUI feeds the meter from `onEvent` (`if ev.type==="usage"`) with `entry.pricing`, and renders
  `formatCost`/`formatContext` in the status line.

**Gotchas:**
- DeepSeek's `usage` has a cache-hit/miss split; the normalized `StreamEvent` flattens to one `input`,
  so cost uses the **standard (cache-miss) rate** — a slight over-estimate when caching helps. Add
  the split to the contract + `cachedInput` pricing later to refine.
- Gemini Pro's >200k-token price tier isn't modeled (uses the base rate).

**See:** [DECISIONS D5](../DECISIONS.md) · [providers.md §1.7](../providers.md) · [tui](tui.md)
