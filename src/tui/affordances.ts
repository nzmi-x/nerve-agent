// Input affordances for the TUI: `@path` file refs, `!cmd` shell escape, `/cmd` commands — and the
// autosuggestion logic behind them. All pure/fs-only so it's unit-tested; the rendering + key
// handling that consumes it lives in app.ts. See DECISIONS D14, docs/manual/tui.md.
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Dirent } from "node:fs";

export type Affordance =
  | { kind: "message" }
  | { kind: "at"; query: string } // @<query> — file/dir completion
  | { kind: "slash"; query: string } // /<query> — command/skill completion
  | { kind: "bang"; command: string }; // !<command> — direct shell

export interface CommandInfo {
  name: string;
  description: string;
}

/** A discovered skill — name+description for the `/` popup, plus the SKILL.md path loaded lazily (D12). */
export interface Skill extends CommandInfo {
  path: string;
}

export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "help", description: "Show commands and keybindings" },
  { name: "model", description: "Switch model — /model <id>" },
  { name: "mode", description: "Set mode — /mode plan|edit" },
  { name: "clear", description: "Clear the transcript (keeps the session)" },
  { name: "compact", description: "Summarize old turns to free up context — /compact [focus]" },
  { name: "reload", description: "Hot-swap tools + interceptors from disk (Ctrl+R)" },
  { name: "drop", description: "Delete this session and start a fresh one" },
  { name: "resume", description: "Resume last session (or /resume <id>)" },
  { name: "sessions", description: "List sessions; /sessions delete <id>" },
  { name: "exit", description: "Exit nerve" },
  { name: "quit", description: "Exit nerve" },
];

/** Detect the active input affordance. The cursor is assumed to be at the end (typical while typing). */
export function parseAffordance(value: string): Affordance {
  if (value.startsWith("!")) return { kind: "bang", command: value.slice(1) };
  if (value.startsWith("/")) return { kind: "slash", query: value.slice(1) };
  const at = value.lastIndexOf("@");
  if (at >= 0 && (at === 0 || /\s/.test(value[at - 1]!))) {
    const frag = value.slice(at + 1);
    if (!/\s/.test(frag)) return { kind: "at", query: frag };
  }
  return { kind: "message" };
}

const AT_IGNORE = new Set([".git", "node_modules"]);

/** File/dir completions for an `@<query>` reference, relative to cwd. Dirs get a trailing `/`. */
export async function atSuggestions(query: string, cwd: string, limit = 12): Promise<string[]> {
  const slash = query.lastIndexOf("/");
  const dirPart = slash >= 0 ? query.slice(0, slash + 1) : "";
  const prefix = slash >= 0 ? query.slice(slash + 1) : query;
  let entries: Dirent[];
  try {
    entries = await readdir(resolve(cwd, dirPart || "."), { withFileTypes: true });
  } catch {
    return [];
  }
  const lp = prefix.toLowerCase();
  const showDot = prefix.startsWith(".");
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(lp) && !AT_IGNORE.has(e.name) && (showDot || !e.name.startsWith(".")))
    .map((e) => dirPart + e.name + (e.isDirectory() ? "/" : ""))
    .sort()
    .slice(0, limit);
}

/** Commands + skills whose name matches a `/<query>` prefix. */
export function slashSuggestions(query: string, skills: readonly CommandInfo[]): CommandInfo[] {
  const q = query.toLowerCase();
  return [...BUILTIN_COMMANDS, ...skills].filter((c) => c.name.toLowerCase().startsWith(q));
}

/** Split a `/command args…` line into name + args. */
export function parseSlash(value: string): { name: string; args: string[] } {
  const parts = value.replace(/^\//, "").trim().split(/\s+/).filter(Boolean);
  return { name: parts[0] ?? "", args: parts.slice(1) };
}

/** Replace the active `@<query>` in value with `@<suggestion>` (lets the user keep drilling into dirs). */
export function applyAtSuggestion(value: string, suggestion: string): string {
  const at = value.lastIndexOf("@");
  return at < 0 ? value : value.slice(0, at + 1) + suggestion;
}

/** Discover skills (name + description from SKILL.md frontmatter; path for lazy load) under the roots (D12). */
export async function discoverSkills(roots: readonly string[]): Promise<Skill[]> {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let dirs: Dirent[];
    try {
      dirs = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || seen.has(d.name)) continue;
      const path = join(root, d.name, "SKILL.md");
      const f = Bun.file(path);
      if (!(await f.exists())) continue;
      const fm = parseFrontmatter(await f.text());
      seen.add(d.name);
      out.push({ name: fm.name ?? d.name, description: fm.description ?? "", path });
    }
  }
  return out;
}

/** Load a skill's instructions — its SKILL.md body, frontmatter stripped (read on invocation, D12). */
export async function loadSkillBody(path: string): Promise<string> {
  const md = await Bun.file(path).text();
  return md.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (!kv) continue;
    const val = kv[2]!.trim().replace(/^["']|["']$/g, "");
    if (kv[1] === "name") out.name = val;
    else out.description = val;
  }
  return out;
}
