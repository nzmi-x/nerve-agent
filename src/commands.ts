// Markdown slash commands (D16). A `/<name>` resolves to a `<name>.md` file under any command root
// (`commandRoots` in paths.ts: ~/.nerve + ./.claude + ~/.claude, D22). On invocation the body is
// expanded into a prompt with `$1 $2 …` / `$@` / `$ARGUMENTS`
// substitution and submitted as if typed. Discovery + expansion are pure/fs-only so they're tested
// here, away from the TUI. A built-in command of the same name always wins (handled by the caller).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";

export interface Command {
  name: string; // file stem (or frontmatter `name`)
  description: string; // frontmatter `description`, else the first body line
  body: string; // the template, sans frontmatter
}

/** Expand a command template against its args: `$ARGUMENTS`/`$@` → all args, `$1`,`$2`… → positional.
 *  If the template used no placeholder but args were given, the args are appended (oh-my-pi behavior). */
export function expandCommand(body: string, args: string[]): string {
  const all = args.join(" ");
  let used = false;
  const out = body
    .replace(/\$ARGUMENTS\b|\$@/g, () => ((used = true), all))
    .replace(/\$(\d+)/g, (_, d: string) => ((used = true), args[Number(d) - 1] ?? ""));
  return !used && all ? `${out.trimEnd()}\n\n${all}` : out;
}

/** Discover `*.md` command files under the given roots (first root wins on a name collision). */
export async function discoverCommands(roots: readonly string[]): Promise<Command[]> {
  const out: Command[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist — skip
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const stem = e.name.slice(0, -3);
      const parsed = parseCommand(await Bun.file(join(root, e.name)).text());
      const name = parsed.name ?? stem;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, description: parsed.description, body: parsed.body });
    }
  }
  return out;
}

/** Split optional `--- … ---` frontmatter from the body; derive a description if none is given. */
function parseCommand(md: string): { name?: string; description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  const body = (m ? md.slice(m[0].length) : md).trim();
  const fm: { name?: string; description?: string } = {};
  if (m) {
    for (const line of m[1]!.split("\n")) {
      const kv = /^(name|description):\s*(.+)$/.exec(line.trim());
      if (kv) fm[kv[1] as "name" | "description"] = kv[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  return { name: fm.name, description: fm.description ?? firstLineDesc(body), body };
}

function firstLineDesc(body: string): string {
  const line = body.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
