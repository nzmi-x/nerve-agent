import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, loadSession } from "../src/session.ts";
import { sessionExists } from "../src/sessions.ts";
import type { StreamEvent } from "../src/providers/types.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nerve-session-"));
  process.env.NERVE_HOME = home; // each test gets its own per-project DB
});
afterEach(async () => {
  delete process.env.NERVE_HOME;
  await rm(home, { recursive: true, force: true });
});

test("accumulates a text+tool_call turn and commits an assistant message", async () => {
  const s = new Session({ id: "t1" });
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

test("persists canonical messages as rows; telemetry tap is not persisted (D31)", async () => {
  const s = new Session({ id: "t2" });
  s.addUser("hi");
  s.tap({ type: "text", delta: "x" }); // telemetry — no-op, never stored
  s.apply({ type: "text", delta: "yo" });
  s.commitAssistant();
  s.addToolResult("c1", "ok");
  await s.close();

  const { messages } = loadSession(process.cwd(), "t2");
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(messages[2]).toEqual({ role: "tool", content: "ok", toolCallId: "c1" });
});

test("resume reloads prior messages from the DB", async () => {
  const a = new Session({ id: "r1" });
  a.addUser("first");
  a.apply({ type: "text", delta: "reply" });
  a.commitAssistant();
  a.tap({ type: "text", delta: "noise" }); // no-op — nothing to ignore on resume
  await a.close();

  const b = new Session({ id: "r1", resume: true });
  expect(b.messages.map((m) => [m.role, m.content])).toEqual([
    ["user", "first"],
    ["assistant", "reply"],
  ]);
  await b.close();
});

test("title (D26): setTitle persists; resume restores it", async () => {
  const a = new Session({ id: "tt" });
  a.addUser("hi");
  a.setTitle("My Cool Session");
  await a.close();

  const b = new Session({ id: "tt", resume: true });
  expect(b.title).toBe("My Cool Session");
  await b.close();
});

test("lazy session (D27): no row until the first write", async () => {
  const s = new Session({ id: "lazy" });
  expect(sessionExists(process.cwd(), "lazy")).toBe(false); // opened the session but wrote nothing
  s.addUser("now");
  await s.close();
  expect(sessionExists(process.cwd(), "lazy")).toBe(true);
});
