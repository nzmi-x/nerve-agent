import { test, expect, afterEach } from "bun:test";
import { projectSlug, projectDir, skillRoots, commandRoots, globalModelsPath } from "../src/paths.ts";

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
  expect(globalModelsPath()).toBe("/tmp/nh/models.json");
});

test("skillRoots: personal per-project on top, then nerve > claude > agent, project over user (D47)", () => {
  Bun.env.NERVE_HOME = "/tmp/nh";
  const sr = skillRoots("/work/repo");
  expect(sr.length).toBe(7);
  expect(sr[0]).toBe("/tmp/nh/projects/-work-repo/skills"); // personal per-project (out-of-tree)
  expect(sr[1]).toBe("/work/repo/.nerve/skills"); // project nerve (in-tree)
  expect(sr[2]).toBe("/tmp/nh/skills"); // user nerve (~/.nerve = $NERVE_HOME)
  expect(sr[3]).toBe("/work/repo/.claude/skills"); // project claude
  expect(sr[5]).toBe("/work/repo/.agent/skills"); // project agent
  // ecosystem order: nerve project before claude project before agent project
  expect(sr.indexOf("/work/repo/.nerve/skills")).toBeLessThan(sr.indexOf("/work/repo/.claude/skills"));
  expect(sr.indexOf("/work/repo/.claude/skills")).toBeLessThan(sr.indexOf("/work/repo/.agent/skills"));
  expect(commandRoots("/work/repo")[0]).toBe("/tmp/nh/projects/-work-repo/commands");
});
