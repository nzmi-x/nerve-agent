import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loop } from "../src/loop.ts";
import { stopGuard } from "../src/interceptors.ts";
import { Session } from "../src/session.ts";
import { tools as registryTools } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/types.ts";
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
  process.env.NERVE_HOME = dir; // isolate the session DB per test
});
afterEach(async () => {
  delete process.env.NERVE_HOME;
  await rm(dir, { recursive: true, force: true });
});

test("loop: streams, dispatches a tool call, feeds the result back, and finishes", async () => {
  const session = new Session({ id: "L" });
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
    mode: "edit",
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
  const session = new Session({ id: "A" });
  session.addUser("hi");
  const ac = new AbortController();
  ac.abort();
  await loop({
    provider: fakeProvider([[{ type: "text", delta: "should not run" }, { type: "done", reason: "stop" }]]),
    session,
    model: "m",
    mode: "edit",
    ctx: { cwd: dir },
    interceptors: [],
    signal: ac.signal,
  });
  expect(session.messages.map((m) => m.role)).toEqual(["user"]); // nothing appended
  await session.close();
});

test("loop: a stop-guard ends the turn without dispatching tools", async () => {
  const session = new Session({ id: "S" });
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
    mode: "edit",
    ctx: { cwd: dir },
    interceptors: [stopGuard(["BADWORD"])],
    signal: new AbortController().signal,
  });
  expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]); // no tool result
  expect(await Bun.file(join(dir, "x")).exists()).toBe(false);
  await session.close();
});

test("loop: a transient error falls down the model ladder and recovers (D15)", async () => {
  const session = new Session({ id: "R" });
  session.addUser("hi");
  const primary = fakeProvider([[{ type: "error", error: new Error("DeepSeek 429: too many requests") }, { type: "done", reason: "error" }]]);
  const fallback = fakeProvider([[{ type: "text", delta: "recovered" }, { type: "done", reason: "stop" }]]);
  const retries: string[] = [];
  let errored = false;

  await loop({
    provider: primary,
    session,
    model: "deepseek-v4-flash",
    mode: "edit",
    ctx: { cwd: dir },
    interceptors: [],
    signal: new AbortController().signal,
    fallbacks: [{ provider: fallback, model: "deepseek-v4-pro" }],
    onRetry: (i) => retries.push(i.model),
    onError: () => (errored = true),
  });

  expect(errored).toBe(false);
  expect(retries).toEqual(["deepseek-v4-pro"]); // ladder switch, delay 0
  expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]); // failed turn not committed
  expect(session.messages[1]!.content).toBe("recovered");
  await session.close();
});

test("loop: backs off and retries the same candidate when there is no fallback (D15)", async () => {
  const session = new Session({ id: "B" });
  session.addUser("hi");
  const provider = fakeProvider([
    [{ type: "error", error: new Error("overloaded") }, { type: "done", reason: "error" }],
    [{ type: "text", delta: "ok" }, { type: "done", reason: "stop" }],
  ]);
  let attempts = 0;
  await loop({
    provider,
    session,
    model: "m",
    mode: "edit",
    ctx: { cwd: dir },
    interceptors: [],
    signal: new AbortController().signal,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    onRetry: () => attempts++,
  });
  expect(attempts).toBe(1);
  expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(session.messages[1]!.content).toBe("ok");
  await session.close();
});

test("loop: a non-transient error gives up via onError, no retry, nothing committed (D15)", async () => {
  const session = new Session({ id: "E" });
  session.addUser("hi");
  const provider = fakeProvider([[{ type: "error", error: new Error("DeepSeek 400: bad request") }, { type: "done", reason: "error" }]]);
  let captured: unknown = null;
  let retried = false;
  await loop({
    provider,
    session,
    model: "m",
    mode: "edit",
    ctx: { cwd: dir },
    interceptors: [],
    signal: new AbortController().signal,
    onRetry: () => (retried = true),
    onError: (e) => (captured = e),
  });
  expect(retried).toBe(false);
  expect(captured).toBeInstanceOf(Error);
  expect(session.messages.map((m) => m.role)).toEqual(["user"]); // no assistant committed
  await session.close();
});

test("loop: maxTurns caps a runaway tool-calling model", async () => {
  const session = new Session({ id: "M" });
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
    mode: "edit",
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

test("loop: read-only tool calls run concurrently; mutating ones serialize; results stay in call order", async () => {
  const order: string[] = [];
  const mk = (name: string, readonly: boolean): Tool => ({
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    readonly,
    async run() {
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, 40));
      order.push(`${name}-`);
      return name;
    },
  });
  registryTools.push(mk("ro_a", true), mk("ro_b", true), mk("mu_a", false), mk("mu_b", false));
  try {
    const session = new Session({ id: "PAR" });
    session.addUser("go");
    await loop({
      provider: fakeProvider([
        [
          { type: "tool_call", index: 0, id: "r1", name: "ro_a", args: "{}" },
          { type: "tool_call", index: 1, id: "r2", name: "ro_b", args: "{}" },
          { type: "tool_call", index: 2, id: "m1", name: "mu_a", args: "{}" },
          { type: "tool_call", index: 3, id: "m2", name: "mu_b", args: "{}" },
          { type: "done", reason: "tool_calls" },
        ],
        [{ type: "text", delta: "ok" }, { type: "done", reason: "stop" }],
      ]),
      session,
      model: "x",
      mode: "edit", // so the mutating fakes aren't refused by the PLAN gate
      ctx: { cwd: dir },
      interceptors: [],
      signal: new AbortController().signal,
    });

    // both read-only tools STARTED before either finished → they ran concurrently.
    expect(order.slice(0, 2).sort()).toEqual(["ro_a+", "ro_b+"]);
    // the mutating tools ran strictly one-after-another, each finishing before the next began.
    expect(order.filter((o) => o.startsWith("mu_"))).toEqual(["mu_a+", "mu_a-", "mu_b+", "mu_b-"]);
    // tool results were added to the session in the model's original call order.
    expect(session.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["ro_a", "ro_b", "mu_a", "mu_b"]);
    await session.close();
  } finally {
    registryTools.splice(registryTools.length - 4, 4); // remove the fakes
  }
});
