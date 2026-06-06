import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import type { Tool } from "./types.ts";

export const ls: Tool = {
  name: "ls",
  description: "List the entries of a directory (directories are suffixed with '/').",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path (default: working dir)." } },
  },
  readonly: true,
  async run(args, ctx) {
    const dir = resolve(ctx.cwd, typeof args.path === "string" ? args.path : ".");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      return `Error: cannot list ${args.path ?? "."}: ${(e as Error).message}`;
    }
    if (entries.length === 0) return "(empty directory)";
    return entries
      .map((e) => e.name + (e.isDirectory() ? "/" : ""))
      .sort((a, b) => a.localeCompare(b))
      .join("\n");
  },
};
