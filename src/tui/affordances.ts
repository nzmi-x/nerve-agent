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
  { name: "models", description: "Switch model, then pick thinking effort" },
  { name: "effort", description: "Change thinking effort (off/minimal/low/medium/high/xhigh)" },
  { name: "mode", description: "Toggle PLAN ↔ EDIT" },
  { name: "git", description: "Swap the sidebar's files ↔ git view (Ctrl+G)" },
  { name: "clear", description: "Clear the transcript (keeps the session)" },
  { name: "compact", description: "Summarize old turns to free up context" },
  { name: "reload", description: "Hot-swap tools + interceptors from disk (Ctrl+R)" },
  { name: "drop", description: "Delete this session and start a fresh one" },
  { name: "balance", description: "Refresh the provider balance" },
  { name: "resume", description: "Resume the last session" },
  { name: "sessions", description: "Browse sessions — resume or delete (interactive)" },
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

/** A short, human-readable summary of a tool call's key argument for the transcript line
 *  (`⎿ read app.ts`, `⎿ bash mkdir …`, `⎿ grep "foo"`). Falls back to the first string arg. Pure/tested. */
export function toolArgSummary(name: string, argsJson: string): string {
  let a: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(argsJson || "{}");
    if (v && typeof v === "object") a = v as Record<string, unknown>;
  } catch {
    /* malformed args → empty summary */
  }
  const s = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
  const q = (v: string): string => (/\s/.test(v) ? `"${v}"` : v);
  let out: string;
  switch (name) {
    case "read": case "write": case "edit": case "ls": case "notebook": out = s("path"); break;
    case "glob": out = s("pattern"); break;
    case "grep": out = q(s("pattern")) + (s("path") ? ` in ${s("path")}` : ""); break;
    case "bash": out = s("command"); break;
    case "fetch": out = s("url"); break;
    case "search": out = q(s("query")); break;
    case "manual": out = s("topic") || "(index)"; break;
    case "lsp": out = `${s("op")} ${s("path")}`.trim(); break;
    case "ask_user": out = s("question"); break;
    case "task": out = s("prompt").split("\n")[0] ?? ""; break;
    default: out = (Object.values(a).find((v) => typeof v === "string") as string | undefined) ?? "";
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 60 ? `${out.slice(0, 59)}…` : out;
}

/** Line count if a paste should collapse to a token (multi-line OR >200 chars), else `null` = short
 *  single-line, insert as-is. The caller stashes the full text under an id and inserts the token. */
export function pasteToken(text: string): number | null {
  const lines = text.replace(/\n+$/, "").split("\n").length;
  return lines <= 1 && text.length <= 200 ? null : lines;
}

/** Substitute `[Pasted N lines #id]` tokens with their stashed full text **by id** before sending, so a
 *  deleted/edited token is simply dropped (no order dependence) and the rest still resolve; clears `stash`. */
export function expandPastes(text: string, stash: Map<number, string>): string {
  if (!stash.size) return text;
  const out = text.replace(/\[Pasted \d+ lines? #(\d+)\]/g, (_, id: string) => stash.get(Number(id)) ?? "");
  stash.clear();
  return out;
}

/** Atomic paste tokens (#3): if the **single-character** deletion that turned `prev`→`cur` fell inside a
 *  `[Pasted N lines #id]` token, return the text with that WHOLE token removed + its id; else `null`. So one
 *  backspace inside a collapsed paste drops the entire token instead of leaving a broken `[Pasted …]`. */
export function dropBrokenPaste(prev: string, cur: string): { text: string; id: number } | null {
  if (prev.length - cur.length !== 1) return null; // only a single-character deletion
  let d = 0;
  while (d < cur.length && prev[d] === cur[d]) d++; // first differing index = the deleted position
  for (const m of prev.matchAll(/\[Pasted \d+ lines? #(\d+)\]/g)) {
    const start = m.index ?? 0;
    if (d >= start && d < start + m[0].length) {
      return { text: prev.slice(0, start) + prev.slice(start + m[0].length), id: Number(m[1]) };
    }
  }
  return null;
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
