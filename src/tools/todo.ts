// A task list the agent maintains across multi-step work (D25). The agent passes the FULL list each
// call (replace, not patch). The surface displays it — the TUI renders a pinned, colored panel; the
// headless runner prints a checklist. Read-only (it only touches ephemeral UI state) → PLAN-safe.
import type { Tool, Todo } from "./types.ts";

const ICON: Record<Todo["status"], string> = { pending: "○", in_progress: "▸", completed: "✓" };

/** Plain-text checklist — the tool result the model sees, and the headless display. */
export function renderTodos(todos: Todo[]): string {
  if (!todos.length) return "todos cleared";
  const done = todos.filter((t) => t.status === "completed").length;
  return [`todos · ${done}/${todos.length}`, ...todos.map((t) => `  ${ICON[t.status]} ${t.content}`)].join("\n");
}

function parse(raw: unknown): Todo[] | string {
  if (!Array.isArray(raw)) return "Error: 'todos' must be an array";
  const out: Todo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return "Error: each todo must be an object { content, status }";
    const { content, status } = item as Record<string, unknown>;
    if (typeof content !== "string" || !content.trim()) return "Error: each todo needs a non-empty 'content'";
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return `Error: status must be pending|in_progress|completed (got '${String(status)}')`;
    out.push({ content: content.trim(), status });
  }
  return out;
}

export const todo: Tool = {
  name: "todo",
  description:
    "Maintain a task list for multi-step work — plan up front, then mark progress as you go. Pass the " +
    "FULL list every call; it replaces the previous one. Keep exactly one item `in_progress`; flip items " +
    "to `completed` the moment they're done. Pass an empty list to clear it. Worth using whenever a task " +
    "has 3+ steps or the user gives multiple requests.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete task list (replaces the previous one).",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "What the step is (imperative, e.g. 'Wire the LSP manager')." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  readonly: true,
  async run(args, ctx) {
    const todos = parse(args.todos);
    if (typeof todos === "string") return todos; // a validation error
    ctx.setTodos?.(todos);
    return renderTodos(todos);
  },
};
