import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadModels, selectModel, selectSubagentModel, providerFor } from "../src/config.ts";

test("loadModels: bundled catalog (no global override); default is deepseek-v4-flash", () => {
  const saved = Bun.env.NERVE_HOME;
  Bun.env.NERVE_HOME = join(tmpdir(), "nerve-no-global-config"); // a home with no models.json → bundled
  try {
    const models = loadModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(selectModel(models).id).toBe("deepseek-v4-flash");
  } finally {
    if (saved === undefined) delete Bun.env.NERVE_HOME;
    else Bun.env.NERVE_HOME = saved;
  }
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

test("selectSubagentModel: the subagent-flagged model, else the default (D6)", () => {
  const flagged = [
    { id: "pro", provider: "deepseek" as const, default: true },
    { id: "flash", provider: "deepseek" as const, subagent: true },
  ];
  expect(selectSubagentModel(flagged).id).toBe("flash");
  const none = [
    { id: "a", provider: "deepseek" as const },
    { id: "b", provider: "gemini" as const, default: true },
  ];
  expect(selectSubagentModel(none).id).toBe("b"); // falls back to the default
});

test("providerFor: each provider needs its key, then resolves", () => {
  const withKey = (name: "DEEPSEEK_API_KEY" | "GEMINI_API_KEY", fn: () => void): void => {
    const saved = Bun.env[name];
    try {
      Bun.env[name] = "test-key";
      fn();
    } finally {
      if (saved === undefined) delete Bun.env[name];
      else Bun.env[name] = saved;
    }
  };

  const ds = { id: "deepseek-v4-flash", provider: "deepseek" as const };
  const ge = { id: "gemini-3.5-flash", provider: "gemini" as const };
  withKey("DEEPSEEK_API_KEY", () => expect(providerFor(ds).name).toBe("deepseek"));
  withKey("GEMINI_API_KEY", () => expect(providerFor(ge).name).toBe("gemini"));

  const savedG = Bun.env.GEMINI_API_KEY;
  try {
    delete Bun.env.GEMINI_API_KEY;
    expect(() => providerFor(ge)).toThrow(/GEMINI_API_KEY is not set/);
  } finally {
    if (savedG !== undefined) Bun.env.GEMINI_API_KEY = savedG;
  }
});
