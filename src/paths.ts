// nerve's global state lives under ~/.nerve, never in the project dir (D22) — so contribution repos
// stay clean. Layout: ~/.nerve/{skills,commands,models.json,projects/<slug>/{nerve.db,skills,commands}}.
// Sessions live in the per-project `nerve.db` (D31). The <slug> is the absolute cwd with '/' → '-'.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Root of nerve's global state. Override with $NERVE_HOME (used by tests). */
export function nerveHome(): string {
  return Bun.env.NERVE_HOME || join(homedir(), ".nerve");
}

/** A project's stable folder name: the absolute cwd with '/' → '-' (e.g. `-home-naz-Documents-nerve`). */
export function projectSlug(cwd: string = process.cwd()): string {
  return resolve(cwd).replace(/\//g, "-");
}

export function projectDir(cwd: string = process.cwd()): string {
  return join(nerveHome(), "projects", projectSlug(cwd));
}

/**
 * Config-discovery dirs for a project, MOST-authoritative first — callers dedup first-wins (skills/commands);
 * memory reverses this for layering (D47/D48). Order: the out-of-tree personal per-project dir (D22/D31) on
 * top, then the ecosystem ladder — **nerve > claude > agent**, and within each **project (in-tree `.x`) over
 * user (`~/.x`)**. nerve's global dir respects `$NERVE_HOME` (`nerveHome()`); claude/agent use the real home.
 */
export function ecosystemDirs(cwd: string = process.cwd()): string[] {
  return [
    projectDir(cwd), // ~/.nerve/projects/<slug> — personal per-project (out-of-tree, D22)
    join(cwd, ".nerve"), // ./.nerve — committed per-project (nerve)
    nerveHome(), // ~/.nerve — user global (nerve)
    join(cwd, ".claude"), // ./.claude — committed per-project (claude-compat)
    join(homedir(), ".claude"), // ~/.claude — user global (claude-compat)
    join(cwd, ".agent"), // ./.agent — committed per-project (agent-compat)
    join(homedir(), ".agent"), // ~/.agent — user global (agent-compat)
  ];
}

/** Skill discovery roots, most-authoritative first (callers dedup first-wins) — the ecosystem ladder (D47). */
export function skillRoots(cwd: string = process.cwd()): string[] {
  return ecosystemDirs(cwd).map((d) => join(d, "skills"));
}

/** Markdown slash-command roots (D16), most-authoritative first — the ecosystem ladder (D47). */
export function commandRoots(cwd: string = process.cwd()): string[] {
  return ecosystemDirs(cwd).map((d) => join(d, "commands"));
}

/** Absolute root of nerve's OWN source tree (the repo it runs from). The agent self-hacks here via the
 *  `self:` tool-path prefix regardless of cwd (D36). paths.ts lives in `src/`, so the root is one up. */
export function nerveSourceRoot(): string {
  return resolve(import.meta.dir, "..");
}

/** Optional global model catalog; overrides the bundled `config/models.json` when present. */
export function globalModelsPath(): string {
  return join(nerveHome(), "models.json");
}

/** Optional global LSP catalog; overrides the bundled `config/lsp.json` when present. */
export function globalLspPath(): string {
  return join(nerveHome(), "lsp.json");
}

/** Create the project + global skill/command/session dirs so they exist and are discoverable. */
export function ensureLayout(cwd: string = process.cwd()): void {
  for (const d of [
    join(nerveHome(), "skills"),
    join(nerveHome(), "commands"),
    join(projectDir(cwd), "skills"),
    join(projectDir(cwd), "commands"),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  // the project's nerve.db (sessions) is created lazily by openDb on first use (D31)
}
