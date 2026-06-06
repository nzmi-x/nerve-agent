import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, lastSessionId } from "../src/sessions.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-sessions-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function writeSession(id: string, lines: unknown[], mtimeSec: number): void {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(path, mtimeSec, mtimeSec);
}

test("listSessions: newest first, counts only msg lines, previews first user message", () => {
  writeSession("old", [{ t: "msg", role: "user", content: "old task here" }, { t: "msg", role: "assistant", content: "ok" }], 1000);
  writeSession("new", [
    { t: "delta", type: "text", delta: "x" },
    { t: "msg", role: "user", content: "new task" },
    { t: "msg", role: "assistant", content: "done" },
    { t: "msg", role: "tool", content: "r" },
  ], 2000);

  const list = listSessions(dir);
  expect(list.map((s) => s.id)).toEqual(["new", "old"]);
  expect(list[0]!.msgs).toBe(3); // delta line not counted
  expect(list[0]!.preview).toBe("new task");
  expect(list[1]!.preview).toBe("old task here");
});

test("lastSessionId: newest by mtime, honors exclude", () => {
  writeSession("a", [{ t: "msg", role: "user", content: "a" }], 1000);
  writeSession("b", [{ t: "msg", role: "user", content: "b" }], 2000);
  expect(lastSessionId(dir)).toBe("b");
  expect(lastSessionId(dir, "b")).toBe("a"); // skip the current session → previous one
});

test("missing dir → empty / undefined", () => {
  const none = join(dir, "nope");
  expect(listSessions(none)).toEqual([]);
  expect(lastSessionId(none)).toBeUndefined();
});
