import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash } from "../src/tools/bash.ts";
import { ls } from "../src/tools/ls.ts";
import { glob } from "../src/tools/glob.ts";
import { grep } from "../src/tools/grep.ts";
import { manual } from "../src/tools/manual.ts";
import { write } from "../src/tools/write.ts";
import type { ToolContext } from "../src/tools/types.ts";

let dir: string;
let ctx: ToolContext;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-shell-"));
  ctx = { cwd: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// --- bash -------------------------------------------------------------------

test("bash: returns stdout; reports non-zero exit; honors cwd", async () => {
  expect(await bash.run({ command: "echo hi" }, ctx)).toBe("hi");
  expect(await bash.run({ command: "echo oops >&2; exit 3" }, ctx)).toBe("oops (exit 3)");
  await write.run({ path: "sub/f.txt", content: "X" }, ctx);
  expect(await bash.run({ command: "cat f.txt", cwd: "sub" }, ctx)).toBe("X");
});

// --- ls / glob / grep -------------------------------------------------------

test("ls: sorted entries, directories suffixed with '/'", async () => {
  await write.run({ path: "a.txt", content: "1" }, ctx);
  await write.run({ path: "dir/b.txt", content: "2" }, ctx);
  expect((await ls.run({}, ctx)).split("\n")).toEqual(["a.txt", "dir/"]);
});

test("glob: matches by pattern", async () => {
  await write.run({ path: "src/x.ts", content: "" }, ctx);
  await write.run({ path: "src/y.js", content: "" }, ctx);
  expect(await glob.run({ pattern: "**/*.ts" }, ctx)).toBe("src/x.ts");
});

test("grep: path:line:text matches; no-match and bad-regex handling", async () => {
  await write.run({ path: "a.ts", content: "const foo = 1\nconst bar = 2\n" }, ctx);
  expect(await grep.run({ pattern: "foo" }, ctx)).toBe("a.ts:1:const foo = 1");
  expect(await grep.run({ pattern: "zzz" }, ctx)).toBe("No matches.");
  expect(await grep.run({ pattern: "(" }, ctx)).toContain("invalid regex");
});

// --- manual (reads nerve's real docs, independent of cwd) -------------------

test("manual: index lists topics; pages resolve; opentui federates; errors are graceful", async () => {
  const index = await manual.run({}, ctx);
  expect(index).toContain("hashline");
  expect(index).toContain("stream");
  expect(index).toContain("opentui");

  expect(await manual.run({ topic: "hashline" }, ctx)).toContain("# hashline");
  expect((await manual.run({ topic: "opentui" }, ctx)).toLowerCase()).toContain("opentui");

  expect(await manual.run({ topic: "does-not-exist" }, ctx)).toContain('no manual topic "does-not-exist"');
  expect(await manual.run({ topic: "../secrets" }, ctx)).toBe("Error: invalid topic");
});
