import { test, expect } from "bun:test";
import { collapseRuns } from "../src/collapse.ts";

// D41: collapse redundancy (repeated lines, long char runs) instead of truncating — so the tail survives.

test("collapseRuns: collapses 3+ identical consecutive lines and keeps the tail", () => {
  const input = ["start", "spam", "spam", "spam", "spam", "end"].join("\n");
  expect(collapseRuns(input)).toBe(["start", "spam", "⟨repeated 4×⟩", "end"].join("\n"));
});

test("collapseRuns: keeps short runs (below the threshold) verbatim", () => {
  const input = ["a", "a", "b"].join("\n"); // only 2 identical → not collapsed
  expect(collapseRuns(input)).toBe(input);
});

test("collapseRuns: collapses a long single-character run within a line", () => {
  expect(collapseRuns("=".repeat(200))).toBe("=⟨×200⟩");
  expect(collapseRuns("a" + "-".repeat(100) + "b")).toBe("a-⟨×100⟩b");
  expect(collapseRuns("-".repeat(79))).toBe("-".repeat(79)); // 79 < 80 → untouched
});

test("collapseRuns: leaves ordinary output untouched", () => {
  const input = "line one\nline two\nline three";
  expect(collapseRuns(input)).toBe(input);
  expect(collapseRuns("")).toBe("");
});

test("collapseRuns: collapses line runs and char runs together", () => {
  const bar = "#".repeat(120);
  expect(collapseRuns([bar, bar, bar].join("\n"))).toBe(["#⟨×120⟩", "⟨repeated 3×⟩"].join("\n"));
});
