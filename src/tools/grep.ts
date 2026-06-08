import { resolve } from "node:path";
import { resolvePath } from "./resolve.ts";
import type { Tool } from "./types.ts";

const IGNORE = /(^|\/)(node_modules|\.git|references|\.nerve|dist|out)\//;
const BINARY = /\x00/; // a NUL byte ⇒ treat the file as binary and skip it
const MAX_MATCHES = 100;
const MAX_FILE_BYTES = 1_000_000;

export const grep: Tool = {
  name: "grep",
  description: "Search file contents for a JavaScript regular expression. Returns `path:line:text` matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression (case-sensitive)." },
      path: { type: "string", description: "Base directory (default: working dir)." },
      glob: { type: "string", description: "Limit to files matching this glob (default: all files)." },
    },
    required: ["pattern"],
  },
  readonly: true,
  async run(args, ctx) {
    if (typeof args.pattern !== "string") return "Error: 'pattern' must be a string";
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch (e) {
      return `Error: invalid regex: ${(e as Error).message}`;
    }
    const base = resolvePath(ctx.cwd, typeof args.path === "string" ? args.path : ".");
    const pattern = typeof args.glob === "string" ? args.glob : "**/*";
    const matches: string[] = [];
    try {
      outer: for await (const rel of new Bun.Glob(pattern).scan({ cwd: base, onlyFiles: true, dot: false })) {
        if (IGNORE.test(rel)) continue;
        const file = Bun.file(resolve(base, rel));
        if (file.size > MAX_FILE_BYTES) continue;
        const text = await file.text();
        if (BINARY.test(text)) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            matches.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 200)}`);
            if (matches.length >= MAX_MATCHES) break outer;
          }
        }
      }
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
    if (matches.length === 0) return "No matches.";
    const capped = matches.length >= MAX_MATCHES;
    return matches.join("\n") + (capped ? `\n… (capped at ${MAX_MATCHES} matches)` : "");
  },
};
