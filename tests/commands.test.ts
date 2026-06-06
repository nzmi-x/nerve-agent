import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandCommand, discoverCommands } from "../src/commands.ts";

// --- expandCommand ----------------------------------------------------------

test("expandCommand: $ARGUMENTS and $@ get all args", () => {
  expect(expandCommand("Review $ARGUMENTS now", ["a", "b"])).toBe("Review a b now");
  expect(expandCommand("Files: $@", ["x.ts", "y.ts"])).toBe("Files: x.ts y.ts");
});

test("expandCommand: positional $1/$2, missing → empty", () => {
  expect(expandCommand("from $1 to $2", ["src", "dst"])).toBe("from src to dst");
  expect(expandCommand("only $1 and $2", ["one"])).toBe("only one and ");
});

test("expandCommand: no placeholder + args → args appended", () => {
  expect(expandCommand("Summarize the diff.", ["HEAD~1"])).toBe("Summarize the diff.\n\nHEAD~1");
});

test("expandCommand: no placeholder + no args → body unchanged", () => {
  expect(expandCommand("Run the tests.", [])).toBe("Run the tests.");
});

// --- discoverCommands -------------------------------------------------------

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-cmds-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("discoverCommands: reads *.md, parses frontmatter, derives description from first line", async () => {
  const root = join(dir, "commands");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "review.md"), "---\ndescription: Review a PR\n---\nPlease review $ARGUMENTS.");
  await writeFile(join(root, "tidy.md"), "Tidy up the imports in $1.");

  const cmds = await discoverCommands([root]);
  const review = cmds.find((c) => c.name === "review")!;
  const tidy = cmds.find((c) => c.name === "tidy")!;
  expect(review.description).toBe("Review a PR");
  expect(review.body).toBe("Please review $ARGUMENTS.");
  expect(tidy.description).toBe("Tidy up the imports in $1."); // first line fallback
});

test("discoverCommands: first root wins on a name collision; missing roots are skipped", async () => {
  const a = join(dir, "a");
  const b = join(dir, "b");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  await writeFile(join(a, "dup.md"), "from A");
  await writeFile(join(b, "dup.md"), "from B");

  const cmds = await discoverCommands([a, b, join(dir, "missing")]);
  expect(cmds.filter((c) => c.name === "dup")).toHaveLength(1);
  expect(cmds.find((c) => c.name === "dup")!.body).toBe("from A");
});
