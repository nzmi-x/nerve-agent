import { test, expect } from "bun:test";
import { loadModels, selectModel, providerFor } from "../src/config.ts";

test("loadModels: reads the committed catalog; default is deepseek-v4-flash", () => {
  const models = loadModels();
  expect(models.length).toBeGreaterThanOrEqual(2);
  expect(selectModel(models).id).toBe("deepseek-v4-flash");
});

test("selectModel: by id, default fallback, and unknown throws", () => {
  const models = [
    { id: "a", provider: "deepseek" as const },
    { id: "b", provider: "gemini" as const, default: true },
  ];
  expect(selectModel(models).id).toBe("b"); // default
  expect(selectModel(models, "a").id).toBe("a"); // by id
  expect(() => selectModel(models, "z")).toThrow(/unknown model/);
  expect(selectModel([{ id: "only", provider: "deepseek" as const }]).id).toBe("only"); // first fallback
});

test("providerFor: deepseek needs its key; gemini is not implemented", () => {
  const ds = { id: "deepseek-v4-flash", provider: "deepseek" as const };
  const saved = Bun.env.DEEPSEEK_API_KEY;
  try {
    Bun.env.DEEPSEEK_API_KEY = "test-key";
    expect(providerFor(ds).name).toBe("deepseek");
    delete Bun.env.DEEPSEEK_API_KEY;
    expect(() => providerFor(ds)).toThrow(/DEEPSEEK_API_KEY is not set/);
  } finally {
    if (saved === undefined) delete Bun.env.DEEPSEEK_API_KEY;
    else Bun.env.DEEPSEEK_API_KEY = saved;
  }
  expect(() => providerFor({ id: "g", provider: "gemini" as const })).toThrow(/isn't implemented yet/);
});
