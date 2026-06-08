import { encode } from "../hashline.ts";
import { resolvePath } from "./resolve.ts";
import type { Tool } from "./types.ts";

export const read: Tool = {
  name: "read",
  description:
    "Read a text file. Returns each line as `LINE#HASH:content`; pass those anchors to the `edit` tool.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working dir. Prefix `self:` to target nerve's own source." },
    },
    required: ["path"],
  },
  readonly: true,
  async run(args, ctx) {
    if (typeof args.path !== "string") return "Error: 'path' must be a string";
    const abs = resolvePath(ctx.cwd, args.path);
    ctx.touched?.add(abs); // language-pack trigger (D24)
    const file = Bun.file(abs);
    if (!(await file.exists())) return `Error: no such file: ${args.path}`;
    const content = (await file.text()).replaceAll("\r\n", "\n");
    const body = content === "" ? "(empty file)" : encode(content);
    // Prime the language server + surface any already-known diagnostics (no settle wait — D10).
    return ctx.lsp ? body + (await ctx.lsp.diagnostics(abs, content, false)) : body;
  },
};
