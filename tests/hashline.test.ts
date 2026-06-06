import { test, expect } from "bun:test";
import { hashLine, encode, parseAnchor, applyEdits } from "../src/hashline.ts";

const SRC = 'function hello() {\n  console.log("world");\n}\n';

function lineOf(content: string, n: number): string {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines[n - 1]!;
}
/** A valid `LINE#HASH` anchor for line `n` of `content`. */
function anchor(content: string, n: number): string {
  return `${n}#${hashLine(lineOf(content, n), n)}`;
}

// --- hashLine ---------------------------------------------------------------

test("hashLine: stable, 2 chars from the alphabet", () => {
  expect(hashLine("abc", 1)).toBe(hashLine("abc", 1));
  expect(hashLine("abc", 1)).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
});

test("hashLine: alphanumeric lines ignore line number; punctuation-only lines seed from it", () => {
  expect(hashLine("abc", 1)).toBe(hashLine("abc", 99)); // content-only
  expect(hashLine("}", 3)).not.toBe(hashLine("}", 5)); // seeded by line number
});

// --- encode -----------------------------------------------------------------

test("encode: LINE#HASH:content with verbatim content", () => {
  const lines = encode(SRC).split("\n");
  expect(lines[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}:function hello\(\) \{$/);
  expect(lines[2]).toMatch(/^3#[ZPMQVRWSNKTXJBYH]{2}:\}$/);
});

test("encode: left-pads line numbers for alignment", () => {
  const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  const lines = encode(big).split("\n");
  expect(lines[0]!.startsWith(" 1#")).toBe(true); // padded to width 2
  expect(lines[11]!.startsWith("12#")).toBe(true);
});

// --- parseAnchor ------------------------------------------------------------

test("parseAnchor: valid / invalid", () => {
  expect(parseAnchor("11#KT")).toEqual({ line: 11, hash: "KT" });
  expect(parseAnchor("nope")).toBeNull();
  expect(parseAnchor("11#kt")).toBeNull(); // lowercase isn't a valid hash
});

// --- applyEdits: the ops ----------------------------------------------------

test("applyEdits: replace one line", () => {
  const r = applyEdits(SRC, [{ op: "replace", pos: anchor(SRC, 2), lines: ['  console.log("hashline");'] }]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.content).toBe('function hello() {\n  console.log("hashline");\n}\n');
});

test("applyEdits: replace a range (pos..end)", () => {
  const r = applyEdits(SRC, [{ op: "replace", pos: anchor(SRC, 1), end: anchor(SRC, 3), lines: ["// gone"] }]);
  if (r.ok) expect(r.content).toBe("// gone\n");
  else throw new Error(r.error);
});

test("applyEdits: append after / prepend before an anchor", () => {
  const ap = applyEdits(SRC, [{ op: "append", pos: anchor(SRC, 1), lines: ["  // new"] }]);
  if (ap.ok) expect(ap.content).toBe('function hello() {\n  // new\n  console.log("world");\n}\n');
  else throw new Error(ap.error);

  const pp = applyEdits(SRC, [{ op: "prepend", pos: anchor(SRC, 1), lines: ["// header"] }]);
  if (pp.ok) expect(pp.content).toBe('// header\nfunction hello() {\n  console.log("world");\n}\n');
  else throw new Error(pp.error);
});

test("applyEdits: multiple hunks use original line numbers (applied bottom-up)", () => {
  const r = applyEdits(SRC, [
    { op: "replace", pos: anchor(SRC, 1), lines: ["FN {"] },
    { op: "replace", pos: anchor(SRC, 3), lines: ["}; // end"] },
  ]);
  if (r.ok) expect(r.content).toBe('FN {\n  console.log("world");\n}; // end\n');
  else throw new Error(r.error);
});

test("applyEdits: preserves a missing trailing newline", () => {
  const noNL = "a\nb";
  const r = applyEdits(noNL, [{ op: "replace", pos: anchor(noNL, 1), lines: ["A"] }]);
  if (r.ok) expect(r.content).toBe("A\nb");
  else throw new Error(r.error);
});

// --- applyEdits: staleness (the safety property) ----------------------------

test("applyEdits: a stale anchor hard-rejects the whole patch and returns fresh anchors", () => {
  // anchor computed against SRC, but the file's line 2 has since changed → divergence
  const changed = SRC.replace("world", "CHANGED");
  const r = applyEdits(changed, [{ op: "replace", pos: anchor(SRC, 2), lines: ["x"] }]);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error).toContain("stale");
    expect(r.anchors).toContain("CHANGED"); // fresh re-anchors for the affected region
    expect(r.anchors).toMatch(/2#[ZPMQVRWSNKTXJBYH]{2}:/);
  }
});

test("applyEdits: out-of-range anchor is stale; malformed anchor is rejected", () => {
  const oob = applyEdits(SRC, [{ op: "replace", pos: `9#${hashLine("}", 9)}`, lines: ["x"] }]);
  expect(oob.ok).toBe(false);

  const bad = applyEdits(SRC, [{ op: "replace", pos: "nope", lines: ["x"] }]);
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error).toContain("bad anchor");
});
