// The interactive terminal UI (OpenTUI imperative core). Responsive layout (D29): a flex *row* — a main
// column (bordered markdown transcript, todo panel, autosuggest/ask popup, bordered input, status bar:
// model · mode · cost · context · balance) plus a collapsible sidebar (session + files panels). The
// sidebar toggles on Ctrl+B and auto-hides on narrow terminals. Affordances: @file, !shell, /command +
// an interactive ask_user picker. See docs/manual/tui.md; OpenTUI API via manual("opentui").
import { relative } from "node:path";
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  SyntaxStyle,
  RGBA,
  TextAttributes,
  t,
  bold,
  fg,
  bg,
  type KeyEvent,
} from "@opentui/core";
import { loop } from "../loop.ts";
import * as interceptorsMod from "../interceptors.ts";
import { bash } from "../tools/bash.ts";
import { reloadTools, toolSpecs } from "../tools/registry.ts";
import { selectModel, providerFor, fallbacksFor, type ModelEntry } from "../config.ts";
import { UsageMeter, formatCost, formatContext } from "../usage.ts";
import { fetchBalance, formatBalance, type Balance } from "../balance.ts";
import { parseAffordance, atSuggestions, slashSuggestions, parseSlash, applyAtSuggestion, loadSkillBody, type CommandInfo, type Skill } from "./affordances.ts";
import { expandCommand, type Command } from "../commands.ts";
import { pickCutPoint, pruneToolOutputs, summarize } from "../compaction.ts";
import { activePacks, activeSkillNames, defaultSkills, langForFile, langSkills, runHooks, triagePrompt } from "../langpack.ts";
import { listSessions, lastSessionId, sessionExists, deleteSession } from "../sessions.ts";
import { pickTheme } from "./theme.ts";
import type { Mode } from "../dispatch.ts";
import type { Message, Provider, ToolSpec } from "../providers/types.ts";
import type { AskRequest, Todo, SubagentEvent } from "../tools/types.ts";
import type { Lsp } from "../lsp/manager.ts";
import { Session } from "../session.ts";

// Palette — inherited from ghostty's Adwaita / Adwaita Dark, picked by the GNOME light/dark scheme (D30).
// `let` (not `const`) so a live system light/dark change can reassign it and the UI re-themes in place.
let { FG, MUTE, DIM, BORDER, ACCENT, GREEN, YELLOW, RED, MAGENTA, CYAN, ORANGE, SELBG, PANEL, DARKFG, WHITE } = pickTheme();

// Built from the current palette; rebuilt on a live theme change (D30) so existing markdown can re-theme.
function buildSyntaxStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(FG) },
    "markup.heading": { fg: RGBA.fromHex(ACCENT), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex(ACCENT), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(CYAN), bold: true },
    "markup.bold": { fg: RGBA.fromHex(YELLOW), bold: true },
    "markup.italic": { italic: true },
    "markup.list": { fg: RGBA.fromHex(MAGENTA) },
    "markup.raw": { fg: RGBA.fromHex(GREEN) },
    "markup.link": { fg: RGBA.fromHex(CYAN), underline: true },
    "markup.quote": { fg: RGBA.fromHex(DIM), italic: true },
    keyword: { fg: RGBA.fromHex(MAGENTA) },
    string: { fg: RGBA.fromHex(GREEN) },
    comment: { fg: RGBA.fromHex(DIM), italic: true },
    function: { fg: RGBA.fromHex(ACCENT) },
    number: { fg: RGBA.fromHex(ORANGE) },
    boolean: { fg: RGBA.fromHex(ORANGE) },
    type: { fg: RGBA.fromHex(CYAN) },
    property: { fg: RGBA.fromHex(CYAN) },
    operator: { fg: RGBA.fromHex(CYAN) },
    punctuation: { fg: RGBA.fromHex(MUTE) },
  });
}
let syntaxStyle = buildSyntaxStyle();

type Content = string | ReturnType<typeof t>;

const HELP = [
  "commands  /help · /model [id] · /mode plan|edit · /clear · /compact · /reload · /sessions · /resume [id] · /drop · /balance · /quit",
  "input     @path file ref · !cmd run shell directly · /cmd command",
  "keys      Enter send · Tab accept / toggle mode · ↑/↓ navigate · Shift+Tab mode · Ctrl+B sidebar · Ctrl+R reload · ESC stop · Ctrl+C quit",
].join("\n");

export interface TuiOptions {
  models: ModelEntry[];
  entry: ModelEntry;
  provider: Provider;
  session: Session;
  mode: Mode;
  cwd: string;
  system: string;
  tools: ToolSpec[];
  skills: Skill[];
  commands: Command[];
  compactionPrompt: string;
  titlePrompt: string;
  lsp?: Lsp;
}

interface Suggestion {
  name: string; // primary column (path or /command)
  desc?: string; // secondary column (command description)
  insert: string; // what Tab inserts
}
interface PopupRow {
  content: string;
  fg: string;
  bg?: string;
  bold?: boolean;
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  renderer.setBackgroundColor(DARKFG);
  const { models, cwd, system, skills, commands, compactionPrompt, titlePrompt } = opts;
  const slashExtra: CommandInfo[] = [...skills, ...commands]; // file commands + skills join the `/` popup
  // Hot-swappable leaf seams (D7): tool specs + interceptor factories. /reload re-imports them.
  let tools = opts.tools;
  let ic = interceptorsMod;
  // Language packs (D24): sticky set of files touched this session + the cached skill text to inject.
  const langTouched = new Set<string>();
  let langSkillText = "";
  let langSkillKey = "";

  let active = opts.entry;
  let provider = opts.provider;
  let session = opts.session;
  let meter = new UsageMeter();
  let balance: Balance | null = null;
  let mode: Mode = opts.mode;
  let busy = false;
  let turnAbort: AbortController | null = null;
  let lineId = 0;
  let echoGuard: string | null = null;
  let pendingRetheme = false; // a system light/dark change arrived mid-turn — apply it once idle (D30)
  let themeMonitor: ReturnType<typeof Bun.spawn> | null = null;

