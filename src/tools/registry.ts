// The tool registry: builds the active tool set, a name lookup, and the provider-facing specs.
// Not a barrel — it assembles the registry (logic). New tools are added here.
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

/** The Phase-1 tool set. `lsp` joins in Phase 2. */
export const tools: readonly Tool[] = [read, write, edit, bash, ls, grep, glob, manual];

export function toolByName(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

/** Provider-facing declarations (name/description/parameters), passed to both clients unchanged. */
export function toolSpecs(): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
