import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planBashAllowed, allowed, dispatch } from "../src/dispatch.ts";
import { read } from "../src/tools/read.ts";
import { write } from "../src/tools/write.ts";
import { edit } from "../src/tools/edit.ts";
import { bash } from "../src/tools/bash.ts";
import { manual } from "../src/tools/manual.ts";
import type { ToolContext } from "../src/tools/types.ts";

// --- planBashAllowed --------------------------------------------------------

test("planBashAllowed: obviously-safe read commands pass", () => {
  for (const c of ["ls -la", "cat file.txt", "rg foo src", "find . -name '*.ts'", "head -5 a", "wc -l b"]) {
    expect(planBashAllowed(c).ok).toBe(true);
  }
});

test("planBashAllowed: read-only git subcommands pass; writing ones don't", () => {
  for (const c of ["git status", "git log --oneline -5", "git diff HEAD~1", "git show"]) {
    expect(planBashAllowed(c).ok).toBe(true);
  }
  for (const c of ["git commit -m x", "git push", "git add .", "git checkout main", "git config user.name x"]) {
    expect(planBashAllowed(c).ok).toBe(false);
  }
});

test("planBashAllowed: metacharacters are rejected (chaining/redirect/subst/subshell)", () => {
  for (const c of [
    "cat a | grep b",
    "echo x > f",
    "ls; rm x",
    "ls && rm x",
    "cat $(whoami)",
    "echo `id`",
    "ls > /dev/null 2>&1",
    "echo $HOME",
  ]) {
    expect(planBashAllowed(c).ok).toBe(false);
  }
});

test("planBashAllowed: non-allowlisted programs are refused", () => {
  for (const c of ["rm -rf /", "mv a b", "cp a b", "tee f", "python x.py", "node x.js", "sed -i s/a/b/ f"]) {
    expect(planBashAllowed(c).ok).toBe(false);
  }
});

// --- allowed (policy) -------------------------------------------------------

test("allowed: EDIT permits everything", () => {
  expect(allowed(write, { path: "x", content: "y" }, "edit").ok).toBe(true);
  expect(allowed(bash, { command: "rm -rf /" }, "edit").ok).toBe(true);
  expect(allowed(edit, {}, "edit").ok).toBe(true);
});

test("allowed: PLAN permits readonly tools + safe bash, blocks mutations", () => {
  expect(allowed(read, { path: "x" }, "plan").ok).toBe(true);
  expect(allowed(manual, {}, "plan").ok).toBe(true);
  expect(allowed(bash, { command: "git diff" }, "plan").ok).toBe(true);

  expect(allowed(write, { path: "x", content: "y" }, "plan").ok).toBe(false);
  expect(allowed(edit, { path: "x", edits: [] }, "plan").ok).toBe(false);
  expect(allowed(bash, { command: "rm x" }, "plan").ok).toBe(false);
});

// --- dispatch (integration) -------------------------------------------------

let dir: string;
let ctx: ToolContext;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nerve-dispatch-"));
  ctx = { cwd: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("dispatch: unknown tool reports an error", async () => {
  expect(await dispatch("nope", {}, "edit", ctx)).toBe("Error: unknown tool 'nope'");
});

test("dispatch: PLAN refuses a mutation and never touches the filesystem", async () => {
  const res = await dispatch("write", { path: "a.txt", content: "x" }, "plan", ctx);
  expect(res).toContain("Refused (PLAN mode)");
  expect(await Bun.file(join(dir, "a.txt")).exists()).toBe(false);
});

test("dispatch: EDIT runs the mutation; PLAN still runs a readonly tool", async () => {
  expect(await dispatch("write", { path: "a.txt", content: "hi" }, "edit", ctx)).toContain("Wrote a.txt");
  expect(await Bun.file(join(dir, "a.txt")).text()).toBe("hi");
  // manual is readonly → allowed even in PLAN
  expect(await dispatch("manual", {}, "plan", ctx)).toContain("topics:");
});
