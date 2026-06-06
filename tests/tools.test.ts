import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashLine } from "../src/hashline.ts";
import { read } from "../src/tools/read.ts";
import { write } from "../src/tools/write.ts";
import { edit } from "../src/tools/edit.ts";
import { tools, toolByName, toolSpecs } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/tools/types.ts";

const SRC = 'function hello() {\n  console.log("world");\n}\n';

let dir: string;
let ctx: ToolContext;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-tools-"));
  ctx = { cwd: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Pull the `LINE#HASH` anchor for a 1-based line out of read-tool output. */
function anchorFromRead(readOutput: string, line: number): string {
  const row = readOutput.split("\n")[line - 1]!;
  return row.slice(0, row.indexOf(":"));
}

// --- read / write -----------------------------------------------------------

test("write then read round-trips with hashline anchors", async () => {
  expect(await write.run({ path: "a.txt", content: SRC }, ctx)).toBe("Wrote a.txt (3 lines)");
  const out = await read.run({ path: "a.txt" }, ctx);
  expect(out.split("\n")[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}:  console\.log\("world"\);$/);
});

test("read: missing file returns an Error string (not a throw)", async () => {
  expect(await read.run({ path: "nope.txt" }, ctx)).toBe("Error: no such file: nope.txt");
});

test("write: creates parent directories", async () => {
  await write.run({ path: "nested/deep/x.txt", content: "hi" }, ctx);
  expect(await Bun.file(join(dir, "nested/deep/x.txt")).text()).toBe("hi");
});

// --- edit -------------------------------------------------------------------

test("edit: applies a hash-anchored replace and writes the file", async () => {
  await write.run({ path: "a.txt", content: SRC }, ctx);
  const pos = anchorFromRead(await read.run({ path: "a.txt" }, ctx), 2);

  const res = await edit.run(
    { path: "a.txt", edits: [{ op: "replace", pos, lines: ['  console.log("edited");'] }] },
    ctx,
  );
  expect(res).toContain("Applied 1 edit(s) to a.txt");
  expect(res).toContain("Updated anchors:"); // small file → fresh anchors echoed back
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe(
    'function hello() {\n  console.log("edited");\n}\n',
  );
});

test("edit: a stale anchor rejects the patch, returns fresh anchors, and leaves the file untouched", async () => {
  await write.run({ path: "a.txt", content: SRC }, ctx);
  const realHash = hashLine('  console.log("world");', 2);
  const wrongHash = realHash === "ZZ" ? "PP" : "ZZ";

  const res = await edit.run({ path: "a.txt", edits: [{ op: "replace", pos: `2#${wrongHash}`, lines: ["x"] }] }, ctx);
  expect(res).toContain("Edit rejected");
  expect(res).toContain("Fresh anchors:");
  expect(res).toContain("console.log"); // the real current line, re-anchored
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe(SRC); // unchanged
});

// --- registry ---------------------------------------------------------------

test("registry: unique names, lookup, and readonly flags", () => {
  const names = tools.map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
  expect(toolByName("read")).toBe(read);
  expect(toolByName("nope")).toBeUndefined();
  expect(read.readonly).toBe(true);
  expect(write.readonly).toBe(false);
  expect(edit.readonly).toBe(false);
});

test("registry: toolSpecs exposes name/description/parameters only", () => {
  const specs = toolSpecs();
  expect(specs.map((s) => s.name).sort()).toEqual(tools.map((t) => t.name).sort());
  for (const s of specs) {
    expect(typeof s.description).toBe("string");
    expect((s.parameters as { type: string }).type).toBe("object");
    expect(s).not.toHaveProperty("run"); // engine internals stay out of the wire
  }
});
