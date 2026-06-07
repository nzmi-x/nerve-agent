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

/** Skill discovery roots, most-specific first (callers dedup first-wins). Claude dirs + nerve dirs. */
export function skillRoots(cwd: string = process.cwd()): string[] {
  return [
    join(projectDir(cwd), "skills"), // ~/.nerve/projects/<slug>/skills (project)
    join(cwd, ".claude/skills"), // ./.claude/skills (project, Claude-compat)
    join(nerveHome(), "skills"), // ~/.nerve/skills (global)
    join(homedir(), ".claude/skills"), // ~/.claude/skills (user, Claude-compat)
  ];
}

/** Markdown slash-command roots (D16), most-specific first. */
export function commandRoots(cwd: string = process.cwd()): string[] {
  return [
    join(projectDir(cwd), "commands"), // ~/.nerve/projects/<slug>/commands
    join(cwd, ".claude/commands"), // ./.claude/commands (project, Claude-compat)
    join(nerveHome(), "commands"), // ~/.nerve/commands (global)
    join(homedir(), ".claude/commands"), // ~/.claude/commands (user, Claude-compat)
  ];
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
