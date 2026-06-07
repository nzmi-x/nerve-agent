import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseAffordance,
  atSuggestions,
  slashSuggestions,
  parseSlash,
  applyAtSuggestion,
  discoverSkills,
  loadSkillBody,
  pasteToken,
  toolArgSummary,
  expandPastes,
} from "../src/tui/affordances.ts";

// --- parseAffordance --------------------------------------------------------

test("parseAffordance: detects !, /, @, and plain messages", () => {
  expect(parseAffordance("!ls -la")).toEqual({ kind: "bang", command: "ls -la" });
  expect(parseAffordance("/mod")).toEqual({ kind: "slash", query: "mod" });
  expect(parseAffordance("look at @src/pr")).toEqual({ kind: "at", query: "src/pr" });
  expect(parseAffordance("@")).toEqual({ kind: "at", query: "" });
  expect(parseAffordance("email@host")).toEqual({ kind: "message" }); // @ not at a boundary
  expect(parseAffordance("see @a then more")).toEqual({ kind: "message" }); // ref already complete
  expect(parseAffordance("just text")).toEqual({ kind: "message" });
});

// --- atSuggestions ----------------------------------------------------------

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-aff-"));
  await Bun.write(join(dir, "src/stream.ts"), "");
  await Bun.write(join(dir, "src/providers/types.ts"), "");
  await Bun.write(join(dir, "README.md"), "");
  await Bun.write(join(dir, ".hidden"), "");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("atSuggestions: completes paths; dirs get '/'; dotfiles hidden unless asked", async () => {
  expect(await atSuggestions("src/", dir)).toEqual(["src/providers/", "src/stream.ts"]);
  expect(await atSuggestions("RE", dir)).toEqual(["README.md"]);
  expect(await atSuggestions("re", dir)).toEqual(["README.md"]); // case-insensitive
  expect(await atSuggestions("", dir)).toEqual(["README.md", "src/"]); // .hidden excluded
  expect(await atSuggestions(".", dir)).toEqual([".hidden"]); // dot prefix opts in
  expect(await atSuggestions("nope/", dir)).toEqual([]); // missing dir
});

// --- slash + commands -------------------------------------------------------

test("slashSuggestions: prefix-matches builtins and skills", () => {
  const names = (q: string) => slashSuggestions(q, [{ name: "opentui", description: "" }]).map((c) => c.name);
  expect(names("mo")).toEqual(["models", "mode", "mouse"]);
  expect(names("dr")).toEqual(["drop"]);
  expect(names("op")).toEqual(["opentui"]); // a skill
  expect(names("")).toContain("help");
});

test("parseSlash: splits name + args", () => {
  expect(parseSlash("/model gemini-3.5-flash")).toEqual({ name: "model", args: ["gemini-3.5-flash"] });
  expect(parseSlash("/help")).toEqual({ name: "help", args: [] });
});

test("applyAtSuggestion: replaces the active @token", () => {
  expect(applyAtSuggestion("look @src/pr", "src/providers/")).toBe("look @src/providers/");
});

// --- discoverSkills (against the repo's real .claude/skills) -----------------

test("discoverSkills: reads SKILL.md frontmatter + captures the path for lazy invocation (D12)", async () => {
  const skills = await discoverSkills([resolve(".claude/skills")]);
  const opentui = skills.find((s) => s.name === "opentui");
  expect(opentui).toBeDefined();
  expect(opentui!.description.length).toBeGreaterThan(0);
  expect(opentui!.path).toContain(join("opentui", "SKILL.md"));
});

test("toolArgSummary: shows the salient arg per tool, quotes patterns, truncates, tolerates junk", () => {
  expect(toolArgSummary("read", '{"path":"src/app.ts"}')).toBe("src/app.ts");
  expect(toolArgSummary("bash", '{"command":"mkdir -p ./x && cat x"}')).toBe("mkdir -p ./x && cat x");
  expect(toolArgSummary("grep", '{"pattern":"export fn","path":"src"}')).toBe('"export fn" in src');
  expect(toolArgSummary("search", '{"query":"bun runtime"}')).toBe('"bun runtime"');
  expect(toolArgSummary("lsp", '{"op":"hover","path":"a.py","line":3}')).toBe("hover a.py");
  expect(toolArgSummary("manual", "{}")).toBe("(index)");
  expect(toolArgSummary("task", '{"prompt":"find callers\\nof foo"}')).toBe("find callers");
  expect(toolArgSummary("read", "not json")).toBe(""); // malformed → empty, no throw
  expect(toolArgSummary("write", `{"path":"${"x".repeat(80)}"}`).endsWith("…")).toBe(true); // truncated
});

test("pasteToken: line count for multi-line / long pastes, null for short single-line (#3)", () => {
  expect(pasteToken("just a short line")).toBeNull();
  expect(pasteToken("one short line\n")).toBeNull(); // a trailing newline alone is still 1 short line
  expect(pasteToken("a\nb\nc")).toBe(3);
  expect(pasteToken("a\nb\n")).toBe(2); // trailing newline ignored → 2 lines
  expect(pasteToken("x".repeat(250))).toBe(1); // long single line still collapses
});

test("expandPastes: substitutes by id; a deleted token just drops its paste; clears the stash (#3)", () => {
  const stash = new Map<number, string>([
    [1, "FULL ONE"],
    [2, "FULL TWO"],
  ]);
  // token #2 was deleted from the message → only #1 resolves, #2 is dropped (no order dependence)
  const out = expandPastes("see [Pasted 2 lines #1] only please", stash);
  expect(out).toBe("see FULL ONE only please");
  expect(stash.size).toBe(0); // consumed
  expect(expandPastes("nothing to do", new Map())).toBe("nothing to do");
});

test("loadSkillBody: strips frontmatter, returns the skill instructions (D12)", async () => {
  const skills = await discoverSkills([resolve(".claude/skills")]);
  const opentui = skills.find((s) => s.name === "opentui")!;
  const body = await loadSkillBody(opentui.path);
  expect(body.length).toBeGreaterThan(0);
  expect(body.startsWith("---")).toBe(false); // YAML frontmatter removed
});
