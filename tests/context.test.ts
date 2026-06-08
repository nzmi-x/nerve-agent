import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectMemory } from "../src/context.ts";

// D42/D12: load CLAUDE.md + AGENTS.md as agent context, resolving line-level @imports.

let dir: string;
let prevHome: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-ctx-"));
  prevHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "nerve-home-")); // clean home → no stray user-global CLAUDE.md
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
});

test("loadProjectMemory: empty when there are no memory files", () => {
  expect(loadProjectMemory(dir)).toBe("");
});

test("loadProjectMemory: loads CLAUDE.md and AGENTS.md", async () => {
  await writeFile(join(dir, "CLAUDE.md"), "project rules here");
  await writeFile(join(dir, "AGENTS.md"), "agents spec here");
  const out = loadProjectMemory(dir);
  expect(out).toContain("project rules here");
  expect(out).toContain("agents spec here");
});

test("loadProjectMemory: resolves a line-level @import and inlines the target exactly once", async () => {
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(join(dir, ".claude/CLAUDE.md"), "the real guide");
  await writeFile(join(dir, "CLAUDE.md"), "@.claude/CLAUDE.md"); // root just imports the .claude one
  const out = loadProjectMemory(dir);
  expect(out).toContain("the real guide");
  expect(out).not.toContain("@.claude/CLAUDE.md"); // the directive was resolved, not left literal
  expect(out.match(/the real guide/g)?.length).toBe(1); // dedup: not appended a second time
});

test("loadProjectMemory: a missing @import target is left untouched (no crash)", async () => {
  await writeFile(join(dir, "CLAUDE.md"), "@nope/missing.md");
  expect(loadProjectMemory(dir)).toBe("@nope/missing.md");
});
