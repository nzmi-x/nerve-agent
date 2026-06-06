import { test, expect } from "bun:test";
import { buildRequestBody, mapStream } from "../src/providers/gemini.ts";
import type { ProviderRequest, StreamEvent } from "../src/providers/types.ts";

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}
async function* framesOf(...chunks: unknown[]): AsyncGenerator<string> {
  for (const c of chunks) yield typeof c === "string" ? c : JSON.stringify(c);
}
const chunk = (parts: unknown[], finishReason: string | null = null, usage: unknown = null) => ({
  candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }],
  ...(usage ? { usageMetadata: usage } : {}),
});

// --- buildRequestBody -------------------------------------------------------

test("buildRequestBody: system → systemInstruction, user → contents, tools → functionDeclarations", () => {
  const req: ProviderRequest = {
    model: "gemini-3.5-flash",
    system: "be terse",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
  };
  const body = buildRequestBody(req);
  expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  expect(body.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
  expect(body.tools).toEqual([{ functionDeclarations: [{ name: "read", description: "read a file", parameters: { type: "object" } }] }]);
});

test("buildRequestBody: thinking true → thinkingConfig high; temperature never sent (3.x)", () => {
  const body = buildRequestBody({ model: "m", messages: [{ role: "user", content: "x" }], thinking: true, temperature: 0.7 });
  expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "high", includeThoughts: true } });
});

test("buildRequestBody: thinking false/absent → no generationConfig (model default)", () => {
  expect(buildRequestBody({ model: "m", messages: [{ role: "user", content: "x" }], thinking: false }).generationConfig).toBeUndefined();
  expect(buildRequestBody({ model: "m", messages: [{ role: "user", content: "x" }] }).generationConfig).toBeUndefined();
});

test("buildRequestBody: tool turn replays thoughtSignature on first call; results merge into one user turn", () => {
  const body = buildRequestBody({
    model: "m",
    messages: [
      { role: "user", content: "edit them" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "fc_1", name: "edit", args: '{"path":"a"}', signature: "SIG" },
          { id: "fc_2", name: "edit", args: '{"path":"b"}' }, // parallel call — no signature
        ],
      },
      { role: "tool", toolCallId: "fc_1", content: "ok a" },
      { role: "tool", toolCallId: "fc_2", content: "ok b" },
    ],
  });
  expect(body.contents).toEqual([
    { role: "user", parts: [{ text: "edit them" }] },
    {
      role: "model",
      parts: [
        { functionCall: { name: "edit", id: "fc_1", args: { path: "a" } }, thoughtSignature: "SIG" },
        { functionCall: { name: "edit", id: "fc_2", args: { path: "b" } } },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "edit", id: "fc_1", response: { result: "ok a" } } },
        { functionResponse: { name: "edit", id: "fc_2", response: { result: "ok b" } } },
      ],
    },
  ]);
});

// --- mapStream --------------------------------------------------------------

test("mapStream: thought part → reasoning, text part → text, usage once at end, done stop", async () => {
  const out = await collect(
    mapStream(framesOf(chunk([{ text: "hmm", thought: true }, { text: "hi" }], "STOP", { promptTokenCount: 5, candidatesTokenCount: 9 }))),
  );
  expect(out).toEqual([
    { type: "reasoning", delta: "hmm" },
    { type: "text", delta: "hi" },
    { type: "usage", input: 5, output: 9 },
    { type: "done", reason: "stop" },
  ] satisfies StreamEvent[]);
});

test("mapStream: a functionCall is complete in one part, carries id/name/args + thoughtSignature", async () => {
  const out = await collect(
    mapStream(framesOf(chunk([{ functionCall: { name: "edit", id: "fc_1", args: { path: "a" } }, thoughtSignature: "SIG" }], "STOP"))),
  );
  expect(out).toEqual([
    { type: "tool_call", index: 0, id: "fc_1", name: "edit", args: '{"path":"a"}', signature: "SIG" },
    { type: "done", reason: "stop" },
  ] satisfies StreamEvent[]);
});

test("mapStream: parallel calls get distinct indices; signature only on the first", async () => {
  const out = await collect(
    mapStream(
      framesOf(
        chunk(
          [
            { functionCall: { name: "read", id: "fc_1", args: { path: "a" } }, thoughtSignature: "SIG" },
            { functionCall: { name: "read", id: "fc_2", args: { path: "b" } } },
          ],
          "STOP",
        ),
      ),
    ),
  );
  expect(out).toEqual([
    { type: "tool_call", index: 0, id: "fc_1", name: "read", args: '{"path":"a"}', signature: "SIG" },
    { type: "tool_call", index: 1, id: "fc_2", name: "read", args: '{"path":"b"}' },
    { type: "done", reason: "stop" },
  ] satisfies StreamEvent[]);
});

test("mapStream: snake_case thought_signature is tolerated", async () => {
  const out = await collect(mapStream(framesOf(chunk([{ functionCall: { name: "x", id: "c", args: {} }, thought_signature: "SS" }], "STOP"))));
  expect(out[0]).toEqual({ type: "tool_call", index: 0, id: "c", name: "x", args: "{}", signature: "SS" });
});

test("mapStream: usageMetadata repeats → only the last is emitted; MAX_TOKENS → length", async () => {
  const out = await collect(
    mapStream(
      framesOf(
        chunk([{ text: "a" }], null, { promptTokenCount: 5, candidatesTokenCount: 1 }),
        chunk([{ text: "b" }], "MAX_TOKENS", { promptTokenCount: 5, candidatesTokenCount: 2 }),
      ),
    ),
  );
  expect(out).toEqual([
    { type: "text", delta: "a" },
    { type: "text", delta: "b" },
    { type: "usage", input: 5, output: 2 },
    { type: "done", reason: "length" },
  ] satisfies StreamEvent[]);
});

test("mapStream: SAFETY → safety; non-JSON frames skipped", async () => {
  const out = await collect(mapStream(framesOf("not json", chunk([{ text: "x" }], "SAFETY"))));
  expect(out).toEqual([
    { type: "text", delta: "x" },
    { type: "done", reason: "safety" },
  ] satisfies StreamEvent[]);
});
