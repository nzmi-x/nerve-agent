import { test, expect } from "bun:test";
import { diffRows, diffStat } from "../src/diff.ts";

test("diffRows: identical texts → empty", () => {
  expect(diffRows("a\nb\nc", "a\nb\nc")).toEqual([]);
});

test("diffRows: a replaced line → context/-/+ with line numbers", () => {
  expect(diffRows("A\nB\nC", "A\nX\nC")).toEqual([
    { tag: " ", n: 1, text: "A" },
    { tag: "-", n: 2, text: "B" },
    { tag: "+", n: 2, text: "X" },
    { tag: " ", n: 3, text: "C" },
  ]);
});

test("diffRows: a brand-new file is all additions numbered from 1", () => {
  expect(diffRows("", "x\ny")).toEqual([
    { tag: "+", n: 1, text: "x" },
    { tag: "+", n: 2, text: "y" },
  ]);
});

test("diffRows: collapses far-away unchanged lines to a ⋯ row", () => {
  const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const neu = old.replace("l0", "CHANGED");
  const rows = diffRows(old, neu, 1);
  expect(rows.some((r) => r.tag === "-" && r.text === "l0")).toBe(true);
  expect(rows.some((r) => r.tag === "+" && r.text === "CHANGED")).toBe(true);
  expect(rows.some((r) => r.tag === "⋯")).toBe(true);
});

test("diffStat: counts added + removed lines", () => {
  expect(diffStat("A\nB\nC", "A\nX\nY\nC")).toEqual({ added: 2, removed: 1 });
  expect(diffStat("same", "same")).toEqual({ added: 0, removed: 0 });
});
