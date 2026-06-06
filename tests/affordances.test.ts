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
  expect(await atSuggestions("", dir)).toEqual(["README.md", "src/"]); // .hidden excluded
  expect(await atSuggestions(".", dir)).toEqual([".hidden"]); // dot prefix opts in
  expect(await atSuggestions("nope/", dir)).toEqual([]); // missing dir
});

// --- slash + commands -------------------------------------------------------

test("slashSuggestions: prefix-matches builtins and skills", () => {
  const names = (q: string) => slashSuggestions(q, [{ name: "opentui", description: "" }]).map((c) => c.name);
  expect(names("mo")).toEqual(["model", "mode"]);
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

test("discoverSkills: reads SKILL.md frontmatter (finds the bundled opentui skill)", async () => {
  const skills = await discoverSkills([resolve(".claude/skills")]);
  const opentui = skills.find((s) => s.name === "opentui");
  expect(opentui).toBeDefined();
  expect(opentui!.description.length).toBeGreaterThan(0);
});
