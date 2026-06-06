import { test, expect } from "bun:test";
import { parseBalance, formatBalance, fetchBalance } from "../src/balance.ts";

test("parseBalance: reads total_balance; prefers USD; handles empty", () => {
  expect(parseBalance({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00" }] })).toEqual({
    currency: "CNY",
    total: 110,
    available: true,
  });
  const multi = parseBalance({
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: "110.00" }, { currency: "USD", total_balance: "5.50" }],
  });
  expect(multi).toEqual({ currency: "USD", total: 5.5, available: true });
  expect(parseBalance({ balance_infos: [] })).toBeNull();
  expect(parseBalance({})).toBeNull();
});

test("formatBalance: currency symbol, n/a, low-balance marker", () => {
  expect(formatBalance({ currency: "USD", total: 5.5, available: true })).toBe("$5.50");
  expect(formatBalance({ currency: "CNY", total: 110, available: true })).toBe("¥110.00");
  expect(formatBalance(null)).toBe("n/a"); // Gemini / unknown
  expect(formatBalance({ currency: "USD", total: 0, available: false })).toBe("$0.00 (low)");
});

test("fetchBalance: gemini returns null without a network call", async () => {
  expect(await fetchBalance("gemini", "irrelevant")).toBeNull();
});
