import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectMemory, nestedMemory } from "../src/context.ts";

// D42/D12: load CLAUDE.md + AGENTS.md as agent context, resolving line-level @imports.

let dir: string;
let prevHome: string | undefined;
let prevNerveHome: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-ctx-"));
  prevHome = process.env.HOME;
  prevNerveHome = process.env.NERVE_HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "nerve-home-")); // clean home → no stray user-global CLAUDE.md
  process.env.NERVE_HOME = await mkdtemp(join(tmpdir(), "nerve-nh-")); // clean → no stray nerve-global/project memory
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  if (prevNerveHome !== undefined) process.env.NERVE_HOME = prevNerveHome;
  else delete process.env.NERVE_HOME;
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

test("loadProjectMemory: loads from an ecosystem dir (./.claude/CLAUDE.md, D47)", async () => {
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(join(dir, ".claude/CLAUDE.md"), "claude-dir guidance");
  expect(loadProjectMemory(dir)).toContain("claude-dir guidance");
});

test("nestedMemory: loads a subdir's CLAUDE.md only for a touched file under it (D48)", async () => {
  await mkdir(join(dir, "src/tools"), { recursive: true });
  await writeFile(join(dir, "src/tools/CLAUDE.md"), "tools-subdir rules");
  await mkdir(join(dir, "other"), { recursive: true });
  await writeFile(join(dir, "other/CLAUDE.md"), "other-subdir rules");

  // touch a file under src/tools → its ancestor CLAUDE.md loads; the untouched 'other' one does not
  const out = nestedMemory(dir, [join(dir, "src/tools/grep.ts")]);
  expect(out).toContain("tools-subdir rules");
  expect(out).not.toContain("other-subdir rules");

  expect(nestedMemory(dir, [])).toBe(""); // nothing touched → nothing nested
});
