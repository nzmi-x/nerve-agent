import { test, expect } from "bun:test";
import { lineDiff, diffStat } from "../src/diff.ts";

test("lineDiff: identical texts → empty", () => {
  expect(lineDiff("a\nb\nc", "a\nb\nc")).toBe("");
});

test("lineDiff: a replaced line shows -/+ surrounded by context", () => {
  expect(lineDiff("A\nB\nC", "A\nX\nC")).toBe(" A\n-B\n+X\n C");
});

test("lineDiff: a brand-new file is all additions", () => {
  expect(lineDiff("", "x\ny")).toBe("+x\n+y");
});

test("lineDiff: collapses far-away unchanged lines to ⋯", () => {
  const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const neu = old.replace("l0", "CHANGED");
  const d = lineDiff(old, neu, 1);
  expect(d).toContain("-l0");
  expect(d).toContain("+CHANGED");
  expect(d).toContain("⋯"); // the distant unchanged tail is collapsed
});

test("diffStat: counts added + removed lines", () => {
  expect(diffStat("A\nB\nC", "A\nX\nY\nC")).toEqual({ added: 2, removed: 1 });
  expect(diffStat("same", "same")).toEqual({ added: 0, removed: 0 });
});
