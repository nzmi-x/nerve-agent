import { test, expect } from "bun:test";
import { panelLayout } from "../src/tui/sidebar.ts";

// A state where every optional panel is empty (the bottom defaults to files).
const empty = {
  todos: [] as any[],
  skills: [] as string[],
  lspServers: [] as { id: string; state: string }[],
  tools: [] as any[],
  subagents: [] as any[],
  files: [] as string[],
  bottomView: "files" as const,
};

test("panelLayout: a fresh session shows only the always-on panels", () => {
  // No todos/skills/lsp/tools/subagents/files yet → nothing but cwd + session (no '(none yet)' placeholders).
  expect(panelLayout(empty)).toEqual(["cwdPanel", "sessionPanel"]);
});

test("panelLayout: each panel appears only once it has a value", () => {
  expect(panelLayout({ ...empty, todos: [{ content: "x", status: "pending" }] })).toContain("todosPanel");
  expect(panelLayout({ ...empty, skills: ["python"] })).toContain("skillsPanel");
  expect(panelLayout({ ...empty, lspServers: [{ id: "pyright", state: "running" }] })).toContain("lspPanel");
  expect(panelLayout({ ...empty, tools: [{ name: "read", status: "ok" }] })).toContain("toolsPanel");
  expect(panelLayout({ ...empty, subagents: [{ prompt: "p", status: "done" }] })).toContain("subagentsPanel");
  expect(panelLayout({ ...empty, files: ["a.ts"] })).toContain("filesPanel");
});

test("panelLayout: panels keep their canonical top-to-bottom order", () => {
  const all = panelLayout({
    todos: [{}],
    skills: ["s"],
    lspServers: [{ id: "x", state: "running" }],
    tools: [{}],
    subagents: [{}],
    files: ["a.ts"],
    bottomView: "files",
  } as any);
  expect(all).toEqual([
    "cwdPanel",
    "sessionPanel",
    "todosPanel",
    "skillsPanel",
    "lspPanel",
    "toolsPanel",
    "subagentsPanel",
    "filesPanel",
  ]);
});

test("panelLayout: the git view takes the bottom slot over files, even with files touched", () => {
  const layout = panelLayout({ ...empty, files: ["a.ts"], bottomView: "git" });
  expect(layout).toContain("gitPanel");
  expect(layout).not.toContain("filesPanel");
  expect(layout.at(-1)).toBe("gitPanel"); // always last
});

test("panelLayout: the git view shows even when empty (the user toggled it on)", () => {
  // Files hides when empty, but git is an explicit Ctrl+G request → always present.
  expect(panelLayout({ ...empty, bottomView: "git" })).toContain("gitPanel");
  expect(panelLayout({ ...empty, bottomView: "files" })).not.toContain("filesPanel");
});
