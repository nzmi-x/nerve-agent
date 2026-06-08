// The tool registry: the active tool set, a name lookup, and the provider-facing specs. The set is
// **discovered** by scanning this directory at boot (D38) — no static import list, no `TOOL_MODULES`
// to keep in sync — and is **mutable** so `/reload` (D7) can hot-swap tool implementations *and pick
// up newly-added tool files* live; `dispatch` resolves against it, so a reload needs no engine change.
// See docs/manual/tools.md.
import type { ToolSpec } from "../providers/types.ts";
import type { Tool } from "./types.ts";

// Files in this directory that are NOT tools (no Tool export) — skipped by the scan; everything else is
// imported and its Tool-shaped exports collected. (`task.ts` imports `tools` back from here — a safe
// cycle: it only reads the set at runtime, after `loadTools()` has populated it.) A new non-tool helper
// dropped in this dir must be added here, or the scan rejects it (a deliberate, loud constraint).
const NOT_TOOLS = new Set(["registry.ts", "types.ts", "resolve.ts"]);

/** The active tool set. Empty until `loadTools()` runs at boot; `reloadTools()` swaps it live (D7). */
export let tools: Tool[] = [];

export function toolByName(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

/** PLAN-visibility (D39): the tools nerve advertises *and* allows in PLAN mode — the read-only set plus
 *  `bash` (whose individual commands are gated per-command in `dispatch`). The single source of truth for
 *  "usable in PLAN", shared by `toolSpecs` (advertise) and `dispatch.allowed` (enforce) so they can't drift. */
export function planVisible(tool: Tool): boolean {
  return tool.readonly || tool.name === "bash";
}

/** Provider-facing declarations (name/description/parameters). In PLAN (`planOnly`), only the PLAN-visible
 *  tools are advertised (D39) — the model never sees a mutator it can't run, so it can't waste a turn on a
 *  refusal. EDIT advertises the whole set. */
export function toolSpecs(planOnly = false): ToolSpec[] {
  const visible = planOnly ? tools.filter(planVisible) : tools;
  return visible.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

function isTool(v: unknown): v is Tool {
  const t = v as Tool;
  return !!v && typeof v === "object" && typeof t.name === "string" && typeof t.readonly === "boolean" && typeof t.run === "function";
}

/**
 * Discover the tool set by scanning THIS directory (`import.meta.dir`, so it's correct from any cwd, D36):
 * import every `.ts` module and collect its `Tool`-shaped exports — export names need not match the tool
 * name (`fetch.ts` exports `fetchTool`, `ask.ts` exports `askUser`). `stamp` cache-busts the imports for
 * hot-reload (D7). Sorted by tool name with a locale-independent compare for a **deterministic** spec
 * order (prefix-cache stability, D37). Throws if a module fails to import OR yields no Tool — so a broken
 * edit surfaces as a rollback (D11) instead of a silently-missing tool.
 */
async function scanTools(stamp?: string): Promise<Tool[]> {
  const suffix = stamp ? `?t=${stamp}` : "";
  const found: Tool[] = [];
  for await (const file of new Bun.Glob("*.ts").scan({ cwd: import.meta.dir, onlyFiles: true })) {
    if (NOT_TOOLS.has(file)) continue;
    const mod = (await import(`./${file}${suffix}`)) as Record<string, unknown>;
    const inFile = Object.values(mod).filter(isTool);
    if (inFile.length === 0) throw new Error(`${file}: exports no Tool (add it to NOT_TOOLS if it isn't one)`);
    found.push(...inFile);
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Populate the registry once at boot (D38). Throws if nothing is found — nerve can't run tool-less. */
export async function loadTools(): Promise<string[]> {
  const fresh = await scanTools();
  if (fresh.length === 0) throw new Error("registry: no tools discovered under src/tools/");
  tools = fresh;
  return tools.map((t) => t.name);
}

/**
 * Hot-swap (D7): re-scan the directory **cache-busted** and replace `tools`. On ANY failure (a bad edit
 * throws on import, a module yields no Tool, or nothing is found) the **old set is kept** (rollback, D11)
 * — a broken edit never leaves the agent tool-less. Newly-added tool *files* are picked up too, no
 * registration edit needed (D38). The engine never swaps; only these leaf modules do.
 */
export async function reloadTools(): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
  try {
    const fresh = await scanTools(String(Date.now()));
    if (fresh.length === 0) return { ok: false, error: "no tools discovered" };
    tools = fresh;
    return { ok: true, names: fresh.map((t) => t.name) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
