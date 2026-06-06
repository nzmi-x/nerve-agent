import { resolve } from "node:path";
import type { Tool } from "./types.ts";
import type { LspOp } from "../lsp/manager.ts";

const OPS: LspOp[] = ["definition", "references", "implementation", "typeDefinition", "hover", "documentSymbol", "workspaceSymbol"];
const num = (v: unknown): number => (typeof v === "number" ? v : 1);

// Read-only LSP queries (D10) — `readonly: true`, so it works in PLAN mode (navigation/diagnosis is
// non-mutating). Routes to whichever configured server for the file's language advertises the op.
export const lsp: Tool = {
  name: "lsp",
  description:
    "Query the language server about code. ops: definition · references · implementation · typeDefinition · " +
    "hover (type/signature at a position) · documentSymbol (outline of a file) · workspaceSymbol (find a symbol by name). " +
    "line/character are 1-based (editor coords); workspaceSymbol uses `query` instead.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: OPS, description: "Which query to run." },
      path: { type: "string", description: "File the query is about; also selects the language server." },
      line: { type: "number", description: "1-based line (for definition/references/implementation/typeDefinition/hover)." },
      character: { type: "number", description: "1-based column." },
      query: { type: "string", description: "Symbol name to search for (workspaceSymbol)." },
    },
    required: ["op", "path"],
  },
  readonly: true,
  async run(args, ctx) {
    if (typeof args.path !== "string") return "Error: 'path' must be a string";
    const op = args.op;
    if (typeof op !== "string" || !OPS.includes(op as LspOp)) return `Error: unknown op '${String(op)}' — use: ${OPS.join(", ")}`;
    if (!ctx.lsp) return "LSP is not enabled (run without --no-lsp, and configure a server in config/lsp.json).";
    const abs = resolve(ctx.cwd, args.path);
    return ctx.lsp.query(op as LspOp, abs, num(args.line), num(args.character), typeof args.query === "string" ? args.query : undefined);
  },
};
