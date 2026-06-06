// Pure mappers from raw LSP result shapes to the terse text the agent reads. Kept separate from the
// manager so they're unit-testable without a live server. See docs/manual/lsp.md.
import type { Diagnostic } from "./client.ts";

export type LspOp = "definition" | "references" | "implementation" | "typeDefinition" | "hover" | "documentSymbol" | "workspaceSymbol";

/** LSP method + the server capability each op needs (so we skip servers that don't advertise it). */
export const OP: Record<LspOp, { method: string; capability: string }> = {
  definition: { method: "textDocument/definition", capability: "definitionProvider" },
  references: { method: "textDocument/references", capability: "referencesProvider" },
  implementation: { method: "textDocument/implementation", capability: "implementationProvider" },
  typeDefinition: { method: "textDocument/typeDefinition", capability: "typeDefinitionProvider" },
  hover: { method: "textDocument/hover", capability: "hoverProvider" },
  documentSymbol: { method: "textDocument/documentSymbol", capability: "documentSymbolProvider" },
  workspaceSymbol: { method: "workspace/symbol", capability: "workspaceSymbolProvider" },
};

const SEVERITY = ["", "error", "warning", "info", "hint"];
const KIND = ["", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum-member", "struct", "event", "operator", "type-param"];

const symbolKind = (n: unknown): string => KIND[Number(n)] ?? "symbol";
export const severityName = (n: number | undefined): string => SEVERITY[n ?? 1] ?? "error";

interface Pos { line: number; character: number }
interface RangeLike { start?: Pos }
interface LocLike { uri?: string; targetUri?: string; range?: RangeLike; targetSelectionRange?: RangeLike; targetRange?: RangeLike }

/** `path:line:col` from a Location or LocationLink (1-based, file:// stripped). */
export function loc(l: LocLike): string {
  const uri = l.uri ?? l.targetUri ?? "";
  const range = l.range ?? l.targetSelectionRange ?? l.targetRange;
  const line = (range?.start?.line ?? 0) + 1;
  const col = (range?.start?.character ?? 0) + 1;
  return `${uri.replace(/^file:\/\//, "")}:${line}:${col}`;
}

/** One formatted diagnostic line: `server L:C severity: message [code]`. */
export function formatDiagnostic(serverId: string, d: Diagnostic): string {
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  const code = d.code ? ` [${d.code}]` : "";
  return `  ${serverId} ${line}:${col} ${severityName(d.severity)}: ${d.message.split("\n")[0]}${code}`;
}

/** Map a raw LSP query result into agent-facing text. Empty string = no usable result. */
export function formatResult(op: LspOp, res: unknown): string {
  if (res == null) return "";
  if (op === "hover") {
    const c = (res as { contents?: unknown }).contents;
    const text =
      typeof c === "string" ? c
      : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : (x as { value?: string }).value ?? "")).join("\n")
      : (c as { value?: string })?.value ?? "";
    return String(text).trim();
  }
  if (op === "documentSymbol") {
    const arr = res as { name: string; kind: number; range?: RangeLike; location?: { range?: RangeLike }; children?: unknown[] }[];
    if (!Array.isArray(arr) || !arr.length) return "";
    const out: string[] = [];
    const walk = (syms: typeof arr, depth: number): void => {
      for (const s of syms) {
        const ln = (s.range?.start?.line ?? s.location?.range?.start?.line ?? 0) + 1;
        out.push(`${"  ".repeat(depth)}${symbolKind(s.kind)} ${s.name}  :${ln}`);
        if (Array.isArray(s.children)) walk(s.children as typeof arr, depth + 1);
      }
    };
    walk(arr, 0);
    return out.join("\n");
  }
  if (op === "workspaceSymbol") {
    const arr = res as { name: string; kind: number; location: LocLike }[];
    if (!Array.isArray(arr) || !arr.length) return "";
    return arr.slice(0, 50).map((s) => `${symbolKind(s.kind)} ${s.name}  ${loc(s.location)}`).join("\n");
  }
  // definition / references / implementation / typeDefinition → Location | Location[] | LocationLink[]
  const arr = (Array.isArray(res) ? res : [res]) as LocLike[];
  if (!arr.length) return "";
  return arr.map(loc).join("\n");
}
