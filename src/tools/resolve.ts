// Shared path resolution for the file tools. Normally a tool path is relative to the working dir, BUT a
// `self:`-prefixed path targets nerve's OWN source tree (the repo) regardless of cwd — so the agent can
// self-hack (adapt its own tools/prompts/docs) while launched in any project (D36). Pairs with `/reload`
// (re-imports edited tools from disk, cwd-independent) for an edit-then-reload loop. See manual("self").
import { resolve } from "node:path";
import { nerveSourceRoot } from "../paths.ts";

/** The prefix that retargets a tool path from the working dir to nerve's own source tree (D36). */
export const SELF_PREFIX = "self:";

/** True if `path` addresses nerve's own source, e.g. "self:src/tools/grep.ts". */
export function isSelfPath(path: string): boolean {
  return path.startsWith(SELF_PREFIX);
}

/**
 * Resolve a tool path to an absolute path. `self:<rest>` resolves `rest` (treated as repo-relative —
 * leading slashes stripped) against nerve's source root, so self-edits land on the running source from
 * any cwd. Everything else resolves against `cwd` exactly as before.
 */
export function resolvePath(cwd: string, path: string): string {
  if (isSelfPath(path)) {
    return resolve(nerveSourceRoot(), path.slice(SELF_PREFIX.length).replace(/^\/+/, ""));
  }
  return resolve(cwd, path);
}
