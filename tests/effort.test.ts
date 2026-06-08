import { test, expect } from "bun:test";
import { modelEffort, effortLabel, PROVIDER_EFFORTS } from "../src/effort.ts";

test("PROVIDER_EFFORTS: DeepSeek can turn thinking off; Gemini's floor is minimal (§10)", () => {
  expect(PROVIDER_EFFORTS.deepseek).toEqual(["off", "high", "xhigh"]);
  expect(PROVIDER_EFFORTS.gemini).toEqual(["minimal", "low", "medium", "high"]);
  expect(PROVIDER_EFFORTS.gemini).not.toContain("off"); // Gemini 3 always thinks — minimal is the floor
});

test("modelEffort: a valid configured level passes through", () => {
  expect(modelEffort("deepseek", "high")).toBe("high");
  expect(modelEffort("deepseek", "xhigh")).toBe("xhigh");
  expect(modelEffort("gemini", "medium")).toBe("medium");
  expect(modelEffort("gemini", "minimal")).toBe("minimal");
});

test("modelEffort: a level the provider doesn't support → off", () => {
  expect(modelEffort("deepseek", "medium")).toBe("off"); // DeepSeek has no medium
  expect(modelEffort("gemini", "xhigh")).toBe("off"); // Gemini has no xhigh
  expect(modelEffort("deepseek", "bogus")).toBe("off");
});

test("modelEffort: legacy `thinking` boolean maps true→high, false→off", () => {
  expect(modelEffort("deepseek", true)).toBe("high");
  expect(modelEffort("deepseek", false)).toBe("off");
});

test("modelEffort: unset → off (the D11 speed default)", () => {
  expect(modelEffort("deepseek", undefined)).toBe("off");
  expect(modelEffort("gemini", null)).toBe("off");
});

test("effortLabel: identity (off stays off)", () => {
  expect(effortLabel("off")).toBe("off");
  expect(effortLabel("xhigh")).toBe("xhigh");
});
