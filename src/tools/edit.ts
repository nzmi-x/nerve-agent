import { applyEdits, encode, type HashEdit } from "../hashline.ts";
import { resolvePath } from "./resolve.ts";
import type { Tool } from "./types.ts";

// Above this many lines, skip echoing fresh anchors on success (re-read a region instead).
const REANCHOR_CAP = 400;

export const edit: Tool = {
  name: "edit",
  description:
    "Apply hash-anchored edits to a file. Each edit anchors at a `LINE#HASH` from a prior `read`. " +
    "A stale anchor rejects the whole patch and returns fresh anchors to retry with.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working dir. Prefix `self:` to edit nerve's own source." },
      edits: {
        type: "array",
        description: "Edits against the file as last read; line numbers refer to that original.",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["replace", "append", "prepend"] },
            pos: { type: "string", description: 'Anchor `LINE#HASH`, e.g. "11#KT".' },
            end: { type: "string", description: "Optional end anchor for a `replace` range." },
            lines: { type: "array", items: { type: "string" }, description: "Replacement / inserted lines." },
          },
          required: ["op", "pos", "lines"],
        },
      },
    },
    required: ["path", "edits"],
  },
  readonly: false,
  async run(args, ctx) {
    if (typeof args.path !== "string") return "Error: 'path' must be a string";
    if (!Array.isArray(args.edits) || args.edits.length === 0)
      return "Error: 'edits' must be a non-empty array";

    const abs = resolvePath(ctx.cwd, args.path);
    const file = Bun.file(abs);
    if (!(await file.exists())) return `Error: no such file: ${args.path}`;
    const content = (await file.text()).replaceAll("\r\n", "\n");

    const result = applyEdits(content, args.edits as HashEdit[]);
    if (!result.ok) return `Edit rejected — ${result.error}\nFresh anchors:\n${result.anchors}`;

    await Bun.write(abs, result.content);
    ctx.onFileChange?.(abs, content, result.content); // D49: surface a diff of the change (display-only)
    ctx.touched?.add(abs);
    ctx.edited?.add(abs); // post-edit hooks run on this at turn end (D24)
    const n = result.content === "" ? 0 : result.content.replace(/\n$/, "").split("\n").length;
    const head = `Applied ${args.edits.length} edit(s) to ${args.path} (${n} lines)`;
    const body = n > REANCHOR_CAP ? head : `${head}\nUpdated anchors:\n${encode(result.content)}`;
    // D10: append language-server diagnostics so the agent sees breakage immediately.
    return ctx.lsp ? body + (await ctx.lsp.diagnostics(abs, result.content)) : body;
  },
};
