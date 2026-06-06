import { resolve } from "node:path";
import type { Tool } from "./types.ts";

const IGNORE = /(^|\/)(node_modules|\.git|references|\.nerve|dist|out)\//;
const MAX = 200;

export const glob: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern (e.g. 'src/**/*.ts'). Returns matching paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern." },
      path: { type: "string", description: "Base directory to search (default: working dir)." },
    },
    required: ["pattern"],
  },
  readonly: true,
  async run(args, ctx) {
    if (typeof args.pattern !== "string") return "Error: 'pattern' must be a string";
    const cwd = resolve(ctx.cwd, typeof args.path === "string" ? args.path : ".");
    const out: string[] = [];
    try {
      for await (const p of new Bun.Glob(args.pattern).scan({ cwd, onlyFiles: true, dot: false })) {
        if (!IGNORE.test(p)) out.push(p);
      }
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
    if (out.length === 0) return "No files match.";
    out.sort();
    const capped = out.length > MAX;
    return (capped ? out.slice(0, MAX) : out).join("\n") + (capped ? `\n… (capped at ${MAX})` : "");
  },
};
