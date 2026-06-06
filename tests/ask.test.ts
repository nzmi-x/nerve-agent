import { test, expect } from "bun:test";
import { askUser } from "../src/tools/ask.ts";
import type { AskRequest, ToolContext } from "../src/tools/types.ts";

const OPTS = [
  { label: "A", description: "first", recommended: true },
  { label: "B", description: "second" },
];

test("ask_user: calls ctx.ask with the question + options and returns the answer", async () => {
  let seen: AskRequest | null = null;
  const ctx: ToolContext = {
    cwd: ".",
    ask: async (req) => {
      seen = req;
      return "B";
    },
  };
  const res = await askUser.run({ question: "Pick one?", options: OPTS }, ctx);
  expect(res).toBe("User answered: B");
  expect(seen!.question).toBe("Pick one?");
  expect(seen!.options.map((o) => o.label)).toEqual(["A", "B"]);
  expect(seen!.options[0]!.recommended).toBe(true);
});

test("ask_user: with no interactive surface, falls back to the recommended option", async () => {
  const res = await askUser.run({ question: "Pick?", options: OPTS }, { cwd: "." });
  expect(res).toContain("recommended option: A");
});

test("ask_user: validates inputs", async () => {
  expect(await askUser.run({ question: "x", options: [{ label: "only" }] }, { cwd: "." })).toContain("provide 2");
  expect(await askUser.run({ options: OPTS }, { cwd: "." })).toContain("'question' must be a string");
});

test("ask_user is readonly (usable in PLAN)", () => {
  expect(askUser.readonly).toBe(true);
});
