import { test, expect } from "bun:test";
import { isTransient, isContextOverflow, backoffMs, sleep } from "../src/retry.ts";

test("isTransient: rate-limit / 5xx / network errors are retryable", () => {
  for (const m of [
    "DeepSeek 429: too many requests",
    "DeepSeek 503: service unavailable",
    "DeepSeek 500: internal error",
    "model is overloaded, please try again",
    "fetch failed",
    "socket hang up",
    "connection reset by peer",
    "request timed out",
  ]) {
    expect(isTransient(new Error(m))).toBe(true);
  }
});

test("isTransient: client errors and context overflow are NOT retryable", () => {
  for (const m of [
    "DeepSeek 400: invalid request",
    "DeepSeek 401: unauthorized",
    "tool 'write' parameters failed validation",
    "maximum context length exceeded",
    "this model's context window is too small",
  ]) {
    expect(isTransient(new Error(m))).toBe(false);
  }
});

test("isContextOverflow: only context-window errors", () => {
  expect(isContextOverflow(new Error("maximum context length is 1048576 tokens"))).toBe(true);
  expect(isContextOverflow(new Error("prompt is too long"))).toBe(true);
  expect(isContextOverflow(new Error("DeepSeek 429: too many requests"))).toBe(false);
});

test("backoffMs: exponential, capped", () => {
  expect(backoffMs(1, 1000, 30000)).toBe(1000);
  expect(backoffMs(2, 1000, 30000)).toBe(2000);
  expect(backoffMs(3, 1000, 30000)).toBe(4000);
  expect(backoffMs(20, 1000, 30000)).toBe(30000);
});

test("sleep: resolves true normally, false when aborted", async () => {
  expect(await sleep(2, new AbortController().signal)).toBe(true);
  const ac = new AbortController();
  ac.abort();
  expect(await sleep(2, ac.signal)).toBe(false);
});
