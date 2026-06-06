import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatResult, formatDiagnostic, loc, severityName, type LspOp } from "../src/lsp/format.ts";
import { loadServers, findRoot, installHint } from "../src/lsp/manager.ts";

// --- format.ts (pure result mappers) ----------------------------------------

test("formatResult: hover unwraps string / {value} / array contents", () => {
  expect(formatResult("hover", { contents: "plain" })).toBe("plain");
  expect(formatResult("hover", { contents: { value: "**x**: number" } })).toBe("**x**: number");
  expect(formatResult("hover", { contents: ["a", { value: "b" }] })).toBe("a\nb");
  expect(formatResult("hover", null)).toBe("");
});

test("formatResult: definition/references → path:line:col (1-based), Location + LocationLink", () => {
  const single = { uri: "file:///p/a.ts", range: { start: { line: 4, character: 2 } } };
  expect(formatResult("definition", single)).toBe("/p/a.ts:5:3");
  const link = { targetUri: "file:///p/b.ts", targetSelectionRange: { start: { line: 0, character: 0 } } };
  expect(formatResult("references", [single, link])).toBe("/p/a.ts:5:3\n/p/b.ts:1:1");
});

test("formatResult: documentSymbol nests children; workspaceSymbol lists with location", () => {
  const doc = formatResult("documentSymbol", [
    { name: "foo", kind: 12, range: { start: { line: 0, character: 0 } }, children: [{ name: "bar", kind: 6, range: { start: { line: 2, character: 2 } } }] },
  ]);
  expect(doc).toBe("function foo  :1\n  method bar  :3");
  const ws = formatResult("workspaceSymbol", [{ name: "X", kind: 5, location: { uri: "file:///p/a.ts", range: { start: { line: 9, character: 0 } } } }]);
  expect(ws).toBe("class X  /p/a.ts:10:1");
});

test("formatDiagnostic / severityName / loc", () => {
  expect(formatDiagnostic("ruff", { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, severity: 2, message: "unused import", code: "F401" })).toBe("  ruff 3:5 warning: unused import [F401]");
  expect(severityName(1)).toBe("error");
  expect(severityName(undefined)).toBe("error");
  expect(loc({ uri: "file:///x.py", range: { start: { line: 0, character: 0 } } })).toBe("/x.py:1:1");
});

// --- catalog + root detection -----------------------------------------------

test("loadServers: bundled catalog has vtsls + pyrefly + ruff; Python uses two servers", () => {
  const servers = loadServers(resolve(import.meta.dir, "../config/lsp.json"));
  expect(servers.map((s) => s.id).sort()).toEqual(["pyrefly", "ruff", "vtsls"]);
  const py = servers.filter((s) => s.extensions.includes(".py")).map((s) => s.id).sort();
  expect(py).toEqual(["pyrefly", "ruff"]); // pyrefly + ruff aggregate diagnostics for Python
  expect(servers.find((s) => s.id === "vtsls")?.install).toContain("vtsls");
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-lsp-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("installHint: chains the package-manager install when it's also missing", () => {
  const py = { command: "pyrefly", install: "uv tool install pyrefly" };
  expect(installHint(py, () => true)).toBe("`uv tool install pyrefly`"); // uv present → just the install
  const missing = installHint(py, (c) => c !== "uv"); // uv missing too
  expect(missing).toContain("install uv first");
  expect(missing).toContain("astral.sh/uv/install.sh");
  expect(missing).toContain("uv tool install pyrefly");
  // a server with no known package-manager prefix is unchanged
  expect(installHint({ command: "gopls", install: "go install golang.org/x/tools/gopls@latest" }, () => false)).toBe("`go install golang.org/x/tools/gopls@latest`");
});

test("findRoot: walks up to a marker, else falls back to the start dir", async () => {
  await mkdir(join(dir, "sub", "deep"), { recursive: true });
  await writeFile(join(dir, "pyproject.toml"), "");
  expect(findRoot(join(dir, "sub", "deep"), ["pyproject.toml"])).toBe(dir);
  expect(findRoot(join(dir, "sub", "deep"), ["nonexistent.marker"])).toBe(resolve(dir, "sub", "deep"));
});
