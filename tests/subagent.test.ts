import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSubagent } from "../src/subagent.ts";
import type { Provider, StreamEvent } from "../src/providers/types.ts";

/** A provider that replays one scripted StreamEvent[] per turn (same shape as the loop test's fake). */
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

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nerve-subagent-"));
  process.env.NERVE_HOME = home; // the ephemeral session still opens a DB handle — isolate it
});
afterEach(async () => {
  delete process.env.NERVE_HOME;
  await rm(home, { recursive: true, force: true });
});

const opts = (provider: Provider) => ({ prompt: "find callers of foo", provider, model: "x", tools: [], cwd: process.cwd(), signal: new AbortController().signal });

test("runSubagent: runs the loop and returns the final assistant summary (D6)", async () => {
  const out = await runSubagent(opts(fakeProvider([[{ type: "text", delta: "Found 3 callers of foo." }, { type: "done", reason: "stop" }]])));
  expect(out).toBe("Found 3 callers of foo.");
});

test("runSubagent: a no-output run reports it instead of throwing", async () => {
  const out = await runSubagent(opts(fakeProvider([[{ type: "done", reason: "stop" }]])));
  expect(out).toContain("no output");
});
