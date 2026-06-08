import { resolvePath } from "./resolve.ts";
import type { Tool } from "./types.ts";

export const write: Tool = {
  name: "write",
  description: "Create or overwrite a text file with the given content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working dir. Prefix `self:` to write nerve's own source." },
      content: { type: "string", description: "Full file content to write." },
    },
    required: ["path", "content"],
  },
  readonly: false,
  async run(args, ctx) {
    if (typeof args.path !== "string") return "Error: 'path' must be a string";
    if (typeof args.content !== "string") return "Error: 'content' must be a string";
    const abs = resolvePath(ctx.cwd, args.path);
    ctx.touched?.add(abs);
    ctx.edited?.add(abs); // post-edit hooks run on this at turn end (D24)
    await Bun.write(abs, args.content); // creates parent dirs
    const n = args.content === "" ? 0 : args.content.replace(/\n$/, "").split("\n").length;
    const head = `Wrote ${args.path} (${n} line${n === 1 ? "" : "s"})`;
    return ctx.lsp ? head + (await ctx.lsp.diagnostics(abs, args.content)) : head; // D10: did I break it?
  },
};
