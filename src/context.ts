// Project-memory layering (D42/D47/D48, delivering the long-unbuilt D12): load CLAUDE.md + AGENTS.md and
// fold them into the system prompt, so nerve-the-agent reads the repo's own guidance. Whole-file injection
// (no structured-section parsing — D37 rejected that). Two parts:
//   • base (`loadProjectMemory`) — the ecosystem dirs (`ecosystemDirs`, D47) + the project-root files, layered
//     least→most authoritative; loaded once.
//   • nested (`nestedMemory`, D48) — `**/CLAUDE.md` / `**/AGENTS.md` for the ancestor dirs of files the agent
//     actually touches (Claude Code's nearest-CLAUDE.md semantics, not an eager whole-tree scan); per turn.
// A line that is exactly `@<path>` is inlined (the convention nerve's own root CLAUDE.md uses). Filesystem
// reads only; used by index.ts. See docs/manual/context.md.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { ecosystemDirs } from "./paths.ts";

const MAX_IMPORT_DEPTH = 5;
const MEMORY_FILES = ["CLAUDE.md", "AGENTS.md"];

/** Inline `@path` imports (a line that is exactly `@<path>`) relative to the file's dir, recursively, with a
 *  cycle + depth guard. Missing target → keep the directive visible (a broken import the user can see);
 *  already-included target → drop the line (no duplicate, no stray literal). */
function resolveImports(text: string, baseDir: string, seen: Set<string>, depth: number): string {
  if (depth > MAX_IMPORT_DEPTH) return text;
  return text
    .split("\n")
    .map((line) => {
      const m = /^@(\S+)$/.exec(line.trim());
      if (!m) return line;
      const path = resolve(baseDir, m[1]!);
      if (!existsSync(path)) return line; // missing → keep visible (broken import)
      if (seen.has(path)) return ""; // already included elsewhere → drop the directive
      seen.add(path);
      return resolveImports(readFileSync(path, "utf8"), dirname(path), seen, depth + 1);
    })
    .join("\n");
}

/** Read one memory file (once), resolving its `@imports`. Returns the trimmed body, or null if missing/seen/empty. */
function loadFile(path: string, seen: Set<string>): string | null {
  if (seen.has(path) || !existsSync(path)) return null;
  seen.add(path);
  return resolveImports(readFileSync(path, "utf8"), dirname(path), seen, 0).trim() || null;
}

/** Load CLAUDE.md + AGENTS.md from one dir (both if present), in `MEMORY_FILES` order. */
function loadDir(dir: string, seen: Set<string>): string[] {
  const out: string[] = [];
  for (const f of MEMORY_FILES) {
    const body = loadFile(resolve(dir, f), seen);
    if (body) out.push(body);
  }
  return out;
}

/**
 * Base project memory (D47): each ecosystem dir (`ecosystemDirs`, **reversed** to least→most authoritative)
 * contributes its CLAUDE.md/AGENTS.md, then the project-root files (`./CLAUDE.md`, `./AGENTS.md`) last (most
 * authoritative of the always-on set). `@imports` inlined; each file loads at most once. Nested in-tree
 * memory is added per turn by `nestedMemory`. Returns "" when there's nothing.
 */
export function loadProjectMemory(cwd: string): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const dir of [...ecosystemDirs(cwd)].reverse()) blocks.push(...loadDir(dir, seen));
  blocks.push(...loadDir(cwd, seen)); // project-root tree files, most authoritative of the base set
  return blocks.join("\n\n");
}

/**
 * Nested in-tree memory (D48, touched-driven): for each touched file, the CLAUDE.md/AGENTS.md in its ancestor
 * dirs **strictly below `cwd`** (the root files are already in the base), ordered shallow→deep so the
 * most-specific subdir guidance lands last. Deduped; `@imports` inlined. This is Claude Code's nearest-CLAUDE.md
 * semantics without eagerly loading a monorepo's every memory file. Returns "" when there's nothing.
 */
export function nestedMemory(cwd: string, touched: Iterable<string>): string {
  const root = resolve(cwd);
  const dirs = new Set<string>();
  for (const file of touched) {
    let dir = dirname(resolve(file));
    while (dir.startsWith(root + sep) && dir !== root) {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  const ordered = [...dirs].sort((a, b) => a.split(sep).length - b.split(sep).length || (a < b ? -1 : 1));
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const dir of ordered) blocks.push(...loadDir(dir, seen));
  return blocks.join("\n\n");
}
