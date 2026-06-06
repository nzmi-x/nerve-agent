// The tool registry: the active tool set, a name lookup, and the provider-facing specs. Not a barrel
// — it assembles the registry (logic). New tools are added here. The active set is **mutable** so
// `/reload` (D7) can hot-swap tool implementations live; `dispatch` resolves against it, so a reload
// needs no engine change. See docs/manual/tools.md.
import type { ToolSpec } from "../providers/types.ts";
import type { Tool } from "./types.ts";
import { read } from "./read.ts";
import { write } from "./write.ts";
import { edit } from "./edit.ts";
import { bash } from "./bash.ts";
import { ls } from "./ls.ts";
import { grep } from "./grep.ts";
import { glob } from "./glob.ts";
import { manual } from "./manual.ts";
import { askUser } from "./ask.ts";
import { lsp } from "./lsp.ts";
import { notebook } from "./notebook.ts";
import { todo } from "./todo.ts";

// Each tool's module + named export — the single list `reloadTools` re-imports cache-busted (D7).
// Add a tool = add its static import above (initial set) AND an entry here (so it hot-reloads).
const TOOL_MODULES: { path: string; name: string }[] = [
  { path: "./read.ts", name: "read" },
  { path: "./write.ts", name: "write" },
  { path: "./edit.ts", name: "edit" },
  { path: "./bash.ts", name: "bash" },
  { path: "./ls.ts", name: "ls" },
  { path: "./grep.ts", name: "grep" },
  { path: "./glob.ts", name: "glob" },
  { path: "./manual.ts", name: "manual" },
  { path: "./ask.ts", name: "askUser" },
  { path: "./lsp.ts", name: "lsp" },
  { path: "./notebook.ts", name: "notebook" },
  { path: "./todo.ts", name: "todo" },
];

/** The active tool set. `let`, not `const`, so `reloadTools` can swap it. */
export let tools: Tool[] = [read, write, edit, bash, ls, grep, glob, manual, askUser, lsp, notebook, todo];

export function toolByName(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

/** Provider-facing declarations (name/description/parameters), passed to both clients unchanged. */
export function toolSpecs(): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

function isTool(v: unknown): v is Tool {
  const t = v as Tool;
  return !!v && typeof v === "object" && typeof t.name === "string" && typeof t.readonly === "boolean" && typeof t.run === "function";
}

/**
 * Hot-swap (D7): re-import every tool module **cache-busted** (`?t=…`) and replace `tools`. On ANY
 * failure (import throws from a bad edit, or an export isn't a Tool) the **old set is kept** (rollback,
 * D11) — a broken edit never leaves the agent tool-less. The engine never swaps; only these leaves do.
 */
export async function reloadTools(): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
  const stamp = Date.now();
  const fresh: Tool[] = [];
  try {
    for (const m of TOOL_MODULES) {
      const mod = (await import(`${m.path}?t=${stamp}`)) as Record<string, unknown>;
      if (!isTool(mod[m.name])) return { ok: false, error: `${m.path}: export '${m.name}' is not a valid Tool` };
      fresh.push(mod[m.name] as Tool);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  tools = fresh;
  return { ok: true, names: fresh.map((t) => t.name) };
}
