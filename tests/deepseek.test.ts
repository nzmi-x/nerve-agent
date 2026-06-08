import { test, expect } from "bun:test";
import { buildRequestBody, mapStream } from "../src/providers/deepseek.ts";
import type { ProviderRequest, StreamEvent } from "../src/providers/types.ts";

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}
// build SSE data-payload frames the way sse() would yield them (JSON strings, then [DONE])
async function* framesOf(...chunks: unknown[]): AsyncGenerator<string> {
  for (const c of chunks) yield typeof c === "string" ? c : JSON.stringify(c);
}

// --- buildRequestBody -------------------------------------------------------

test("buildRequestBody: prepends system, sets stream + include_usage", () => {
  const req: ProviderRequest = {
    model: "deepseek-v4-flash",
    system: "be terse",
    messages: [{ role: "user", content: "hi" }],
  };
  const body = buildRequestBody(req);
  expect(body.model).toBe("deepseek-v4-flash");
  expect(body.stream).toBe(true);
  expect(body.stream_options).toEqual({ include_usage: true });
  expect(body.messages).toEqual([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ]);
  expect(body.thinking).toBeUndefined();
});

test("buildRequestBody: effort high → enabled + reasoning_effort, temperature omitted", () => {
  const body = buildRequestBody({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    effort: "high",
    temperature: 0.7,
  });
  expect(body.thinking).toEqual({ type: "enabled" });
  expect(body.reasoning_effort).toBe("high");
  expect(body.temperature).toBeUndefined(); // ignored under thinking (§1.6)
});

test("buildRequestBody: effort xhigh → enabled + xhigh", () => {
  const body = buildRequestBody({ model: "m", messages: [{ role: "user", content: "x" }], effort: "xhigh" });
  expect(body.thinking).toEqual({ type: "enabled" });
  expect(body.reasoning_effort).toBe("xhigh");
});

test("buildRequestBody: effort off → disabled, temperature kept", () => {
  const body = buildRequestBody({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    effort: "off",
    temperature: 0.2,
  });
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(body.temperature).toBe(0.2);
});

test("buildRequestBody: tools mapped + tool_choice auto", () => {
  const body = buildRequestBody({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
  });
  expect(body.tool_choice).toBe("auto");
  expect(body.tools).toEqual([
    { type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } },
  ]);
});

test("buildRequestBody: assistant tool-call turn replays reasoning_content; tool result mapped", () => {
  const body = buildRequestBody({
    model: "m",
    messages: [
      { role: "user", content: "edit it" },
      {
        role: "assistant",
        content: "",
        reasoning: "thought about it",
        toolCalls: [{ id: "call_1", name: "edit", args: '{"path":"a"}' }],
      },
      { role: "tool", toolCallId: "call_1", content: "ok" },
    ],
  });
  const messages = body.messages as Record<string, unknown>[];
  expect(messages[1]).toEqual({
    role: "assistant",
    content: "",
    reasoning_content: "thought about it",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "edit", arguments: '{"path":"a"}' } }],
  });
  expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok" });
});

// --- mapStream --------------------------------------------------------------

const delta = (d: Record<string, unknown>, finish_reason: string | null = null) => ({
  choices: [{ delta: d, finish_reason }],
});

test("mapStream: content + reasoning deltas → text/reasoning, then done:stop", async () => {
  const out = await collect(
    mapStream(framesOf(delta({ reasoning_content: "hmm" }), delta({ content: "hi" }), delta({}, "stop"), "[DONE]")),
  );
  expect(out).toEqual([
    { type: "reasoning", delta: "hmm" },
    { type: "text", delta: "hi" },
    { type: "done", reason: "stop" },
  ] satisfies StreamEvent[]);
});

test("mapStream: tool_call fragments keep their index; id/name only on the first", async () => {
  const out = await collect(
    mapStream(
      framesOf(
        delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "edit", arguments: '{"pa' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }),
        delta({}, "tool_calls"),
        "[DONE]",
      ),
    ),
  );
  expect(out).toEqual([
    { type: "tool_call", index: 0, id: "call_1", name: "edit", args: '{"pa' },
    { type: "tool_call", index: 0, id: undefined, name: undefined, args: 'th":"a"}' },
    { type: "done", reason: "tool_calls" },
  ] satisfies StreamEvent[]);
});

test("mapStream: trailing usage chunk → usage event before done", async () => {
  const out = await collect(
    mapStream(framesOf(delta({ content: "a" }), delta({}, "stop"), { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } }, "[DONE]")),
  );
  expect(out).toEqual([
    { type: "text", delta: "a" },
    { type: "usage", input: 5, output: 9 },
    { type: "done", reason: "stop" },
  ] satisfies StreamEvent[]);
});

test("mapStream: content_filter → safety; skips non-JSON frames", async () => {
  const out = await collect(mapStream(framesOf("not json", delta({ content: "x" }), delta({}, "content_filter"), "[DONE]")));
  expect(out).toEqual([
    { type: "text", delta: "x" },
    { type: "done", reason: "safety" },
  ] satisfies StreamEvent[]);
});
