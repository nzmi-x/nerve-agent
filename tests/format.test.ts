import { test, expect } from "bun:test";
import { firstLine, trunc, rel } from "../src/tui/format.ts";

test("firstLine: takes line one and clips at 120 cols", () => {
  expect(firstLine("hello\nworld")).toBe("hello");
  expect(firstLine("")).toBe("");
  const long = "x".repeat(200);
  const out = firstLine(long);
  expect(out.length).toBe(118); // 117 + ellipsis
  expect(out.endsWith("…")).toBe(true);
});

test("trunc: clips with an ellipsis only past the limit", () => {
  expect(trunc("short", 10)).toBe("short");
  expect(trunc("exactly10!", 10)).toBe("exactly10!");
  expect(trunc("waytoolongstring", 8)).toBe("waytool…");
});

test("rel: buckets into s/m/h/d and never goes negative", () => {
  const now = Date.now();
  expect(rel(now)).toBe("0s ago");
  expect(rel(now - 5_000)).toBe("5s ago");
  expect(rel(now - 90_000)).toBe("1m ago");
  expect(rel(now - 2 * 3_600_000)).toBe("2h ago");
  expect(rel(now - 3 * 86_400_000)).toBe("3d ago");
  expect(rel(now + 10_000)).toBe("0s ago"); // future clamps to 0
});
