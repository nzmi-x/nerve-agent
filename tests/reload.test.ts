import { test, expect } from "bun:test";
import { reloadTools, toolByName, toolSpecs } from "../src/tools/registry.ts";

// D7/D38: reloadTools re-scans src/tools/ cache-busted and swaps the active set. Here we verify the
// happy path — a swap re-discovers the full set, leaves the registry resolvable, and is deterministic
// (name-sorted). The broken-edit rollback can't be exercised without writing a bad module to disk; that
// path is a simple try/catch keep-old.
test("reloadTools: re-discovers the tool set and keeps the registry resolvable", async () => {
  const first = await reloadTools();
  expect(first.ok).toBe(true);
  const names = first.ok ? first.names.slice().sort() : [];

  // a second reload yields the identical set (discovery is deterministic)
  const second = await reloadTools();
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.names.slice().sort()).toEqual(names);

  // dispatch resolves against the (now freshly-imported) active set
  expect(toolByName("read")?.name).toBe("read");
  expect(toolByName("bash")?.readonly).toBe(false);
  expect(toolByName("nope")).toBeUndefined();

  // specs reflect the active set after the swap
  expect(toolSpecs().map((s) => s.name).sort()).toEqual(names);
});

test("reloadTools: discovers the full tool set in deterministic (name-sorted) order", async () => {
  const res = await reloadTools();
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.names).toEqual(["ask_user", "bash", "edit", "fetch", "glob", "grep", "ls", "lsp", "manual", "notebook", "read", "search", "task", "todo", "write"]);
  }
});
