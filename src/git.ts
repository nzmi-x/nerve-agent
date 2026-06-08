// Read-only git for the TUI's location + git-graph panels (D49). Pure parsers (unit-tested) + thin
// `Bun.spawn` wrappers (like src/tools/bash.ts). ONLY read-only subcommands (status/log) + a direct
// `.git/HEAD` read; never a mutation. Off a repo → null/empty. Shape modeled on src/balance.ts.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitStatus {
  dirty: number;
  ahead: number;
  behind: number;
}
/** One row of `git log --graph` output: the topology `rail` (│ ● ╲ ╱ …) + a commit (hash/subject) when the
 *  row is a commit, or just the rail on a connector line (`hash === ""`). */
export interface GraphRow {
  rail: string;
  hash: string;
  subject: string;
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

/** Parse `git log --graph … --pretty=format:%x00%h%x00%s`: the rail is everything before the first NUL;
 *  a commit row then carries hash + subject, a connector row (no NUL) is rail-only. */
export function parseGraph(out: string): GraphRow[] {
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const parts = l.split("\x00");
      return parts.length >= 3 ? { rail: parts[0]!, hash: parts[1]!, subject: parts.slice(2).join("") } : { rail: l, hash: "", subject: "" };
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

/** Recent commits across **all** branches as a topology graph (`git log --graph --all`) — shows how branches
 *  relate + each subject, newest first, capped to `n`. */
export async function gitGraph(cwd: string, n = 24): Promise<GraphRow[]> {
  return parseGraph(await git(cwd, ["log", "--graph", "--all", `-${n}`, "--color=never", "--pretty=format:%x00%h%x00%s"]));
}
