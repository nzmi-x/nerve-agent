import { test, expect, afterEach } from "bun:test";
import { projectSlug, projectDir, sessionsDir, skillRoots, commandRoots, globalModelsPath } from "../src/paths.ts";

const saved = Bun.env.NERVE_HOME;
afterEach(() => {
  if (saved === undefined) delete Bun.env.NERVE_HOME;
  else Bun.env.NERVE_HOME = saved;
});

test("projectSlug: absolute cwd with '/' → '-' (Claude-style, collision-free)", () => {
  expect(projectSlug("/home/naz/Documents/nerve")).toBe("-home-naz-Documents-nerve");
  expect(projectSlug("/a/b")).toBe("-a-b");
});

test("paths hang off $NERVE_HOME/projects/<slug>", () => {
  Bun.env.NERVE_HOME = "/tmp/nh";
  expect(projectDir("/work/repo")).toBe("/tmp/nh/projects/-work-repo");
  expect(sessionsDir("/work/repo")).toBe("/tmp/nh/projects/-work-repo/sessions");
  expect(globalModelsPath()).toBe("/tmp/nh/models.json");
});

test("skillRoots/commandRoots: most-specific first (project > .claude project > global > user)", () => {
  Bun.env.NERVE_HOME = "/tmp/nh";
  const sr = skillRoots("/work/repo");
  expect(sr[0]).toBe("/tmp/nh/projects/-work-repo/skills"); // project-nerve wins
  expect(sr).toContain("/work/repo/.claude/skills");
  expect(sr).toContain("/tmp/nh/skills");
  expect(commandRoots("/work/repo")[0]).toBe("/tmp/nh/projects/-work-repo/commands");
});
