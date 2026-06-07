import { test, expect } from "bun:test";
import { langForFile, activePacks, langSkills, defaultSkills, checkSummary, triagePrompt, LANGPACKS } from "../src/langpack.ts";

test("triagePrompt: presents the triage buckets + includes the check summaries", () => {
  const p = triagePrompt(["pyrefly:\n  a.py:1: bad type", "ruff: clean"]);
  expect(p).toContain("Triage");
  expect(p.toLowerCase()).toContain("critical");
  expect(p.toLowerCase()).toContain("not critical");
  expect(p).toContain("bad type");
});

test("checkSummary: a clean report ends with ': clean' (drives the no-auto-continue path)", () => {
  expect(checkSummary("ruff", "All checks passed!").endsWith(": clean")).toBe(true);
  expect(checkSummary("pyrefly", "a.py:1:1 error: bad").endsWith(": clean")).toBe(false);
});

test("langForFile / activePacks: python + typescript by extension, deduped; others ignored", () => {
  expect(langForFile("a/b.py")?.id).toBe("python");
  expect(langForFile("a/b.pyi")?.id).toBe("python");
  expect(langForFile("a/b.tsx")?.id).toBe("typescript");
  expect(langForFile("a/b.js")?.id).toBe("typescript");
  expect(langForFile("a/b.md")).toBeUndefined();
  expect(activePacks(["x.py", "y.py", "z.ts"]).map((p) => p.id)).toEqual(["python", "typescript"]);
  expect(activePacks(["a.md", "b.txt"])).toEqual([]);
});

test("langSkills: loads pyrefly + ruff + marimo + prettier guidance with frontmatter stripped", async () => {
  const text = await langSkills(LANGPACKS);
  expect(text).toContain("pyrefly");
  expect(text).toContain("ruff");
  expect(text).toContain("marimo"); // notebooks ship with the python pack
  expect(text).toContain("prettier");
  expect(text).toContain("D24"); // tells the agent nerve auto-runs them
  expect(text).not.toContain("name: pyrefly"); // YAML frontmatter removed
});

test("defaultSkills: git-commit is always-on (loaded regardless of language), frontmatter stripped", async () => {
  const text = await defaultSkills();
  expect(text).toContain("Conventional Commit");
  expect(text).toContain("feat");
  expect(text).not.toContain("name: git-commit"); // YAML frontmatter removed
});

test("checkSummary: clean detection, noise filtered, issues passed through", () => {
  expect(checkSummary("ruff", "All checks passed!")).toBe("ruff: clean");
  expect(checkSummary("pyrefly", " INFO 0 errors\nNo `pyrefly.toml` found — using preset")).toBe("pyrefly: clean");
  const issues = checkSummary("ruff", "app.py:10:5 F841 local var unused\nFound 1 error");
  expect(issues.startsWith("ruff:")).toBe(true);
  expect(issues).toContain("F841");
});
