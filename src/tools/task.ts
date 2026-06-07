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
    "Delegate a self-contained sub-task to a fresh sub-agent (clean context, cheaper model), which works " +
    "autonomously and returns ONLY its final summary. Give it a COMPLETE, standalone instruction — it shares " +
    "none of your context. Best for context-heavy research you don't want polluting the main thread: search " +
    "across many files, trace usages/callers, read and digest docs. The sub-agent is READ-ONLY (no edits, " +
    "shell, or user questions) and cannot spawn its own sub-agents. Do the work yourself when it's small or " +
    "needs edits; delegate when it's a big, isolable lookup.",
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
    const out = await runSubagent({
      prompt,
      provider,
      model: model.id,
      tools: subTools,
      cwd: ctx.cwd,
      signal: ctx.signal ?? new AbortController().signal,
      lsp: ctx.lsp,
    });
    ctx.onSubagent?.({ id, prompt, phase: "end", ok: !out.startsWith("subagent failed") });
    return out;
  },
};
