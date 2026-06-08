// Project-memory layering (D42, delivering the long-unbuilt D12): load CLAUDE.md + AGENTS.md and fold them
// into the system prompt, so nerve-the-agent actually reads the repo's own guidance. Whole-file injection
// (no structured section parsing — D37 rejected that). A line that is exactly `@<path>` is inlined (the
// convention nerve's own root CLAUDE.md uses: it's just `@.claude/CLAUDE.md`). Filesystem reads only; used
// by index.ts when it assembles the base system prompt. See docs/manual/context.md.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const MAX_IMPORT_DEPTH = 5;

/** Inline `@path` imports (a line that is exactly `@<path>`) relative to the file's dir, recursively, with
 *  a cycle + depth guard. A missing or already-seen target leaves the directive line untouched. */
function resolveImports(text: string, baseDir: string, seen: Set<string>, depth: number): string {
  if (depth > MAX_IMPORT_DEPTH) return text;
  return text
    .split("\n")
    .map((line) => {
      const m = /^@(\S+)$/.exec(line.trim());
      if (!m) return line;
      const path = resolve(baseDir, m[1]!);
      if (seen.has(path) || !existsSync(path)) return line;
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

/**
 * Load the project-memory files for `cwd`, most-general → most-specific so project guidance augments the
 * user's (D12): `~/.claude/CLAUDE.md` → `./CLAUDE.md` (which may `@import` `.claude/CLAUDE.md`, inlining it)
 * → `./.claude/CLAUDE.md` (only if not already pulled in by that import) → `./AGENTS.md` (the agents.md
 * standard). Each file loads at most once (the `seen` set dedups an `@import`-then-also-listed file).
 * Returns the concatenated text, or "" when there's nothing.
 */
export function loadProjectMemory(cwd: string): string {
  const seen = new Set<string>();
  const sources = [
    resolve(homedir(), ".claude/CLAUDE.md"),
    resolve(cwd, "CLAUDE.md"),
    resolve(cwd, ".claude/CLAUDE.md"),
    resolve(cwd, "AGENTS.md"),
  ];
  const blocks: string[] = [];
  for (const path of sources) {
    const body = loadFile(path, seen);
    if (body) blocks.push(body);
  }
  return blocks.join("\n\n");
}
