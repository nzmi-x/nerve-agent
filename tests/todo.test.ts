import { test, expect } from "bun:test";
import { renderTodos, todo } from "../src/tools/todo.ts";
import type { Todo, ToolContext } from "../src/tools/types.ts";

test("renderTodos: checklist with done/total count + status icons", () => {
  const todos: Todo[] = [
    { content: "done thing", status: "completed" },
    { content: "doing thing", status: "in_progress" },
    { content: "later thing", status: "pending" },
  ];
  const r = renderTodos(todos);
  expect(r).toContain("todos · 1/3");
  expect(r).toContain("✓ done thing");
  expect(r).toContain("▸ doing thing");
  expect(r).toContain("○ later thing");
  expect(renderTodos([])).toBe("todos cleared");
});

test("todo tool: validates, calls setTodos, returns the checklist; readonly", async () => {
  const calls: Todo[][] = [];
  const ctx: ToolContext = { cwd: ".", setTodos: (t) => void calls.push(t) };

  const ok = await todo.run({ todos: [{ content: " x ", status: "pending" }] }, ctx);
  expect(ok).toContain("todos · 0/1");
  expect(calls[0]).toEqual([{ content: "x", status: "pending" }]); // trimmed, passed to the surface

  expect(await todo.run({ todos: "nope" }, { cwd: "." })).toContain("must be an array");
  expect(await todo.run({ todos: [{ content: "", status: "pending" }] }, { cwd: "." })).toContain("non-empty");
  expect(await todo.run({ todos: [{ content: "x", status: "bad" }] }, { cwd: "." })).toContain("status must be");
  expect(todo.readonly).toBe(true); // PLAN-safe (only touches UI state)
});
