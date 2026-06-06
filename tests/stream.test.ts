import { test, expect } from "bun:test";
import { sse, pipe, type Interceptor } from "../src/stream.ts";
import type { StreamEvent } from "../src/providers/types.ts";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}

async function* events(...evs: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of evs) yield e;
}

const text = (delta: string): StreamEvent => ({ type: "text", delta });

// --- sse() ------------------------------------------------------------------

test("sse: parses a data frame", async () => {
  expect(await collect(sse(streamOf('data: {"a":1}\n\n')))).toEqual(['{"a":1}']);
});

test("sse: skips ':' keep-alive comments and blank lines", async () => {
  expect(await collect(sse(streamOf(": keep-alive\n\ndata: hi\n\n")))).toEqual(["hi"]);
});

test("sse: reassembles a payload split across chunks", async () => {
  expect(await collect(sse(streamOf("data: hel", "lo\n", "\n")))).toEqual(["hello"]);
});

test("sse: tolerates CRLF, a missing trailing blank line, and yields [DONE] verbatim", async () => {
  expect(await collect(sse(streamOf("data: a\r\n\r\ndata: [DONE]\n")))).toEqual(["a", "[DONE]"]);
});

// --- pipe() -----------------------------------------------------------------

test("pipe: passthrough + observe sees every event", async () => {
  const seen: string[] = [];
  const tap: Interceptor = (ev) => {
    if (ev.type === "text") seen.push(ev.delta);
  };
  const out = await collect(pipe(events(text("a"), text("b")), [tap], new AbortController()));
  expect(out).toEqual([text("a"), text("b")]);
  expect(seen).toEqual(["a", "b"]);
});

test("pipe: rewrite mutates the event", async () => {
  const upper: Interceptor = (ev) =>
    ev.type === "text" ? { type: "text", delta: ev.delta.toUpperCase() } : ev;
  expect(await collect(pipe(events(text("hi")), [upper], new AbortController()))).toEqual([text("HI")]);
});

test("pipe: returning null drops the event", async () => {
  const dropReasoning: Interceptor = (ev) => (ev.type === "reasoning" ? null : ev);
  const out = await collect(
    pipe(events({ type: "reasoning", delta: "x" }, text("y")), [dropReasoning], new AbortController()),
  );
  expect(out).toEqual([text("y")]);
});

test("pipe: ctl.abort() stops the stream mid-flight", async () => {
  const ac = new AbortController();
  const guard: Interceptor = (ev, ctl) => {
    if (ev.type === "text" && (ctl.text + ev.delta).includes("STOP")) ctl.abort();
    return ev;
  };
  const out = await collect(pipe(events(text("go "), text("STOP"), text(" never")), [guard], ac));
  expect(out).toEqual([text("go "), text("STOP")]);
  expect(ac.signal.aborted).toBe(true);
});

test("pipe: ctl.emit() injects a synthetic event downstream", async () => {
  const inject: Interceptor = (ev, ctl) => {
    if (ev.type === "text" && ev.delta === "a") ctl.emit({ type: "usage", input: 1, output: 2 });
    return ev;
  };
  const out = await collect(pipe(events(text("a")), [inject], new AbortController()));
  expect(out).toEqual([text("a"), { type: "usage", input: 1, output: 2 }]);
});

test("pipe: ctl.text accumulates post-transform visible text", async () => {
  const seen: string[] = [];
  const record: Interceptor = (ev, ctl) => {
    seen.push(ctl.text);
    return ev;
  };
  await collect(pipe(events(text("a"), text("b"), text("c")), [record], new AbortController()));
  expect(seen).toEqual(["", "a", "ab"]);
});

test("pipe: ordering — redaction before tap means the tap logs the scrubbed delta", async () => {
  const logged: string[] = [];
  const redact: Interceptor = (ev) =>
    ev.type === "text" ? { type: "text", delta: ev.delta.replace("sk-secret", "[redacted]") } : ev;
  const tap: Interceptor = (ev) => {
    if (ev.type === "text") logged.push(ev.delta);
  };
  const out = await collect(pipe(events(text("key=sk-secret")), [redact, tap], new AbortController()));
  expect(out).toEqual([text("key=[redacted]")]);
  expect(logged).toEqual(["key=[redacted]"]);
});
