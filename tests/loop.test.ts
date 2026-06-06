import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loop } from "../src/loop.ts";
import { stopGuard } from "../src/interceptors.ts";
import { Session } from "../src/session.ts";
import type { Provider, StreamEvent } from "../src/providers/types.ts";

/** A provider that replays one scripted StreamEvent[] per turn. */
function fakeProvider(turns: StreamEvent[][]): Provider {
  let i = 0;
  return {
    name: "deepseek",
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<StreamEvent> {
      for (const ev of turns[i++] ?? [{ type: "done", reason: "stop" }]) yield ev;
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-loop-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("loop: streams, dispatches a tool call, feeds the result back, and finishes", async () => {
  const session = new Session({ id: "L", dir });
  session.addUser("make a file");

  const provider = fakeProvider([
    [
      { type: "text", delta: "I'll write it." },
      { type: "tool_call", index: 0, id: "c1", name: "write", args: `{"path":"out.txt","content":"hi"}` },
      { type: "done", reason: "tool_calls" },
    ],
    [
      { type: "text", delta: "Done." },
      { type: "done", reason: "stop" },
    ],
  ]);

  const toolResults: string[] = [];
  await loop({
    provider,
    session,
    model: "deepseek-v4-flash",
    mode: "yolo",
    ctx: { cwd: dir },
    interceptors: [],
    signal: new AbortController().signal,
    onToolResult: (_n, r) => toolResults.push(r),
  });

  expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  expect(session.messages[1]!.toolCalls?.[0]?.name).toBe("write");
  expect(session.messages[3]!.content).toBe("Done.");
  expect(toolResults[0]).toContain("Wrote out.txt");
  expect(await Bun.file(join(dir, "out.txt")).text()).toBe("hi");
  await session.close();
});

test("loop: a pre-aborted signal runs no turns", async () => {
  const session = new Session({ id: "A", dir });
  session.addUser("hi");
  const ac = new AbortController();
  ac.abort();
  await loop({
    provider: fakeProvider([[{ type: "text", delta: "should not run" }, { type: "done", reason: "stop" }]]),
    session,
    model: "m",
    mode: "yolo",
    ctx: { cwd: dir },
    interceptors: [],
    signal: ac.signal,
  });
  expect(session.messages.map((m) => m.role)).toEqual(["user"]); // nothing appended
  await session.close();
});

test("loop: a stop-guard ends the turn without dispatching tools", async () => {
  const session = new Session({ id: "S", dir });
  session.addUser("go");
  await loop({
    provider: fakeProvider([
      [
        { type: "text", delta: "BADWORD here" },
        { type: "tool_call", index: 0, id: "c1", name: "write", args: `{"path":"x","content":"y"}` },
        { type: "done", reason: "tool_calls" },
      ],
    ]),
    session,
    model: "m",
    mode: "yolo",
    ctx: { cwd: dir },
    interceptors: [stopGuard(["BADWORD"])],
    signal: new AbortController().signal,
  });
  expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]); // no tool result
  expect(await Bun.file(join(dir, "x")).exists()).toBe(false);
  await session.close();
});

test("loop: maxTurns caps a runaway tool-calling model", async () => {
  const session = new Session({ id: "M", dir });
  session.addUser("loop forever");
  // a provider that ALWAYS calls a readonly tool → would never stop on its own
  const alwaysCalls: Provider = {
    name: "deepseek",
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: "tool_call", index: 0, id: "c", name: "manual", args: "{}" };
      yield { type: "done", reason: "tool_calls" };
    },
  };
  await loop({
    provider: alwaysCalls,
    session,
    model: "m",
    mode: "yolo",
    ctx: { cwd: dir },
    interceptors: [],
    signal: new AbortController().signal,
    maxTurns: 3,
  });
  // 3 turns × (assistant + tool) + the initial user message
  expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(3);
  expect(session.messages.filter((m) => m.role === "tool")).toHaveLength(3);
  await session.close();
});
