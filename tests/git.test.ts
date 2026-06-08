import { test, expect } from "bun:test";
import { parseStatus, parseBranches, parseLog } from "../src/git.ts";

test("parseStatus: ahead/behind from the header + dirty entry count", () => {
  expect(parseStatus("## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? b.ts")).toEqual({ dirty: 2, ahead: 2, behind: 1 });
  expect(parseStatus("## main...origin/main")).toEqual({ dirty: 0, ahead: 0, behind: 0 });
});

test("parseBranches: marks the current branch, skips a detached-HEAD line", () => {
  expect(parseBranches("* main\n  feature/x\n  (HEAD detached at abc123)")).toEqual([
    { name: "main", current: true },
    { name: "feature/x", current: false },
  ]);
});

test("parseLog: NUL-separated hash/subject/unixtime → commits with age", () => {
  const ct = Math.floor(Date.now() / 1000) - 3600; // ~1h ago
  const log = parseLog(`a1b2c3\x00feat: thing\x00${ct}\nd4d4d4\x00fix: bug\x00${ct}`);
  expect(log).toHaveLength(2);
  expect(log[0]).toMatchObject({ hash: "a1b2c3", subject: "feat: thing" });
  expect(log[1]).toMatchObject({ hash: "d4d4d4", subject: "fix: bug" });
  expect(log[0]!.ageMs).toBeGreaterThan(3_500_000); // ~1h in ms
});
