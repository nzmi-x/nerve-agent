// The `task` tool (D6): delegate a self-contained sub-task to a fresh subagent — a clean context on the
// cheap model — to keep the main thread lean. Resolves the subagent model/provider (config) + a curated
// **read-only** toolset (the registry's `readonly` tools minus `task`/`askUser`/`todo`), then runs the
// sub-loop via `runSubagent`. Read-only itself (it only spawns a PLAN-mode subagent) → PLAN-safe.
import { runSubagent } from "../subagent.ts";
import { loadModels, selectSubagentModel, providerFor } from "../config.ts";
import { tools } from "./registry.ts";
import type { Tool } from "./types.ts";

// Excluded from the subagent's toolset: `task` (no recursion), `askUser`/`todo` (no human / UI surface).
const SUBAGENT_EXCLUDE = new Set(["task", "askUser", "todo"]);

export const task: Tool = {
  name: "task",
  description:
    "Delegate an isolable, read-only lookup to a fresh sub-agent (clean context, cheaper model) that returns " +
    "ONLY its final summary. Give a COMPLETE, standalone instruction — it shares none of your context. Good for " +
    "context-heavy research (search many files, trace callers, digest docs). The sub-agent is read-only and " +
    "can't spawn sub-agents; do small or editing work yourself.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "A complete, standalone instruction for the sub-agent — it shares no context with you, so spell out what to find and how to report it.",
      },
    },
    required: ["prompt"],
  },
  readonly: true, // the sub-agent runs read-only (PLAN), so spawning one is itself PLAN-safe
  async run(args, ctx) {
    if (typeof args.prompt !== "string" || !args.prompt.trim()) return "Error: 'prompt' must be a non-empty string";
    let model, provider;
    try {
      model = selectSubagentModel(loadModels());
      provider = providerFor(model);
    } catch (e) {
      return `Error: can't start a subagent — ${e instanceof Error ? e.message : String(e)}`;
    }
    const subTools = tools
      .filter((t) => t.readonly && !SUBAGENT_EXCLUDE.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const prompt = args.prompt.trim();
    const id = Math.random().toString(36).slice(2, 8);
    ctx.onSubagent?.({ id, prompt, phase: "start" });
    let input = 0;
    let output = 0;
    const out = await runSubagent({
      prompt,
      provider,
      model: model.id,
      tools: subTools,
      cwd: ctx.cwd,
      signal: ctx.signal ?? new AbortController().signal,
      lsp: ctx.lsp,
      onUsage: (u) => ((input += u.input), (output += u.output)),
    });
    // Bill the subagent's token spend to the session (D6) — its OWN model's pricing, off the main context.
    const p = model.pricing;
    if (p && (input || output)) ctx.onCost?.((input / 1e6) * p.input + (output / 1e6) * p.output);
    ctx.onSubagent?.({ id, prompt, phase: "end", ok: !out.startsWith("subagent failed") });
    return out;
  },
};
