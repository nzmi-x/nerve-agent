// The right-hand dashboard (D29): bordered panels — cwd · session · todos · skills · lsp · tools ·
// subagents · (files | git) — mirroring live session state. app.ts owns the state and gathers it into a
// `SidebarState` per render; this module owns the panels, the row pools, and the fill/height logic.
// Each panel's title takes its border colour (OpenTUI has no separate title colour), so they get distinct
// accents. The bottom flex-grow slot holds EITHER files or git (D49) — `bottomView` toggles it (Ctrl+G).
// Hidden (width 0) below SIDEBAR_MIN cols or when toggled off — methods no-op then.
import { BoxRenderable, TextRenderable, createCliRenderer, t, fg, bg } from "@opentui/core";
import { relative } from "node:path";
import { formatCost, formatContext } from "../usage.ts";
import { formatBalance, type Balance } from "../balance.ts";
import { trunc, shortenPath } from "./format.ts";
import type { GraphRow } from "../git.ts";
import type { Theme } from "./theme.ts";
import type { Mode } from "../dispatch.ts";
import type { Todo } from "../tools/types.ts";

type Renderer = Awaited<ReturnType<typeof createCliRenderer>>;
type Content = string | ReturnType<typeof t>;

export const SIDEBAR_W = 34;
export const SIDEBAR_MIN = 100; // below this terminal width the main column needs the room — sidebar hides

/** A live snapshot the sidebar paints. app.ts assembles it from its own state on each `render()`. */
export interface SidebarState {
  model: string;
  contextWindow?: number;
  mode: Mode;
  balance: Balance | null;
  usage: { costUsd: number; contextTokens: number };
  busy: boolean;
  activity: Content; // pre-rendered spinner chunk (app.ts owns the animation/colour); "" when idle
  skills: string[];
  lspServers: { id: string; state: string }[];
  tools: { name: string; status: "running" | "ok" | "err" }[];
  subagents: { prompt: string; status: "running" | "done" | "failed" }[];
  files: string[];
  sessionEdited: ReadonlySet<string>;
  cwd: string;
  branch?: string; // D49: current git branch (null/absent off a repo)
  gitDirty?: number; // changed-file count
  ahead?: number;
  behind?: number;
  gitGraph?: GraphRow[]; // the git view's branch graph — `git log --graph` rows (Ctrl+G)
  bottomView: "files" | "git"; // which panel fills the bottom slot (D49)
  todos: Todo[];
  termHeight: number;
}

/** The ordered panel ids that should sit in the layout for this state — the others have no value yet, so we
 *  hide them entirely (a bordered box can't collapse to height 0, so "hide" = drop it from the layout). cwd +
 *  session are always present; tools/subagents are transient (app.ts clears them between exchanges). Pure +
 *  exported so the visibility rules are unit-testable without a renderer. */
export function panelLayout(
  s: Pick<SidebarState, "todos" | "skills" | "lspServers" | "tools" | "subagents" | "files" | "bottomView">,
): string[] {
  const ids = ["cwdPanel", "sessionPanel"];
  if (s.todos.length) ids.push("todosPanel");
  if (s.skills.length) ids.push("skillsPanel");
  if (s.lspServers.length) ids.push("lspPanel");
  if (s.tools.length) ids.push("toolsPanel");
  if (s.subagents.length) ids.push("subagentsPanel");
  if (s.bottomView === "git") ids.push("gitPanel"); // user toggled it on (Ctrl+G) — show even if empty
  else if (s.files.length) ids.push("filesPanel"); // default bottom, but only once a file is touched
  return ids;
}

export interface Sidebar {
  readonly box: BoxRenderable;
  readonly visible: boolean;
  render(s: SidebarState): void;
  setActivity(chunk: Content): void;
  setVisible(visible: boolean): void;
  retheme(): void;
}

