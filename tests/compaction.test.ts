import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickCutPoint, pruneToolOutputs, summarize, estimateTokens, serializeConversation } from "../src/compaction.ts";
import { Session, loadSession } from "../src/session.ts";
import type { Message, Provider, StreamEvent } from "../src/providers/types.ts";

const convo: Message[] = [
  { role: "user", content: "make a file" },
  { role: "assistant", content: "ok", toolCalls: [{ id: "b1", name: "bash", args: "{}" }] },
  { role: "tool", content: "Z".repeat(400), toolCallId: "b1" },
  { role: "user", content: "now read it" },
  { role: "assistant", content: "done" },
];

// --- pickCutPoint -----------------------------------------------------------

test("pickCutPoint: a generous budget compacts nothing (cut 0)", () => {
  expect(pickCutPoint(convo, 1_000_000)).toBe(0);
});

test("pickCutPoint: a tight budget snaps the boundary to a user turn (never orphans a tool)", () => {
  const cut = pickCutPoint(convo, 0);
  expect(cut).toBe(3); // keeps [user 'now read it', assistant 'done']
  expect(convo[cut]!.role).toBe("user");
});

// --- pruneToolOutputs -------------------------------------------------------

test("pruneToolOutputs: truncates stale bash output, never read, protects recent", () => {
  const msgs: Message[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read", args: "{}" }, { id: "b1", name: "bash", args: "{}" }] },
    { role: "tool", content: "R".repeat(400), toolCallId: "r1" }, // read — must be left intact
    { role: "tool", content: "B".repeat(400), toolCallId: "b1" }, // bash — eligible
  ];
  const { messages, saved } = pruneToolOutputs(msgs, { protectRecentTokens: 0 });
  expect(messages[1]!.content).toBe("R".repeat(400)); // read untouched (D3 anchors)
  expect(messages[2]!.content).toContain("[output truncated");
  expect(saved).toBe(estimateTokens("B".repeat(400)));
});

test("pruneToolOutputs: a large protect window prunes nothing", () => {
  const msgs: Message[] = [{ role: "tool", content: "B".repeat(400), toolCallId: "b1" }];
  expect(pruneToolOutputs(msgs, { protectRecentTokens: 1_000_000 }).saved).toBe(0);
});

// --- serialize / summarize --------------------------------------------------

test("serializeConversation: renders roles + tool calls/results", () => {
  const s = serializeConversation(convo.slice(0, 3));
  expect(s).toContain("User: make a file");
  expect(s).toContain("Assistant called bash({})");
  expect(s).toContain("[tool result]");
});

function fakeProvider(events: StreamEvent[]): Provider {
  return {
    name: "deepseek",
    async *stream(): AsyncGenerator<StreamEvent> {
      for (const ev of events) yield ev;
    },
  };
}

test("summarize: drains a provider stream to text", async () => {
  const p = fakeProvider([{ type: "text", delta: "SUM" }, { type: "text", delta: "MARY" }, { type: "done", reason: "stop" }]);
  expect(await summarize(p, "m", convo, "sys", "", new AbortController().signal)).toBe("SUMMARY");
});

test("summarize: a provider error throws (so the caller leaves the session untouched)", async () => {
  const p = fakeProvider([{ type: "error", error: new Error("boom") }, { type: "done", reason: "error" }]);
  expect(summarize(p, "m", convo, "sys", "", new AbortController().signal)).rejects.toThrow("boom");
});

// --- Session compaction round-trip ------------------------------------------

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nerve-compact-"));
  process.env.NERVE_HOME = home;
});
afterEach(async () => {
  delete process.env.NERVE_HOME;
  await rm(home, { recursive: true, force: true });
});

test("Session.compact: rebuilds live context, and resume reconstructs the same shape (D17)", async () => {
  const s = new Session({ id: "C" });
  s.addUser("u1");
  s.apply({ type: "text", delta: "a1" });
  s.commitAssistant();
  s.addUser("u2");
  s.apply({ type: "text", delta: "a2" });
  s.commitAssistant(); // live: [u1, a1, u2, a2], total=4

  s.compact("THE SUMMARY", 2); // keep the last 2 (u2, a2)

  const live = s.messages.map((m) => [m.role, m.content]);
  expect(s.messages[0]!.role).toBe("user");
  expect(s.messages[0]!.content).toContain("THE SUMMARY");
  expect(live.slice(1)).toEqual([["user", "u2"], ["assistant", "a2"]]);
  await s.close();

  const r = loadSession(process.cwd(), "C");
  expect(r.total).toBe(4); // every message row still counted, for the next compaction's ordinals
  expect(r.messages.map((m) => [m.role, m.content])).toEqual(live); // resumed === live
});

test("loadSession: a non-compacted session returns all msgs unchanged", async () => {
  const s = new Session({ id: "N" });
  s.addUser("a");
  s.apply({ type: "text", delta: "b" });
  s.commitAssistant();
  await s.close();
  const r = loadSession(process.cwd(), "N");
  expect(r.total).toBe(2);
  expect(r.messages.map((m) => m.content)).toEqual(["a", "b"]);
});
