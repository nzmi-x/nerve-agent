import { test, expect } from "bun:test";
import { formatRun } from "../src/tools/notebook.ts";

test("formatRun: renders stdout / result / error / no-output code cells; skips markdown", () => {
  const out = formatRun({
    cells: [
      { cell_type: "markdown", source: ["# title"] }, // ignored
      { cell_type: "code", source: ["print('hi')"], outputs: [{ output_type: "stream", text: ["hi\n"] }] },
      { cell_type: "code", source: ["x = 21 * 2\nx"], outputs: [{ output_type: "execute_result", data: { "text/plain": ["42"] } }] },
      { cell_type: "code", source: ["1 / 0"], outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero" }] },
      { cell_type: "code", source: ["y = 1"], outputs: [] },
    ],
  });
  expect(out).toContain("marimo run — 1 cell(s) errored");
  expect(out).toContain("[cell 0] print('hi')");
  expect(out).toContain("hi");
  expect(out).toContain("[cell 1] x = 21 * 2"); // head is the first source line
  expect(out).toContain("42");
  expect(out).toContain("✗ ZeroDivisionError: division by zero");
  expect(out).toContain("(no output)"); // the y = 1 cell
});

test("formatRun: clean run + no-code-cell cases", () => {
  expect(formatRun({ cells: [{ cell_type: "code", source: ["a = 1"], outputs: [] }] })).toContain("1 cell(s) ok");
  expect(formatRun({ cells: [{ cell_type: "markdown", source: ["x"] }] })).toContain("no code cells");
  expect(formatRun({})).toContain("no code cells");
});
