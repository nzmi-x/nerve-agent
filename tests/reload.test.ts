import { test, expect } from "bun:test";
import { reloadTools, toolByName, toolSpecs } from "../src/tools/registry.ts";

// D7: reloadTools re-imports every tool module cache-busted and swaps the active set. Here we verify
// the happy path — a swap leaves the registry fully resolvable (a broken-edit rollback can't be
// exercised without writing a bad module to disk; that path is a simple try/catch keep-old).
test("reloadTools: re-imports the tool modules and keeps the registry resolvable", async () => {
  const before = toolSpecs().map((s) => s.name).sort();

  const res = await reloadTools();
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.names.slice().sort()).toEqual(before);

  // dispatch resolves against the (now freshly-imported) active set
  expect(toolByName("read")?.name).toBe("read");
  expect(toolByName("bash")?.readonly).toBe(false);
  expect(toolByName("nope")).toBeUndefined();

  // specs reflect the active set after the swap
  expect(toolSpecs().map((s) => s.name).sort()).toEqual(before);
});

test("reloadTools: returns the full Phase-1 tool set", async () => {
  const res = await reloadTools();
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.names).toEqual(["read", "write", "edit", "bash", "ls", "grep", "glob", "manual", "ask_user"]);
  }
});
