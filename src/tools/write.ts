import { resolve } from "node:path";
import type { Tool } from "./types.ts";

export const write: Tool = {
  name: "write",
  description: "Create or overwrite a text file with the given content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working dir." },
      content: { type: "string", description: "Full file content to write." },
    },
    required: ["path", "content"],
  },
  readonly: false,
  async run(args, ctx) {
    if (typeof args.path !== "string") return "Error: 'path' must be a string";
    if (typeof args.content !== "string") return "Error: 'content' must be a string";
    await Bun.write(resolve(ctx.cwd, args.path), args.content); // creates parent dirs
    const n = args.content === "" ? 0 : args.content.replace(/\n$/, "").split("\n").length;
    return `Wrote ${args.path} (${n} line${n === 1 ? "" : "s"})`;
  },
};
