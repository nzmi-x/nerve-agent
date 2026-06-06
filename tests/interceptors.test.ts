import { test, expect } from "bun:test";
import { pipe, type StreamCtl } from "../src/stream.ts";
import { reasoningRouter, secretRedaction, stopGuard, tokenTap } from "../src/interceptors.ts";
import type { Session } from "../src/session.ts";
import type { StreamEvent } from "../src/providers/types.ts";

const text = (delta: string): StreamEvent => ({ type: "text", delta });
function fakeCtl(accumulated = ""): { ctl: StreamCtl; aborted: () => boolean } {
  let ab = false;
  return {
    ctl: { abort: () => { ab = true; }, emit: () => {}, get text() { return accumulated; } },
    aborted: () => ab,
  };
}
async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}
async function* events(...evs: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of evs) yield e;
}

test("secretRedaction: scrubs secret-looking tokens, leaves clean text", () => {
  const ic = secretRedaction();
  expect(ic({ type: "text", delta: "key=sk-ABCDEFGHIJKLMNOP123" }, fakeCtl().ctl)).toEqual({
    type: "text",
    delta: "key=[redacted]",
  });
  expect(ic(text("nothing secret"), fakeCtl().ctl)).toBeUndefined();
});

test("stopGuard: aborts when accumulated text matches a banned pattern", () => {
  const a = fakeCtl("go ");
  stopGuard(["STOP"])(text("STOP"), a.ctl);
  expect(a.aborted()).toBe(true);

  const b = fakeCtl("");
  stopGuard([])(text("anything"), b.ctl); // no patterns → never aborts
  expect(b.aborted()).toBe(false);
});

test("reasoningRouter / tokenTap forward the right events", () => {
  const seen: string[] = [];
  reasoningRouter((d) => seen.push(d))({ type: "reasoning", delta: "think" }, fakeCtl().ctl);
  reasoningRouter((d) => seen.push(d))(text("answer"), fakeCtl().ctl);
  expect(seen).toEqual(["think"]); // only reasoning routed

  const tapped: StreamEvent[] = [];
  const stub = { tap: (ev: StreamEvent) => tapped.push(ev) } as unknown as Session;
  tokenTap(stub)(text("x"), fakeCtl().ctl);
  expect(tapped).toEqual([text("x")]);
});

test("pipe: redaction runs before the tap, so the tap logs the scrubbed delta", async () => {
  const logged: StreamEvent[] = [];
  const stub = { tap: (ev: StreamEvent) => logged.push(ev) } as unknown as Session;
  const out = await collect(
    pipe(events(text("k=sk-ABCDEFGHIJKLMNOP123")), [secretRedaction(), tokenTap(stub)], new AbortController()),
  );
  expect(out).toEqual([text("k=[redacted]")]);
  expect(logged).toEqual([text("k=[redacted]")]);
});

test("pipe: stopGuard aborts the stream mid-flight", async () => {
  const ac = new AbortController();
  const out = await collect(pipe(events(text("go "), text("BADWORD"), text(" more")), [stopGuard(["BADWORD"])], ac));
  expect(out).toEqual([text("go "), text("BADWORD")]);
  expect(ac.signal.aborted).toBe(true);
});
