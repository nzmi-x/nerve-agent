import { resolve } from "node:path";
import { encode } from "../hashline.ts";
import type { Tool } from "./types.ts";

export const read: Tool = {
  name: "read",
  description:
    "Read a text file. Returns each line as `LINE#HASH:content`; pass those anchors to the `edit` tool.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working dir." },
    },
    required: ["path"],
  },
  readonly: true,
  async run(args, ctx) {
    if (typeof args.path !== "string") return "Error: 'path' must be a string";
    const file = Bun.file(resolve(ctx.cwd, args.path));
    if (!(await file.exists())) return `Error: no such file: ${args.path}`;
    const content = (await file.text()).replaceAll("\r\n", "\n");
    return content === "" ? "(empty file)" : encode(content);
  },
};