  let suggest: { kind: "at" | "slash" | "none"; items: Suggestion[]; sel: number } = { kind: "none", items: [], sel: 0 };
  let asking: { req: AskRequest; sel: number; resolve: (answer: string) => void } | null = null;

  // --- layout ---------------------------------------------------------------
  // Web-app mindset (D29): a flex *row* — the main column (transcript/input/status) grows to fill, and a
  // fixed-width sidebar sits beside it (session + files panels). The sidebar collapses on Ctrl+B and
  // auto-hides when the terminal is too narrow to spare the columns. `minWidth: 0` lets the main column
  // shrink so the fixed sidebar always gets its width (flexbox won't overflow it).
  const root = new BoxRenderable(renderer, { id: "root", width: "100%", height: "100%", flexDirection: "row", padding: 0 });
  const mainCol = new BoxRenderable(renderer, { id: "mainCol", flexGrow: 1, height: "100%", flexDirection: "column", minWidth: 0 });
  const transcriptBox = new BoxRenderable(renderer, {
    id: "transcriptBox",
    flexGrow: 1,
    width: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: BORDER,
    title: " ◆ nerve ",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const transcript = new ScrollBoxRenderable(renderer, { id: "transcript", flexGrow: 1, width: "100%", stickyScroll: true, stickyStart: "bottom" });
  transcriptBox.add(transcript);

  const todoBox = new BoxRenderable(renderer, { id: "todoBox", flexShrink: 0, height: 0, flexDirection: "column", paddingLeft: 1, paddingRight: 1 });
  const popup = new BoxRenderable(renderer, { id: "popup", flexShrink: 0, height: 0, flexDirection: "column", paddingLeft: 2, paddingRight: 1 });
  const inputBox = new BoxRenderable(renderer, {
    id: "inputBox",
    flexShrink: 0,
    width: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: BORDER,
    flexDirection: "row",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const prompt = new TextRenderable(renderer, { id: "prompt", content: "❯ ", fg: ACCENT, attributes: TextAttributes.BOLD });
  const input = new InputRenderable(renderer, { id: "input", flexGrow: 1, placeholder: "Message · @file · !shell · /command", textColor: FG, cursorColor: ACCENT });
  inputBox.add(prompt);
  inputBox.add(input);

  const status = new TextRenderable(renderer, { id: "status", height: 1, flexShrink: 0, content: "", bg: PANEL });

  // The responsive sidebar (populated in the sidebar block below); created here so it joins the row.
  const sidebar = new BoxRenderable(renderer, { id: "sidebar", flexShrink: 0, width: 0, height: "100%", flexDirection: "column", paddingLeft: 1 });
  mainCol.add(transcriptBox);
  mainCol.add(todoBox);
  mainCol.add(popup);
  mainCol.add(inputBox);
  mainCol.add(status);
  root.add(mainCol);
  root.add(sidebar);
  renderer.root.add(root);
  input.focus();

  // --- todo panel (D25): pinned, colored, updated in place by the `todo` tool -----------------
  const MAX_TODO_ROWS = 13; // 1 header + 12 items
  const todoRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_TODO_ROWS; i++) {
    const tr = new TextRenderable(renderer, { id: `todo-${i}`, content: "", height: 0 });
    todoBox.add(tr);
    todoRows.push(tr);
  }
  let currentTodos: Todo[] = []; // last set — replayed by retheme to recolor the panel (D30)
  const setTodos = (todos: Todo[]): void => {
    currentTodos = todos;
    const shown = todos.slice(0, MAX_TODO_ROWS - 1);
    const rows: Content[] = [];
    if (shown.length) {
      const done = todos.filter((td) => td.status === "completed").length;
      const extra = todos.length > shown.length ? `  +${todos.length - shown.length}` : "";
      rows.push(t`${bold(fg(ACCENT)("☑ todos"))} ${fg(MUTE)(`· ${done}/${todos.length}${extra}`)}`);
      for (const td of shown) {
        if (td.status === "completed") rows.push(t`${fg(GREEN)(" ✓")} ${fg(DIM)(td.content)}`);
        else if (td.status === "in_progress") rows.push(t`${fg(YELLOW)(" ▸")} ${bold(fg(WHITE)(td.content))}`);
        else rows.push(t`${fg(MUTE)(" ○")} ${fg(MUTE)(td.content)}`);
      }
    }
    for (let i = 0; i < todoRows.length; i++) {
      const tr = todoRows[i]!;
      tr.content = i < rows.length ? rows[i]! : "";
      tr.height = i < rows.length ? 1 : 0;
    }
    todoBox.height = rows.length;
  };

  // --- responsive sidebar (D29): session + files panels; Ctrl+B toggles, narrow terminals auto-hide ---
  const SIDEBAR_W = 34;
  const SIDEBAR_MIN = 100; // below this terminal width the main column needs the room — sidebar hides
  const W = SIDEBAR_W - 4; // inner text width (border + padding)
  let sidebarOn = true;
  const sessionEdited = new Set<string>(); // files written/edited this session → ✎ in the files panel
  const subagents: { id: string; prompt: string; status: "running" | "done" | "failed" }[] = []; // task runs this session
  const toolCalls: { id: string; name: string; status: "running" | "ok" | "err" }[] = []; // main-agent tool calls this session
  const mkPanel = (id: string, title: string, grow = false): BoxRenderable =>
    new BoxRenderable(renderer, { id, flexShrink: 0, ...(grow ? { flexGrow: 1 } : {}), border: true, borderStyle: "rounded", borderColor: BORDER, title, paddingLeft: 1, paddingRight: 1, flexDirection: "column" });
  const mkRows = (panel: BoxRenderable, n: number, prefix: string, h: number): TextRenderable[] => {
    const rows: TextRenderable[] = [];
    for (let i = 0; i < n; i++) {
      const tr = new TextRenderable(renderer, { id: `${prefix}-${i}`, content: "", height: h });
      panel.add(tr);
      rows.push(tr);
    }
    return rows;
  };
  const sessionPanel = mkPanel("sessionPanel", " session ");
  const skillsPanel = mkPanel("skillsPanel", " skills ");
  const toolsPanel = mkPanel("toolsPanel", " tools ");
  const subagentsPanel = mkPanel("subagentsPanel", " subagents ");
  const filesPanel = mkPanel("filesPanel", " files ", true);
  for (const p of [sessionPanel, skillsPanel, toolsPanel, subagentsPanel, filesPanel]) sidebar.add(p);
  const SESSION_ROWS = 7; // title, blank, model, mode, cost, ctx, bal
  const SKILL_ROWS = 6;
  const TOOL_ROWS = 6;
  const SUB_ROWS = 6;
  const FILE_ROWS = 40;
  const sessionRows = mkRows(sessionPanel, SESSION_ROWS, "sess", 1);
  const skillRows = mkRows(skillsPanel, SKILL_ROWS, "skill", 0);
  const toolRows = mkRows(toolsPanel, TOOL_ROWS, "tool", 0);
  const subagentRows = mkRows(subagentsPanel, SUB_ROWS, "sub", 0);
  const fileRows = mkRows(filesPanel, FILE_ROWS, "file", 0);
  sessionPanel.height = SESSION_ROWS + 2; // + border
  function renderSidebar(): void {
    if (sidebar.width === 0) return; // hidden — skip the work
    const s = meter.snapshot();
    sessionRows[0]!.content = t`${bold(fg(CYAN)(trunc(session.title || "untitled", W)))}`;
    sessionRows[1]!.content = busy ? t`${fg(YELLOW)("● streaming")}` : ""; // status bar is hidden while the sidebar shows
    sessionRows[2]!.content = t`${fg(MUTE)("model ")}${fg(FG)(trunc(active.id, W - 6))}`;
    sessionRows[3]!.content = mode === "edit" ? t`${fg(MUTE)("mode  ")}${bg(GREEN)(fg(DARKFG)(" EDIT "))}` : t`${fg(MUTE)("mode  ")}${bg(YELLOW)(fg(DARKFG)(" PLAN "))}`;
    sessionRows[4]!.content = t`${fg(MUTE)("cost  ")}${fg(FG)(formatCost(s.costUsd))}`;
    sessionRows[5]!.content = t`${fg(MUTE)("ctx   ")}${fg(FG)(formatContext(s.contextTokens, active.contextWindow))}`;
    sessionRows[6]!.content = t`${fg(MUTE)("bal   ")}${fg(GREEN)(formatBalance(balance))}`;
    // skills panel: skills loaded into context now — always-on defaults + active language packs (D24/D29).
    const skills = activeSkillNames(langTouched).slice(0, SKILL_ROWS);
    for (let i = 0; i < skillRows.length; i++) {
      const tr = skillRows[i]!;
      if (i < skills.length) {
        tr.content = t`${fg(MAGENTA)("◆")} ${fg(FG)(trunc(skills[i]!, W - 2))}`;
        tr.height = 1;
      } else {
        tr.content = "";
        tr.height = 0;
      }
    }
    skillsPanel.height = skills.length + 2;

    // tools panel: the main agent's tool calls this session + status (● running · ✓ ok · ✗ error).
    const toolWin = toolCalls.slice(-TOOL_ROWS);
    for (let i = 0; i < toolRows.length; i++) {
      const tr = toolRows[i]!;
      if (i < toolWin.length) {
        const tc = toolWin[i]!;
        const icon = tc.status === "running" ? fg(YELLOW)("●") : tc.status === "ok" ? fg(GREEN)("✓") : fg(RED)("✗");
        tr.content = t`${icon} ${fg(FG)(trunc(tc.name, W - 2))}`;
        tr.height = 1;
      } else if (i === 0) {
        tr.content = t`${fg(DIM)("(none yet)")}`;
        tr.height = 1;
      } else {
        tr.content = "";
        tr.height = 0;
      }
    }
    toolsPanel.height = Math.max(1, toolWin.length) + 2;

    // subagents panel: this session's `task` delegations + status (● running · ✓ done · ✗ failed).
    const subWin = subagents.slice(-SUB_ROWS);
    for (let i = 0; i < subagentRows.length; i++) {
      const tr = subagentRows[i]!;
      if (i < subWin.length) {
        const sa = subWin[i]!;
        const icon = sa.status === "running" ? fg(YELLOW)("●") : sa.status === "done" ? fg(GREEN)("✓") : fg(RED)("✗");
        tr.content = t`${icon} ${fg(MUTE)(trunc(sa.prompt, W - 2))}`;
        tr.height = 1;
      } else if (i === 0) {
        tr.content = t`${fg(DIM)("(none)")}`;
        tr.height = 1;
      } else {
        tr.content = "";
        tr.height = 0;
      }
    }
    subagentsPanel.height = Math.max(1, subWin.length) + 2;

    // files panel: this session's touched files, most-recent first; ✎ = written/edited, · = read-only.
    const files = [...langTouched].reverse();
    const usedAbove = SESSION_ROWS + 2 + (skills.length + 2) + (Math.max(1, toolWin.length) + 2) + (Math.max(1, subWin.length) + 2) + 2;
    const cap = Math.max(1, Math.min(FILE_ROWS, renderer.height - usedAbove));
    for (let i = 0; i < fileRows.length; i++) {
      const tr = fileRows[i]!;
      if (i < Math.min(files.length, cap)) {
        const f = files[i]!;
        const name = trunc(relative(cwd, f) || f, W - 2);
        tr.content = sessionEdited.has(f) ? t`${fg(YELLOW)("✎")} ${fg(FG)(name)}` : t`${fg(DIM)("·")} ${fg(MUTE)(name)}`;
        tr.height = 1;
      } else if (i === 0) {
        tr.content = t`${fg(DIM)("(none yet)")}`;
        tr.height = 1;
      } else {
        tr.content = "";
        tr.height = 0;
      }
    }
  }
  // Subagent lifecycle (D6) → the subagents panel. Pushed on start, flipped on end.
  const onSubagent = (ev: SubagentEvent): void => {
    if (ev.phase === "start") subagents.push({ id: ev.id, prompt: ev.prompt, status: "running" });
    else {
      const e = subagents.find((s) => s.id === ev.id);
      if (e) e.status = ev.ok ? "done" : "failed";
    }
    renderSidebar();
  };
  function applySidebar(): void {
    const visible = sidebarOn && renderer.width >= SIDEBAR_MIN;
    sidebar.width = visible ? SIDEBAR_W : 0;
    status.height = visible ? 0 : 1; // the session panel shows the same stats — only one of them at a time
    setStatus(); // refresh the bar's content + the sidebar (each no-ops when hidden)
  }
  // Re-evaluate the breakpoint when the terminal resizes (guarded — older cores may not emit it).
  (renderer as { on?: (e: string, cb: () => void) => void }).on?.("resize", () => applySidebar());

  // --- transcript -----------------------------------------------------------
  // Every line keeps what it needs to re-render itself, so a live theme change (D30) recolors in place with
  // **zero loss**: `text` lines rebuild from their `make` thunk (it re-reads the palette); `plain` lines —
  // incl. the streaming reasoning line, which accumulates via `.content +=` — just recolor `fg`; `md` blocks
  // swap `syntaxStyle` + re-set content. Everything added to the transcript goes through these helpers.
  type Line =
    | { kind: "text"; el: TextRenderable; make: () => Content }
    | { kind: "plain"; el: TextRenderable; role: () => string }
    | { kind: "md"; el: MarkdownRenderable };
  const lines: Line[] = [];
  // Styled line whose colours live in its content (a `t`…` thunk) — re-run verbatim on a theme change.
  const addText = (make: () => Content): TextRenderable => {
    const el = new TextRenderable(renderer, { id: `ln-${lineId++}`, content: make(), fg: FG });
    transcript.add(el);
    lines.push({ kind: "text", el, make });
    return el;
  };
  // Plain-text line tinted by one role colour (recoloured via `fg`); supports `.content +=` growth.
  const addPlain = (text: string, role: () => string = () => FG, attributes = 0): TextRenderable => {
    const el = new TextRenderable(renderer, { id: `ln-${lineId++}`, content: text, fg: role(), attributes });
    transcript.add(el);
    lines.push({ kind: "plain", el, role });
    return el;
  };
  const addMarkdown = (): MarkdownRenderable => {
    const el = new MarkdownRenderable(renderer, { id: `md-${lineId++}`, width: "100%", content: "", syntaxStyle, streaming: true });
    transcript.add(el);
    lines.push({ kind: "md", el });
    return el;
  };
  // Replace a styled line's content and remember the new thunk (so it survives a later theme change).
  const setText = (el: TextRenderable, make: () => Content): void => {
    const ln = lines.find((l) => l.el === el);
    if (ln?.kind === "text") ln.make = make;
    el.content = make();
  };
  const removeLine = (el: TextRenderable | MarkdownRenderable): void => {
    transcript.remove(el.id);
    const i = lines.findIndex((l) => l.el === el);
    if (i >= 0) lines.splice(i, 1);
  };
  const spacer = (): void => void addText(() => "");
  const clearTranscript = (): void => {
    for (const l of lines) transcript.remove(l.el.id);
    lines.length = 0;
  };
  // Re-theme the whole UI in place after a live light/dark switch (D30). Idle-only (deferred while busy).
  const retheme = (): void => {
    ({ FG, MUTE, DIM, BORDER, ACCENT, GREEN, YELLOW, RED, MAGENTA, CYAN, ORANGE, SELBG, PANEL, DARKFG, WHITE } = pickTheme());
    syntaxStyle = buildSyntaxStyle();
    renderer.setBackgroundColor(DARKFG);
    transcriptBox.borderColor = BORDER;
    inputBox.borderColor = BORDER;
    sessionPanel.borderColor = BORDER;
    skillsPanel.borderColor = BORDER;
    toolsPanel.borderColor = BORDER;
    subagentsPanel.borderColor = BORDER;
    filesPanel.borderColor = BORDER;
    status.bg = PANEL;
    prompt.fg = ACCENT;
    input.textColor = FG;
    input.cursorColor = ACCENT;
    for (const l of lines) {
      if (l.kind === "text") l.el.content = l.make();
      else if (l.kind === "plain") l.el.fg = l.role();
      else {
        l.el.syntaxStyle = syntaxStyle;
        l.el.content = l.el.content; // re-set to reparse with the new style
      }
    }
    setTodos(currentTodos); // recolor the todo panel pool
    setStatus(); // recolors the status bar + sidebar panels
  };
  // Apply a theme change now if idle, else once the current turn finishes (don't repaint mid-stream).
  const requestRetheme = (): void => {
    if (busy) pendingRetheme = true;
    else retheme();
  };
  const drainRetheme = (): void => {
    if (!pendingRetheme) return;
    pendingRetheme = false;
    retheme();
  };
  // Follow the GNOME light/dark scheme live (D30): `gsettings monitor` emits a line on each change — the
  // same signal ghostty resolves `theme = light:…,dark:…` against. Killed on exit. `$NERVE_THEME` opts out.
  const watchSystemTheme = (): void => {
    if (Bun.env.NERVE_THEME) return;
    try {
      themeMonitor = Bun.spawn(["gsettings", "monitor", "org.gnome.desktop.interface", "color-scheme"], { stdout: "pipe", stderr: "ignore" });
    } catch {
      return; // no gsettings (not GNOME) — stay on the startup theme
    }
    void (async () => {
      try {
        for await (const chunk of themeMonitor!.stdout as ReadableStream<Uint8Array>) {
          void chunk;
          if (pickTheme().DARKFG !== DARKFG) requestRetheme(); // ground actually flipped
        }
      } catch {
        /* monitor ended — keep the current theme */
      }
    })();
  };
  // Replay loaded messages into the transcript (for /resume). Reasoning isn't replayed (telemetry only).
  const renderHistory = (messages: Message[]): void => {
    for (const m of messages) {
      if (m.role === "user") {
        spacer();
        addText(() => t`${bold(fg(GREEN)("❯"))} ${m.content}`);
      } else if (m.role === "assistant") {
        if (m.content) {
          const md = addMarkdown();
          md.content = m.content;
          md.streaming = false;
        }
        for (const tc of m.toolCalls ?? []) addText(() => t`${fg(DIM)("⎿")} ${fg(MUTE)(tc.name)}`);
      } else if (m.role === "tool") {
        addText(() => t`${fg(DIM)("⎿")} ${fg(DIM)(firstLine(m.content))}`);
      }
    }
  };

  // --- popup (autosuggest + ask picker, with row highlight) -----------------
  // A fixed pool of row renderables we UPDATE in place (never recreate) — recreating with reused ids
  // left stale cells that bled old content through new rows. Inactive rows are height 0.
  const MAX_POPUP = 12;
  const popupRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_POPUP; i++) {
    const tr = new TextRenderable(renderer, { id: `pop-${i}`, content: "", height: 0, fg: MUTE });
    popup.add(tr);
    popupRows.push(tr);
  }
  const setPopup = (rows: PopupRow[]): void => {
    const n = Math.min(rows.length, MAX_POPUP);
    for (let i = 0; i < MAX_POPUP; i++) {
      const tr = popupRows[i]!;
      const row = i < n ? rows[i]! : null;
      tr.content = row ? row.content : "";
      tr.fg = row ? row.fg : MUTE;
      tr.bg = row?.bg ?? "transparent";
      tr.attributes = row?.bold ? TextAttributes.BOLD : 0;
      tr.height = row ? 1 : 0;
    }
    popup.height = n;
  };
  const suggestOpen = (): boolean => suggest.items.length > 0;
  const clearSuggest = (): void => {
    suggest = { kind: "none", items: [], sel: 0 };
    if (!asking) setPopup([]);
  };
  const renderSuggest = (): void => {
    if (asking) return;
    // dynamic columns: name column fits the longest name; description fills the rest of the width
    const colW = Math.max(0, ...suggest.items.map((it) => it.name.length)) + 2;
    const budget = Math.max(10, renderer.width - colW - 6);
    setPopup(
      suggest.items.map((it, i) => ({
        content: it.desc ? `${it.name.padEnd(colW)}${trunc(it.desc, budget)}` : it.name,
        fg: i === suggest.sel ? WHITE : MUTE,
        bg: i === suggest.sel ? SELBG : undefined,
        bold: i === suggest.sel,
      })),
    );
  };
  async function updateSuggestions(value: string): Promise<void> {
    if (asking) return;
    const aff = parseAffordance(value);
    if (aff.kind === "at") {
      const paths = await atSuggestions(aff.query, cwd);
      suggest = { kind: "at", items: paths.map((p) => ({ name: p, insert: p })), sel: 0 };
    } else if (aff.kind === "slash") {
      const cmds = slashSuggestions(aff.query, slashExtra).slice(0, MAX_POPUP);
      suggest = { kind: "slash", items: cmds.map((c) => ({ name: `/${c.name}`, desc: c.description, insert: c.name })), sel: 0 };
    } else {
      suggest = { kind: "none", items: [], sel: 0 };
    }
    renderSuggest();
  }
  function acceptSuggestion(): void {
    const it = suggest.items[suggest.sel];
    if (!it) return;
    const next = suggest.kind === "at" ? applyAtSuggestion(input.value, it.insert) : `/${it.insert} `;
    echoGuard = next;
    input.value = next;
    clearSuggest();
  }

  const renderAsk = (): void => {
    if (!asking) return;
    const rows: PopupRow[] = [{ content: `? ${asking.req.question}`, fg: ACCENT, bold: true }];
    asking.req.options.forEach((o, i) => {
      const sel = i === asking!.sel;
      rows.push({ content: `${o.label}${o.recommended ? "   (recommended)" : ""}${o.description ? `   ${trunc(o.description, Math.max(20, renderer.width - 28))}` : ""}`, fg: sel ? WHITE : MUTE, bg: sel ? SELBG : undefined, bold: sel });
    });
    setPopup(rows);
  };
  function ask(req: AskRequest): Promise<string> {
    return new Promise((resolve) => {
      const rec = req.options.findIndex((o) => o.recommended);
      asking = { req, sel: rec >= 0 ? rec : 0, resolve };
      renderAsk();
    });
  }

  // --- status ---------------------------------------------------------------
  const setStatus = (): void => {
    const s = meter.snapshot();
    const badge = mode === "edit" ? bg(GREEN)(fg(DARKFG)(" EDIT ")) : bg(YELLOW)(fg(DARKFG)(" PLAN "));
    status.content = t` ${fg(ACCENT)(active.id)}  ${badge}  ${fg(MUTE)("cost")} ${fg(FG)(formatCost(s.costUsd))}  ${fg(MUTE)("ctx")} ${fg(FG)(formatContext(s.contextTokens, active.contextWindow))}  ${fg(MUTE)("bal")} ${fg(GREEN)(formatBalance(balance))}${busy ? fg(YELLOW)("   ● streaming") : ""}`;
    renderSidebar(); // mirror the same stats into the sidebar (no-op when hidden)
  };

  const toggleMode = (): void => {
    mode = mode === "plan" ? "edit" : "plan";
    setStatus(); // the PLAN/EDIT badge (status bar + session panel) is the indicator — no transcript log
  };

  // --- actions --------------------------------------------------------------
  async function refreshBalance(): Promise<void> {
    const key = active.provider === "deepseek" ? Bun.env.DEEPSEEK_API_KEY : Bun.env.GEMINI_API_KEY;
    try {
      balance = key ? await fetchBalance(active.provider, key) : null;
    } catch {
      balance = null;
    }
    setStatus();
  }

  async function runShell(cmd: string): Promise<void> {
    const c = cmd.trim();
    if (!c) return;
    addText(() => t`${bold(fg(YELLOW)("$"))} ${c}`);
    try {
      addPlain(await bash.run({ command: c }, { cwd }), () => MUTE); // full authority, ungated, not added to the session
    } catch (e) {
      addPlain(`✗ ${e instanceof Error ? e.message : String(e)}`, () => RED);
    }
  }

  // D17: summarize old turns into one message to reclaim context. Manual for now; ESC cancels.
  const KEEP_TOKENS = 20_000;
  async function compact(focus: string): Promise<void> {
    if (busy) return;
    const cut = pickCutPoint(session.messages, KEEP_TOKENS);
    if (cut < 2) {
      addText(() => t`${fg(MAGENTA)("✦")} ${fg(MUTE)("nothing old enough to compact yet")}`);
      return;
    }
    busy = true;
    setStatus();
    const note = addText(() => t`${fg(MAGENTA)("✦")} ${fg(MUTE)("compacting…")}`);
    turnAbort = new AbortController();
    try {
      const input = pruneToolOutputs(session.messages.slice(0, cut)).messages; // shrink the summarizer's input
      const keep = session.messages.length - cut;
      const summary = await summarize(provider, active.id, input, compactionPrompt, focus, turnAbort.signal);
      session.compact(summary, keep);
      setText(note, () => t`${fg(MAGENTA)("✦")} ${fg(MUTE)(`compacted ${cut} earlier message(s) → summary · ${session.messages.length} now in context`)}`);
    } catch (e) {
      setText(note, () => t`${fg(RED)("✗")} ${fg(MUTE)(`compaction failed: ${e instanceof Error ? e.message : String(e)}`)}`);
    } finally {
      busy = false;
      turnAbort = null;
      setStatus();
      drainRetheme(); // D30
    }
  }

  // Hot-swap (D7): re-import tools + interceptors from disk, conversation preserved. The engine
  // (loop/dispatch/providers/session) never swaps — only these leaf seams. On failure the old set is
  // kept (rollback, D11). Takes effect from the next turn (mid-loop interceptors stay fixed).
  async function reload(): Promise<void> {
    const rt = await reloadTools();
    let icErr = "";
    try {
      ic = (await import(`../interceptors.ts?t=${Date.now()}`)) as typeof interceptorsMod;
    } catch (e) {
      icErr = e instanceof Error ? e.message : String(e);
    }
    if (rt.ok) tools = toolSpecs(); // refresh provider-facing specs for the next turn
    if (rt.ok && !icErr) addText(() => t`${fg(GREEN)("↻")} ${fg(MUTE)(`reloaded ${rt.names.length} tools + interceptors from disk`)}`);
    else addPlain(`✗ reload failed (kept the running set) — ${!rt.ok ? rt.error : icErr}`, () => RED);
  }

  // D26: auto-title the session from its first exchange (best-effort, async, non-blocking). The title
  // shows in the transcript header + the /sessions list and persists for resume.
  let titling = false;
  async function titleSession(): Promise<void> {
    if (titling || session.title || session.messages.length < 2) return;
    titling = true;
    try {
      const raw = await summarize(provider, active.id, session.messages.slice(0, 4), titlePrompt, "", new AbortController().signal);
      const title = (raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^[#*"'`\s]+/, "").replace(/["'`.\s]+$/, "").slice(0, 48);
      if (title) {
        session.setTitle(title);
        transcriptBox.title = ` ◆ ${title} `;
        renderSidebar(); // show the new title in the session panel
      }
    } catch {
      /* title is best-effort */
    } finally {
      titling = false;
    }
  }

  async function drop(): Promise<void> {
    const old = session.id;
    await session.close();
    deleteSession(cwd, old);
    session = new Session({ cwd });
    meter = new UsageMeter();
    langTouched.clear(); // fresh session: empty the files panel + reset language packs
    sessionEdited.clear();
    subagents.length = 0;
    toolCalls.length = 0;
    clearTranscript();
    setTodos([]); // fresh session, fresh task list
    transcriptBox.title = " ◆ nerve ";
    addText(() => t`${fg(MAGENTA)("✦")} ${fg(MUTE)(`dropped ${old} · new session ${session.id}`)}`);
    setStatus();
  }

  // /resume [id] — switch to an existing session (default: the most recent one that isn't this one).
  async function resumeSession(idArg?: string): Promise<void> {
    if (busy) return;
    const id = idArg ?? lastSessionId(cwd, session.id);
    if (!id) return void addPlain("no other session to resume", () => MUTE);
    if (!sessionExists(cwd, id)) return void addPlain(`✗ no session '${id}'`, () => RED);
    await session.close();
    session = new Session({ id, resume: true, cwd });
    meter = new UsageMeter();
    langTouched.clear(); // we don't replay tool calls — the files panel starts empty for the resumed session
    sessionEdited.clear();
    subagents.length = 0;
    toolCalls.length = 0;
    clearTranscript();
    renderHistory(session.messages);
    transcriptBox.title = session.title ? ` ◆ ${session.title} ` : " ◆ nerve ";
    addText(() => t`${fg(MAGENTA)("✦")} ${fg(MUTE)(`resumed ${id}${session.title ? ` · ${session.title}` : ""} · ${session.messages.length} message(s) in context`)}`);
    setStatus();
  }

  // /sessions — list sessions; /sessions delete <id> removes one (not the current — that's /drop).
  function sessionsCommand(args: string[]): void {
    const sub = args[0];
    if (sub === "delete" || sub === "rm") {
      const id = args[1];
      if (!id) return void addPlain("usage: /sessions delete <id>", () => MUTE);
      if (id === session.id) return void addPlain("✗ that's the current session — use /drop", () => RED);
      if (!sessionExists(cwd, id)) return void addPlain(`✗ no session '${id}'`, () => RED);
      deleteSession(cwd, id);
      addText(() => t`${fg(MAGENTA)("✦")} ${fg(MUTE)(`deleted ${id}`)}`);
      return;
    }
    const list = listSessions(cwd);
    if (!list.length) return void addPlain("no sessions yet", () => MUTE);
    addText(() => t`${fg(ACCENT)("sessions")}  ${fg(DIM)("/resume <id> · /sessions delete <id>")}`);
    for (const s of list) {
      const cur = s.id === session.id;
      const label = s.title || s.preview;
      addText(() => t`${cur ? fg(GREEN)("●") : fg(DIM)("·")} ${fg(cur ? GREEN : FG)(s.id)}  ${fg(MUTE)(`${s.msgs}msg`)}  ${fg(DIM)(rel(s.mtimeMs))}  ${fg(s.title ? CYAN : DIM)(trunc(label, Math.max(16, renderer.width - 52)))}`);
    }
  }

  async function runCommand(value: string): Promise<void> {
    const { name, args } = parseSlash(value);
    switch (name) {
      case "help":
        addPlain(HELP, () => MUTE);
        return;
      case "exit":
      case "quit":
        return void shutdown();
      case "clear":
        clearTranscript();
        return;
      case "compact":
        return void compact(args.join(" "));
      case "reload":
        return void reload();
      case "drop":
        return void drop();
      case "mode": {
        const m = args[0];
        if (m === "plan" || m === "edit") {
          mode = m;
          setStatus(); // badge is the indicator
        } else addPlain("usage: /mode plan|edit", () => MUTE);
        return;
      }
      case "model": {
        const id = args[0];
        if (!id) {
          addPlain(`models: ${models.map((m) => m.id).join(", ")}`, () => MUTE);
          return;
        }
        try {
          active = selectModel(models, id);
          provider = providerFor(active);
          setStatus(); // the model id (status bar + session panel) is the indicator
          void refreshBalance();
        } catch (e) {
          addPlain(`✗ ${e instanceof Error ? e.message : String(e)}`, () => RED);
        }
        return;
      }
      case "balance":
        await refreshBalance();
        addPlain(`balance: ${formatBalance(balance)}${active.provider === "gemini" ? "  (Gemini has no balance API)" : ""}`, () => MUTE);
        return;
      case "resume":
        return void resumeSession(args[0]);
      case "sessions":
        return void sessionsCommand(args);
      default: {
        // D16: a markdown command file → expand its body and submit it as a prompt.
        const cmd = commands.find((c) => c.name === name);
        if (cmd) return void submit(expandCommand(cmd.body, args));
        // D12: a skill → load its SKILL.md on demand and invoke its instructions.
        const skill = skills.find((s) => s.name === name);
        if (skill) return void invokeSkill(skill, args);
        addPlain(`unknown command: /${name} (try /help)`, () => MUTE);
      }
    }
  }

  async function submit(value: string): Promise<void> {
    const text = value.trim();
    input.value = "";
    clearSuggest();
    if (!text || busy) return;
    if (text.startsWith("!")) return void runShell(text.slice(1));
    if (text.startsWith("/")) return void runCommand(text);
    await sendPrompt(text, () => t`${bold(fg(GREEN)("❯"))} ${text}`);
  }

  // Send a prompt to the agent: echo a transcript line, persist the (possibly longer) model text, run a turn.
  async function sendPrompt(modelText: string, echo: () => Content): Promise<void> {
    if (busy) return;
    busy = true;
    setStatus();
    spacer();
    addText(echo);
    session.addUser(modelText);
    await runAgentTurn();
    void titleSession(); // D26: name the session from its first exchange (no-op once titled)
    busy = false;
    setStatus();
    drainRetheme(); // apply a theme change that arrived mid-turn (D30)
    input.focus();
  }

  // D12: invoke a skill — load its SKILL.md body lazily (progressive disclosure), expand args like a
  // command, and run it. The model gets the full instructions; the transcript shows a compact `/<skill>`.
  async function invokeSkill(skill: Skill, args: string[]): Promise<void> {
    let body: string;
    try {
      body = await loadSkillBody(skill.path);
    } catch (e) {
      return void addPlain(`✗ couldn't load skill "${skill.name}": ${e instanceof Error ? e.message : String(e)}`, () => RED);
    }
    if (!body) return void addPlain(`✗ skill "${skill.name}" is empty`, () => RED);
    await sendPrompt(expandCommand(body, args), () => t`${bold(fg(GREEN)("❯"))} ${fg(MUTE)(`/${skill.name}`)} ${fg(DIM)("(skill)")}`);
  }

  // One agent turn: stream → tools → post-edit hooks → (D24) hand failing checks back so the agent
  // triages + fixes. `prevIssues` is the prior turn's issue summary — if unchanged after an edit, the
  // agent's stuck, so we stop (no hardcoded retry cap; the agent's choice to stop editing ends it).
  async function runAgentTurn(prevIssues?: string): Promise<void> {
    let reasoningLine: TextRenderable | null = null;
    let answer = addMarkdown();
    // D24: inject the active language packs' skills into the system prompt (cached); track this turn's edits.
    const packs = activePacks(langTouched);
    const key = packs.map((p) => p.id).join(",");
    if (packs.length && key !== langSkillKey) {
      langSkillText = await langSkills(packs);
      langSkillKey = key;
    }
    const sys = [system, await defaultSkills(), packs.length ? langSkillText : ""].filter(Boolean).join("\n\n");
    const edited = new Set<string>();
    const ac = new AbortController();
    turnAbort = ac;
    try {
      await loop({
        provider,
        session,
        model: active.id,
        mode,
        ctx: { cwd, ask, lsp: opts.lsp, touched: langTouched, edited, setTodos, signal: ac.signal, onSubagent },
        interceptors: [
          ic.secretRedaction(),
          ic.reasoningRouter((d) => {
            reasoningLine ??= addPlain("✻ ", () => DIM, TextAttributes.ITALIC);
            reasoningLine.content += d;
          }),
          ic.tokenTap(session),
        ],
        signal: ac.signal,
        system: sys,
        tools,
        thinking: active.thinking ?? false,
        temperature: active.temperature,
        fallbacks: fallbacksFor(models, active), // D15: rate-limited model falls down the ladder
        onEvent: (ev) => {
          if (ev.type === "text") answer.content += ev.delta;
          else if (ev.type === "usage") {
            meter.record({ input: ev.input, output: ev.output }, active.pricing);
            setStatus();
          }
        },
        onToolStart: (name, id) => {
          toolCalls.push({ id, name, status: "running" }); // sidebar tools panel: in-flight ●
          renderSidebar();
        },
        onToolResult: (name, result, id) => {
          const tc = toolCalls.find((c) => c.id === id); // match by id — read-only calls finish out of order
          if (tc) tc.status = /^(Error|Refused)/.test(result) ? "err" : "ok"; // ✓ / ✗
          renderSidebar();
          if (name === "todo") return; // shown in the pinned todo panel, not as a transcript line
          addText(() => t`${fg(DIM)("⎿")} ${fg(MUTE)(name)}  ${fg(DIM)(firstLine(result))}`);
        },
        onRetry: ({ delayMs, model }) => {
          removeLine(answer); // drop the failed (usually empty) attempt
          reasoningLine = null;
          addText(() => t`${fg(YELLOW)("↻")} ${fg(MUTE)(`retrying on ${model}${delayMs ? ` in ${Math.round(delayMs / 1000)}s` : ""}…`)}`);
          answer = addMarkdown(); // fresh block for the retried attempt
        },
        onError: (e) => addPlain(`✗ ${e instanceof Error ? e.message : String(e)}`, () => RED),
      });
    } catch (e) {
      addPlain(`✗ ${e instanceof Error ? e.message : String(e)}`, () => RED);
    } finally {
      answer.streaming = false;
      turnAbort = null;
      for (const f of edited) sessionEdited.add(f); // sidebar: these files were written/edited this session
      renderSidebar(); // refresh the files panel (langTouched grew during the turn)
    }
    if (ac.signal.aborted) return; // user hit ESC — skip hooks + auto-fix

    // D24 post-edit hooks: fix + check the files edited this turn (EDIT only). Files were just written,
    // so this is the safe time to reformat (next turn re-reads / hashline re-anchors).
    if (mode !== "edit" || edited.size === 0) return;
    const summaries: string[] = [];
    let issues = false;
    for (const pack of activePacks(edited)) {
      const files = [...edited].filter((f) => langForFile(f) === pack);
      const note = addText(() => t`${fg(DIM)("⚙")} ${fg(MUTE)(`post-edit (${pack.id})…`)}`);
      const res = await runHooks(pack, files, cwd);
      if (res.summary) setText(note, () => t`${fg(MUTE)(res.summary)}`);
      if (res.summary) summaries.push(res.summary);
      issues ||= res.issues;
    }
    if (!issues) return;
    const issueSummary = summaries.join("\n\n");
    if (issueSummary === prevIssues) {
      addText(() => t`${fg(YELLOW)("⚠")} ${fg(MUTE)("post-edit issues unchanged after a fix attempt — leaving them for you")}`);
      return;
    }
    // Hand the failing checks back; the agent triages (fix critical/quick, defer non-critical).
    session.addUser(triagePrompt(summaries));
    addText(() => t`${fg(YELLOW)("↪")} ${fg(MUTE)("post-edit checks failed — agent triaging…")}`);
    await runAgentTurn(issueSummary);
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    turnAbort?.abort();
    themeMonitor?.kill(); // stop following the system theme (D30)
    await session.close();
    await opts.lsp?.stop();
    renderer.destroy();
    process.exit(0);
  }

  // --- events ---------------------------------------------------------------
  input.on(InputRenderableEvents.INPUT, (value: string) => {
    if (echoGuard !== null && value === echoGuard) {
      echoGuard = null;
      return;
    }
    echoGuard = null;
    void updateSuggestions(value);
  });
  input.on(InputRenderableEvents.ENTER, (value: string) => {
    if (asking) return;
    if (suggestOpen()) {
      const it = suggest.items[suggest.sel];
      // Slash popup → run the highlighted command (no Tab needed). e.g. `/ex`↵ → /exit.
      if (it && suggest.kind === "slash") return void submit(`/${it.insert}`);
      // @-popup → accept the highlighted path. A directory drills in (don't send); a file sends.
      if (it && suggest.kind === "at") {
        const next = applyAtSuggestion(input.value, it.insert);
        if (it.insert.endsWith("/")) {
          echoGuard = next;
          input.value = next;
          void updateSuggestions(next);
          return;
        }
        return void submit(next);
      }
    }
    void submit(value);
  });

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.shift && key.name === "c") return; // Ctrl+Shift+C = copy (terminal) — never our quit
    if (key.ctrl && key.name === "c") return void shutdown();
    if (key.ctrl && key.name === "r") return void reload(); // D7 hot-swap
    if (key.ctrl && key.name === "b") {
      sidebarOn = !sidebarOn;
      applySidebar(); // the panel appearing/disappearing is the indicator — no transcript log
      return;
    }

    if (asking) {
      if (key.name === "up") {
        asking.sel = Math.max(0, asking.sel - 1);
        renderAsk();
      } else if (key.name === "down") {
        asking.sel = Math.min(asking.req.options.length - 1, asking.sel + 1);
        renderAsk();
      } else if (key.name === "return") {
        const a = asking;
        asking = null;
        setPopup([]);
        a.resolve(a.req.options[a.sel]!.label);
      }
      return;
    }

    if (key.shift && key.name === "tab") return void toggleMode(); // Shift+Tab toggles mode (even over a popup)
    if (suggestOpen()) {
      if (key.name === "up") {
        suggest.sel = Math.max(0, suggest.sel - 1);
        renderSuggest();
        return;
      }
      if (key.name === "down") {
        suggest.sel = Math.min(suggest.items.length - 1, suggest.sel + 1);
        renderSuggest();
        return;
      }
      if (key.name === "tab") {
        acceptSuggestion();
        return;
      }
      if (key.name === "escape") {
        clearSuggest();
        return;
      }
    }
    if (key.name === "tab") return void toggleMode(); // plain Tab with no popup also toggles the mode
    if (key.name === "escape") turnAbort?.abort();
  });

  if (session.title) transcriptBox.title = ` ◆ ${session.title} `; // resumed session keeps its title
  addText(() => t`${fg(ACCENT)("✦")} ${fg(MUTE)("welcome to nerve")} ${fg(DIM)("· /help for commands")}`);
  applySidebar(); // size sidebar + status bar to the terminal width, and render their content (calls setStatus)
  watchSystemTheme(); // D30: live-follow GNOME light/dark
  void refreshBalance();
}

function firstLine(s: string): string {
  const l = s.split("\n")[0] ?? "";
  return l.length > 120 ? `${l.slice(0, 117)}…` : l;
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function rel(ms: number): string {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
