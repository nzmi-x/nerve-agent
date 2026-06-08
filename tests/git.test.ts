import { test, expect } from "bun:test";
import { parseStatus, parseGraph } from "../src/git.ts";

test("parseStatus: ahead/behind from the header + dirty entry count", () => {
  expect(parseStatus("## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? b.ts")).toEqual({ dirty: 2, ahead: 2, behind: 1 });
  expect(parseStatus("## main...origin/main")).toEqual({ dirty: 0, ahead: 0, behind: 0 });
});

test("parseGraph: NUL-delimited rows → rail/hash/subject; connector rows are rail-only", () => {
  const out = ["* \x00a1b2c3\x00feat: thing", "* \x009f9f9f\x00fix: bug", "|\\", "| * \x00d4d4d4\x00branch work"].join("\n");
  const g = parseGraph(out);
  expect(g[0]).toEqual({ rail: "* ", hash: "a1b2c3", subject: "feat: thing" });
  expect(g[2]).toEqual({ rail: "|\\", hash: "", subject: "" }); // connector line
  expect(g[3]).toEqual({ rail: "| * ", hash: "d4d4d4", subject: "branch work" });
});
