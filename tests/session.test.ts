import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.ts";
import type { StreamEvent } from "../src/providers/types.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-session-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lines(s: Session): Record<string, unknown>[] {
  return readFileSync(join(dir, `${s.id}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("accumulates a text+tool_call turn and commits an assistant message", async () => {
  const s = new Session({ id: "t1", dir });
  s.addUser("make a file");

  const evs: StreamEvent[] = [
    { type: "reasoning", delta: "I should " },
    { type: "reasoning", delta: "write it." },
    { type: "text", delta: "Writing " },
    { type: "text", delta: "now." },
    { type: "tool_call", index: 0, id: "c1", name: "write", args: '{"pa' },
    { type: "tool_call", index: 0, args: 'th":"a"}' },
    { type: "done", reason: "tool_calls" },
  ];
  for (const ev of evs) s.apply(ev);
  const msg = s.commitAssistant();

  expect(msg).toEqual({
    role: "assistant",
    content: "Writing now.",
    reasoning: "I should write it.",
    toolCalls: [{ id: "c1", name: "write", args: '{"path":"a"}' }],
  });
  await s.close();
});

test("persists msg lines (and only msg lines are canonical)", async () => {
  const s = new Session({ id: "t2", dir });
  s.addUser("hi");
  s.tap({ type: "text", delta: "x" }); // telemetry — a delta line
  s.apply({ type: "text", delta: "yo" });
  s.commitAssistant();
  s.addToolResult("c1", "ok");
  await s.close();

  const all = lines(s);
  expect(all.filter((l) => l.t === "delta")).toHaveLength(1);
  const msgs = all.filter((l) => l.t === "msg");
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(msgs[2]).toEqual({ t: "msg", role: "tool", content: "ok", toolCallId: "c1" });
});

test("resume reloads prior messages from the msg lines", async () => {
  const a = new Session({ id: "r1", dir });
  a.addUser("first");
  a.apply({ type: "text", delta: "reply" });
  a.commitAssistant();
  a.tap({ type: "text", delta: "noise" }); // delta line must be ignored on resume
  await a.close();

  const b = new Session({ id: "r1", dir, resume: true });
  expect(b.messages.map((m) => [m.role, m.content])).toEqual([
    ["user", "first"],
    ["assistant", "reply"],
  ]);
  await b.close();
});

test("title (D26): setTitle persists; resume restores it", async () => {
  const a = new Session({ id: "tt", dir });
  a.addUser("hi");
  a.setTitle("My Cool Session");
  await a.close();

  const b = new Session({ id: "tt", dir, resume: true });
  expect(b.title).toBe("My Cool Session");
  await b.close();
});

test("lazy file (D27): no jsonl until the first write", async () => {
  const s = new Session({ id: "lazy", dir });
  expect(existsSync(join(dir, "lazy.jsonl"))).toBe(false); // opened the session but wrote nothing
  s.addUser("now");
  await s.close();
  expect(existsSync(join(dir, "lazy.jsonl"))).toBe(true);
});
