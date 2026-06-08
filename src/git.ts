// Read-only git for the TUI's location + git panels (D49). Pure parsers (unit-tested) + thin `Bun.spawn`
// wrappers (like src/tools/bash.ts). ONLY read-only subcommands (status/branch/log) + a direct `.git/HEAD`
// read; never a mutation. Off a repo → null/empty. Shape modeled on src/balance.ts (parse pure, run impure).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitStatus {
  dirty: number;
  ahead: number;
  behind: number;
}
export interface GitBranch {
  name: string;
  current: boolean;
}
export interface GitCommit {
  hash: string;
  subject: string;
  ageMs: number;
}

/** The nearest `.git` (dir or worktree file) walking up from `cwd`, else null. */
function gitDir(cwd: string): string | null {
  let d = cwd;
  for (;;) {
    if (existsSync(join(d, ".git"))) return join(d, ".git");
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Current branch, read straight from `.git/HEAD` (cheap — no subprocess). null when detached or not a repo. */
export function gitBranch(cwd: string): string | null {
  const g = gitDir(cwd);
  const head = g ? join(g, "HEAD") : null;
  if (!head || !existsSync(head)) return null;
  try {
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(readFileSync(head, "utf8").trim());
    return m ? m[1]! : null; // detached HEAD → null
  } catch {
    return null;
  }
}

/** Parse `git status -sb`: ahead/behind from the `## …` header + a count of changed entries. */
export function parseStatus(out: string): GitStatus {
  const lines = out.split("\n");
  const head = lines[0] ?? "";
  return {
    ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
    dirty: lines.slice(1).filter((l) => l.trim() !== "").length,
  };
}

/** Parse `git branch` → {name, current}; skips a "(HEAD detached …)" line. */
export function parseBranches(out: string): GitBranch[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => ({ current: l.startsWith("*"), name: l.replace(/^[*+]?\s*/, "").trim() }))
    .filter((b) => !b.name.startsWith("("));
}

/** Parse `git log --pretty=format:%h%x00%s%x00%ct` (NUL-separated) → commits with age. */
export function parseLog(out: string, now = Date.now()): GitCommit[] {
  return out
    .split("\n")
    .filter((l) => l.includes("\x00"))
    .map((l) => {
      const [hash, subject, ct] = l.split("\x00");
      return { hash: hash ?? "", subject: subject ?? "", ageMs: Math.max(0, now - Number(ct) * 1000) };
    });
}

/** Run a read-only git command in `cwd`; "" on any failure (missing git, not a repo, non-zero exit). */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? out : "";
  } catch {
    return "";
  }
}

export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  if (!gitDir(cwd)) return null;
  return parseStatus(await git(cwd, ["status", "-sb"]));
}
export async function gitBranches(cwd: string): Promise<GitBranch[]> {
  return parseBranches(await git(cwd, ["branch"]));
}
export async function gitLog(cwd: string, n = 12): Promise<GitCommit[]> {
  return parseLog(await git(cwd, ["log", `-${n}`, "--pretty=format:%h%x00%s%x00%ct"]));
}
