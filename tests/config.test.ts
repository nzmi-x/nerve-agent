import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadModels, selectModel, selectSubagentModel, providerFor, entryEffort, modelEfforts } from "../src/config.ts";

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

test("entryEffort / modelEfforts: default effort + selectable set, with the per-model override (D52)", () => {
  // default effort: configured value, legacy boolean, else off
  expect(entryEffort({ id: "a", provider: "deepseek", effort: "high" })).toBe("high");
  expect(entryEffort({ id: "a", provider: "deepseek", thinking: true })).toBe("high"); // legacy
  expect(entryEffort({ id: "a", provider: "gemini" })).toBe("off"); // unset
  // selectable set: provider default, or the model's `efforts` override (filtered to valid levels)
  expect(modelEfforts({ id: "g", provider: "gemini" })).toEqual(["minimal", "low", "medium", "high"]);
  expect(modelEfforts({ id: "d", provider: "deepseek" })).toEqual(["off", "high", "xhigh"]);
  expect(modelEfforts({ id: "pro", provider: "gemini", efforts: ["low", "medium", "high"] })).toEqual(["low", "medium", "high"]);
  expect(modelEfforts({ id: "x", provider: "gemini", efforts: ["low", "xhigh"] })).toEqual(["low"]); // xhigh isn't a Gemini level → filtered out
});

test("loadModels: the catalog's Gemini Pro models drop `minimal` (§10)", () => {
  const saved = Bun.env.NERVE_HOME;
  Bun.env.NERVE_HOME = join(tmpdir(), "nerve-no-global-config2");
  try {
    const models = loadModels();
    const pro = models.find((m) => m.id === "gemini-3.1-pro-preview")!;
    expect(modelEfforts(pro)).not.toContain("minimal");
    const flash = models.find((m) => m.id === "gemini-3.5-flash")!;
    expect(modelEfforts(flash)).toContain("minimal"); // Flash supports it
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
