import { test, expect } from "bun:test";
import { langForFile, activePacks, langSkills, checkSummary, LANGPACKS } from "../src/langpack.ts";

test("langForFile / activePacks: python by extension, deduped; others ignored", () => {
  expect(langForFile("a/b.py")?.id).toBe("python");
  expect(langForFile("a/b.pyi")?.id).toBe("python");
  expect(langForFile("a/b.ts")).toBeUndefined();
  expect(activePacks(["x.py", "y.py", "z.ts"]).map((p) => p.id)).toEqual(["python"]);
  expect(activePacks(["z.ts", "a.md"])).toEqual([]);
});

test("langSkills: loads pyrefly + ruff guidance with frontmatter stripped", async () => {
  const text = await langSkills(LANGPACKS);
  expect(text).toContain("pyrefly");
  expect(text).toContain("ruff");
  expect(text).toContain("D24"); // tells the agent nerve auto-runs them
  expect(text).not.toContain("name: pyrefly"); // YAML frontmatter removed
});

test("checkSummary: clean detection, noise filtered, issues passed through", () => {
  expect(checkSummary("ruff", "All checks passed!")).toBe("ruff: clean");
  expect(checkSummary("pyrefly", " INFO 0 errors\nNo `pyrefly.toml` found — using preset")).toBe("pyrefly: clean");
  const issues = checkSummary("ruff", "app.py:10:5 F841 local var unused\nFound 1 error");
  expect(issues.startsWith("ruff:")).toBe(true);
  expect(issues).toContain("F841");
});