export function createSidebar(renderer: Renderer, theme: Theme): Sidebar {
  const W = SIDEBAR_W - 4; // inner text width (border + padding)
  const box = new BoxRenderable(renderer, { id: "sidebar", flexShrink: 0, width: 0, height: "100%", flexDirection: "column", paddingLeft: 1 });
  const mkPanel = (id: string, title: string, color: () => string, grow = false): BoxRenderable =>
    new BoxRenderable(renderer, { id, flexShrink: 0, ...(grow ? { flexGrow: 1 } : {}), border: true, borderStyle: "rounded", borderColor: color(), title, paddingLeft: 1, paddingRight: 1, flexDirection: "column" });
  const mkRows = (panel: BoxRenderable, n: number, prefix: string, h: number): TextRenderable[] => {
    const rows: TextRenderable[] = [];
    for (let i = 0; i < n; i++) {
      const tr = new TextRenderable(renderer, { id: `${prefix}-${i}`, content: "", height: h });
      panel.add(tr);
      rows.push(tr);
    }
    return rows;
  };
  const cwdPanel = mkPanel("cwdPanel", " cwd ", () => theme.CYAN);
  const sessionPanel = mkPanel("sessionPanel", " session ", () => theme.CYAN);
  const todosPanel = mkPanel("todosPanel", " todos ", () => theme.ACCENT); // 1-line summary (full list is Ctrl+T)
  const skillsPanel = mkPanel("skillsPanel", " skills ", () => theme.MAGENTA);
  const lspPanel = mkPanel("lspPanel", " lsp ", () => theme.ACCENT);
  const toolsPanel = mkPanel("toolsPanel", " tools ", () => theme.GREEN);
  const subagentsPanel = mkPanel("subagentsPanel", " subagents ", () => theme.YELLOW);
  // Bottom flex-grow slot: files OR git (D49), whichever `bottomView` selects.
  const filesPanel = mkPanel("filesPanel", " files ", () => theme.ORANGE, true);
  const gitPanel = mkPanel("gitPanel", " git ", () => theme.GREEN, true);
  // A bordered box can't collapse to height 0 (the border has a min height), so "hide a panel" means drop it
  // from the layout, not resize it. `byId` maps panelLayout()'s ids back to boxes; `syncPanels` reconciles
  // the box's children to that ordered set — but only when the set changes (panelSig), since render() runs
  // every keystroke. cwd + session are seeded so the box is never momentarily empty.
  const byId: Record<string, BoxRenderable> = {
    cwdPanel, sessionPanel, todosPanel, skillsPanel, lspPanel, toolsPanel, subagentsPanel, filesPanel, gitPanel,
  };
  const TOP_PANELS = [cwdPanel, sessionPanel, todosPanel, skillsPanel, lspPanel, toolsPanel, subagentsPanel];
  box.add(cwdPanel);
  box.add(sessionPanel);
  let panelSig = "cwdPanel,sessionPanel";
  const syncPanels = (ids: string[]): void => {
    const sig = ids.join(",");
    if (sig === panelSig) return;
    panelSig = sig;
    for (const c of [...box.getChildren()]) box.remove(c.id);
    for (const id of ids) box.add(byId[id]!);
  };
  // Height of the panels above the bottom slot — only those actually in the layout (hidden ones are gone).
  const topHeight = (): number => TOP_PANELS.reduce((h, p) => h + (box.getRenderable(p.id) ? p.height : 0), 0);
  const CWD_ROWS = 2; // path + branch
  const SESSION_ROWS = 6; // model, mode, cost, ctx, bal, streaming
  const SKILL_ROWS = 6;
  const LSP_ROWS = 5;
  const TOOL_ROWS = 6;
  const SUB_ROWS = 6;
  const FILE_ROWS = 40;
  const GIT_ROWS = 40;
  const cwdRows = mkRows(cwdPanel, CWD_ROWS, "cwd", 1);
  const sessionRows = mkRows(sessionPanel, SESSION_ROWS, "sess", 1);
  const todoSumRows = mkRows(todosPanel, 1, "todosum", 1); // single summary row
  const skillRows = mkRows(skillsPanel, SKILL_ROWS, "skill", 0);
  const lspRows = mkRows(lspPanel, LSP_ROWS, "lsp", 0);
  const toolRows = mkRows(toolsPanel, TOOL_ROWS, "tool", 0);
  const subagentRows = mkRows(subagentsPanel, SUB_ROWS, "sub", 0);
  const fileRows = mkRows(filesPanel, FILE_ROWS, "file", 0);
  const gitRows = mkRows(gitPanel, GIT_ROWS, "git", 0);

  /** The ahead/behind suffix (` ↑a ↓b`), only the nonzero parts — a chunk for `t`-interpolation. */
  const aheadBehind = (ahead?: number, behind?: number) =>
    ahead || behind ? fg(theme.MUTE)(`${ahead ? ` ↑${ahead}` : ""}${behind ? ` ↓${behind}` : ""}`) : "";

  // The 1-line todos panel (the full list is app.ts's Ctrl+T panel) — done/total + the current focus.
  function renderTodoSummary(todos: Todo[]): void {
    if (box.width === 0) return; // hidden — skip
    if (todos.length) {
      const done = todos.filter((td) => td.status === "completed").length;
      const inProg = todos.find((td) => td.status === "in_progress");
      const next = inProg ?? todos.find((td) => td.status === "pending");
      const icon = inProg ? fg(theme.YELLOW)("▸") : next ? fg(theme.MUTE)("○") : fg(theme.GREEN)("✓");
      todoSumRows[0]!.content = t`${icon} ${fg(theme.MUTE)(`${done}/${todos.length}`)} ${fg(theme.FG)(trunc(next ? next.content : "all done", W - 6))}`;
    } else {
      todoSumRows[0]!.content = t`${fg(theme.DIM)("(no todos)")}`;
    }
    todosPanel.height = 3; // 1 summary row + border
  }

  function render(s: SidebarState): void {
    if (box.width === 0) return; // hidden — skip the work
    // cwd panel (D49): working dir (starship-style) + git branch / dirty / ahead-behind, always on top.
    cwdRows[0]!.content = t`${fg(theme.FG)(trunc(shortenPath(s.cwd), W))}`;
    if (s.branch) {
      const dirty = s.gitDirty ? fg(theme.YELLOW)(`●${s.gitDirty}`) : fg(theme.GREEN)("✓");
      cwdRows[1]!.content = t`${fg(theme.MAGENTA)("⎇")} ${fg(theme.FG)(trunc(s.branch, W - 10))} ${dirty}${aheadBehind(s.ahead, s.behind)}`;
      cwdRows[1]!.height = 1;
    } else {
      cwdRows[1]!.content = "";
      cwdRows[1]!.height = 0;
    }
    cwdPanel.height = (s.branch ? 2 : 1) + 2;

    // session panel: model · mode · cost · ctx · bal (the title now lives in the transcript box border).
    sessionRows[0]!.content = t`${fg(theme.MUTE)("model ")}${fg(theme.FG)(trunc(s.model, W - 6))}`;
    sessionRows[1]!.content = s.mode === "edit" ? t`${fg(theme.MUTE)("mode  ")}${bg(theme.GREEN)(fg(theme.DARKFG)(" EDIT "))}` : t`${fg(theme.MUTE)("mode  ")}${bg(theme.YELLOW)(fg(theme.DARKFG)(" PLAN "))}`;
    sessionRows[2]!.content = t`${fg(theme.MUTE)("cost  ")}${fg(theme.FG)(formatCost(s.usage.costUsd))}`;
    sessionRows[3]!.content = t`${fg(theme.MUTE)("ctx   ")}${fg(theme.FG)(formatContext(s.usage.contextTokens, s.contextWindow))}`;
    sessionRows[4]!.content = t`${fg(theme.MUTE)("bal   ")}${fg(theme.GREEN)(formatBalance(s.balance))}`;
    sessionRows[5]!.content = s.busy ? s.activity : ""; // animated working/stopping indicator
    sessionRows[5]!.height = s.busy ? 1 : 0;
    sessionPanel.height = (s.busy ? 6 : 5) + 2; // grows by the streaming row + border
    renderTodoSummary(s.todos);

    // skills panel: skills loaded into context now — always-on defaults + active language packs (D24/D29).
    const skills = s.skills.slice(0, SKILL_ROWS);
    for (let i = 0; i < skillRows.length; i++) {
      const tr = skillRows[i]!;
      if (i < skills.length) {
        tr.content = t`${fg(theme.MAGENTA)("◆")} ${fg(theme.FG)(trunc(skills[i]!, W - 2))}`;
        tr.height = 1;
      } else {
        tr.content = "";
        tr.height = 0;
      }
    }
    skillsPanel.height = skills.length + 2;

    // lsp panel: spawn-attempted language servers + state (● running · ◌ spawning · ✗ failed/missing).
    const lspServers = s.lspServers.slice(0, LSP_ROWS);
    for (let i = 0; i < lspRows.length; i++) {
      const tr = lspRows[i]!;
      if (i < lspServers.length) {
        const ls = lspServers[i]!;
        const icon = ls.state === "running" ? fg(theme.GREEN)("●") : ls.state === "spawning" ? fg(theme.YELLOW)("◌") : fg(theme.RED)("✗");
        tr.content = t`${icon} ${fg(theme.FG)(trunc(ls.id, W - 2))}`;
        tr.height = 1;
      } else {
        tr.content = "";
        tr.height = 0;
      }
    }
    lspPanel.height = lspServers.length + 2;

    // tools panel: the main agent's tool calls this session + status (● running · ✓ ok · ✗ error).
    const toolWin = s.tools.slice(-TOOL_ROWS);
    for (let i = 0; i < toolRows.length; i++) {
      const tr = toolRows[i]!;
      if (i < toolWin.length) {
        const tc = toolWin[i]!;
        const icon = tc.status === "running" ? fg(theme.YELLOW)("●") : tc.status === "ok" ? fg(theme.GREEN)("✓") : fg(theme.RED)("✗");
        tr.content = t`${icon} ${fg(theme.FG)(trunc(tc.name, W - 2))}`;
        tr.height = 1;
      } else {
        tr.content = "";
        tr.height = 0;
      }
    }
    toolsPanel.height = toolWin.length + 2;

    // subagents panel: this session's `task` delegations + status (● running · ✓ done · ✗ failed).
    const subWin = s.subagents.slice(-SUB_ROWS);
    for (let i = 0; i < subagentRows.length; i++) {
      const tr = subagentRows[i]!;
      if (i < subWin.length) {
        const sa = subWin[i]!;
        const icon = sa.status === "running" ? fg(theme.YELLOW)("●") : sa.status === "done" ? fg(theme.GREEN)("✓") : fg(theme.RED)("✗");
        tr.content = t`${icon} ${fg(theme.MUTE)(trunc(sa.prompt, W - 2))}`;
        tr.height = 1;
      } else {
        tr.content = "";
        tr.height = 0;
      }
    }
    subagentsPanel.height = subWin.length + 2;

    // Reconcile which panels are in the layout (the no-value ones drop out), then fill the bottom slot.
    syncPanels(panelLayout(s));
    if (s.bottomView === "git") renderGit(s);
    else if (s.files.length) renderFiles(s);
  }

  // files panel: this session's touched files, most-recent first; ✎ = written/edited, · = read-only.
  function renderFiles(s: SidebarState): void {
    const files = s.files;
    const cap = Math.max(1, Math.min(FILE_ROWS, s.termHeight - (topHeight() + 2)));
    for (let i = 0; i < fileRows.length; i++) {
      const tr = fileRows[i]!;
      if (i < Math.min(files.length, cap)) {
        const f = files[i]!;
        const name = trunc(relative(s.cwd, f) || f, W - 2);
        tr.content = s.sessionEdited.has(f) ? t`${fg(theme.YELLOW)("✎")} ${fg(theme.FG)(name)}` : t`${fg(theme.DIM)("·")} ${fg(theme.MUTE)(name)}`;
        tr.height = 1;
      } else {
        tr.content = "";
        tr.height = 0;
      }
    }
  }

  // git panel (D49): branch/status header + a `git log --graph` of how branches relate (rail · hash ·
  // subject), capped to the panel's visible height (a bordered box can't scroll, so we trim — like files).
  function renderGit(s: SidebarState): void {
    const rows: Content[] = [];
    const dirty = s.gitDirty ? fg(theme.YELLOW)(`●${s.gitDirty}`) : fg(theme.GREEN)("✓ clean");
    rows.push(t`${fg(theme.MAGENTA)("⎇")} ${fg(theme.FG)(trunc(s.branch ?? "—", W - 12))} ${dirty}${aheadBehind(s.ahead, s.behind)}`);
    const graph = s.gitGraph ?? [];
    if (!graph.length) rows.push(t`${fg(theme.DIM)(s.branch ? "(no commits)" : "(not a git repo)")}`);
    for (const r of graph) {
      if (r.hash) rows.push(t`${fg(theme.MAGENTA)(r.rail)}${fg(theme.YELLOW)(r.hash)} ${fg(theme.FG)(trunc(r.subject, Math.max(4, W - r.rail.length - r.hash.length - 1)))}`);
      else rows.push(t`${fg(theme.MAGENTA)(r.rail.replace(/\s+$/, ""))}`); // connector line (rail only)
    }
    const cap = Math.max(1, Math.min(GIT_ROWS, s.termHeight - (topHeight() + 2)));
    for (let i = 0; i < gitRows.length; i++) {
      const show = i < Math.min(rows.length, cap);
      gitRows[i]!.content = show ? rows[i]! : "";
      gitRows[i]!.height = show ? 1 : 0;
    }
  }

  return {
    box,
    get visible() {
      return box.width > 0;
    },
    render,
    setActivity(chunk: Content) {
      if (box.width > 0) sessionRows[5]!.content = chunk;
    },
    setVisible(visible: boolean) {
      box.width = visible ? SIDEBAR_W : 0;
    },
    retheme() {
      cwdPanel.borderColor = theme.CYAN;
      sessionPanel.borderColor = theme.CYAN;
      todosPanel.borderColor = theme.ACCENT;
      skillsPanel.borderColor = theme.MAGENTA;
      lspPanel.borderColor = theme.ACCENT;
      toolsPanel.borderColor = theme.GREEN;
      subagentsPanel.borderColor = theme.YELLOW;
      filesPanel.borderColor = theme.ORANGE;
      gitPanel.borderColor = theme.GREEN;
    },
  };
}
