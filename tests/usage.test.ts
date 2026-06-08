import { test, expect } from "bun:test";
import { UsageMeter, formatTokens, formatCost, formatContext, formatModelStatus } from "../src/usage.ts";
import type { Todo } from "../src/tools/types.ts";

const FLASH = { input: 0.14, output: 0.28 }; // USD / 1M

test("UsageMeter: accumulates tokens + cost; context = latest input", () => {
  const m = new UsageMeter();
  m.record({ input: 1_000_000, output: 1_000_000 }, FLASH);
  m.record({ input: 500_000, output: 200_000 }, FLASH);
  const s = m.snapshot();
  expect(s.inputTokens).toBe(1_500_000);
  expect(s.outputTokens).toBe(1_200_000);
  expect(s.turns).toBe(2);
  expect(s.contextTokens).toBe(500_000); // latest turn's input, not the sum
  // turn1: 0.14 + 0.28 = 0.42 ; turn2: 0.07 + 0.056 = 0.126 → 0.546
  expect(s.costUsd).toBeCloseTo(0.546, 6);
});

test("UsageMeter: no pricing → tokens count but cost stays 0; per-turn pricing on model switch", () => {
  const m = new UsageMeter();
  m.record({ input: 1_000_000, output: 0 }); // no pricing (e.g. unreleased model)
  expect(m.snapshot().costUsd).toBe(0);
  m.record({ input: 1_000_000, output: 1_000_000 }, { input: 2, output: 12 }); // gemini pro rates
  expect(m.snapshot().costUsd).toBeCloseTo(14, 6); // 2 + 12
});

test("formatTokens: human units", () => {
  expect(formatTokens(500)).toBe("500");
  expect(formatTokens(12_000)).toBe("12k");
  expect(formatTokens(1_500)).toBe("1.5k");
  expect(formatTokens(1_000_000)).toBe("1M");
  expect(formatTokens(1_250_000)).toBe("1.3M");
});

test("formatCost: cents, then sub-cent precision", () => {
  expect(formatCost(0)).toBe("$0.00");
  expect(formatCost(0.0028)).toBe("$0.0028");
  expect(formatCost(0.42)).toBe("$0.42");
  expect(formatCost(1.5)).toBe("$1.50");
});

test("formatContext: used/window (pct), or just used when no window", () => {
  expect(formatContext(200_000, 1_000_000)).toBe("200k/1M (20%)");
  expect(formatContext(0)).toBe("0");
});

const snap = (costUsd: number, contextTokens: number) => ({ inputTokens: 0, outputTokens: 0, costUsd, contextTokens, turns: 1 });

test("formatModelStatus: composes spend · context · todo progress (D43)", () => {
  const todos: Todo[] = [
    { content: "done thing", status: "completed" },
    { content: "wire up the parser", status: "in_progress" },
    { content: "later thing", status: "pending" },
  ];
  const out = formatModelStatus(snap(0.12, 45_000), 128_000, todos);
  expect(out).toContain("[status]");
  expect(out).toContain("$0.12");
  expect(out).toContain("ctx 45k/128k (35%)");
  expect(out).toContain("todos 1/3");
  expect(out).toContain("doing: wire up the parser");
});

test("formatModelStatus: omits the todo segment when there are none", () => {
  const out = formatModelStatus(snap(0, 1_000), undefined, []);
  expect(out).not.toContain("todos");
  expect(out).toContain("ctx 1k");
});
