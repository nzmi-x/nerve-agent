// The `self:` tool-path prefix (D36): file tools resolve normal paths against cwd, but a `self:` path
// against nerve's own source tree so the agent self-hacks from any project. See src/tools/resolve.ts.
import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { resolvePath, isSelfPath, SELF_PREFIX } from "../src/tools/resolve.ts";
import { nerveSourceRoot } from "../src/paths.ts";

const root = nerveSourceRoot();

test("a normal path resolves against the working dir", () => {
  expect(resolvePath("/home/naz/proj", "src/a.ts")).toBe("/home/naz/proj/src/a.ts");
  expect(resolvePath("/home/naz/proj", ".")).toBe("/home/naz/proj");
});

test("self: targets nerve's source root, ignoring cwd", () => {
  expect(resolvePath("/home/naz/proj", "self:src/tools/grep.ts")).toBe(resolve(root, "src/tools/grep.ts"));
  expect(resolvePath("/somewhere/else", "self:prompts/system.md")).toBe(resolve(root, "prompts/system.md"));
});

test("self: remainder is repo-relative — a leading slash is stripped", () => {
  expect(resolvePath("/x", "self:/src/loop.ts")).toBe(resolve(root, "src/loop.ts"));
});

test("self: with an empty remainder is the source root itself", () => {
  expect(resolvePath("/x", "self:")).toBe(root);
});

test("isSelfPath / SELF_PREFIX", () => {
  expect(isSelfPath("self:src/a.ts")).toBe(true);
  expect(isSelfPath("src/a.ts")).toBe(false);
  expect(SELF_PREFIX).toBe("self:");
});

test("nerveSourceRoot points at the repo (has package.json)", async () => {
  expect(await Bun.file(resolve(root, "package.json")).exists()).toBe(true);
});
