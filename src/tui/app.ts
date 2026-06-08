// The interactive terminal UI (OpenTUI imperative core). Responsive layout (D29): a flex *row* — a main
// column (bordered markdown transcript, todo panel, autosuggest/ask popup, bordered input, status bar:
// model · mode · cost · context · balance) plus a collapsible sidebar (session + files panels). The
// sidebar toggles on Ctrl+B and auto-hides on narrow terminals. Affordances: @file, !shell, /command +
// an interactive ask_user picker. See docs/manual/tui.md; OpenTUI API via manual("opentui").
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
  defaultTextareaKeyBindings,
  MarkdownRenderable,
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
import { providerFor, fallbacksFor, type ModelEntry } from "../config.ts";
import { UsageMeter, formatCost, formatContext, formatModelStatus } from "../usage.ts";
import { fetchBalance, formatBalance, type Balance } from "../balance.ts";
import { parseAffordance, atSuggestions, slashSuggestions, parseSlash, applyAtSuggestion, loadSkillBody, pasteToken, expandPastes, dropBrokenPaste, toolArgSummary, type CommandInfo, type Skill } from "./affordances.ts";
import { expandCommand, type Command } from "../commands.ts";
import { pickCutPoint, pruneToolOutputs, summarize } from "../compaction.ts";
import { activePacks, activeSkillNames, defaultSkills, langForFile, langSkills, runHooks, triagePrompt } from "../langpack.ts";
import { nestedMemory } from "../context.ts";
import { diffRows, diffStat } from "../diff.ts";
import { gitBranch, gitStatus, gitGraph, type GitStatus, type GraphRow } from "../git.ts";
import { listSessions, lastSessionId, sessionExists, deleteSession } from "../sessions.ts";
import { pickTheme, buildSyntaxStyle } from "./theme.ts";
import { firstLine, trunc, rel, displayPath, shortenPath } from "./format.ts";
import { herdrReport } from "../herdr.ts";
import { createSidebar, SIDEBAR_MIN } from "./sidebar.ts";
import { PLAN_NOTE, type Mode } from "../dispatch.ts";
import type { Message, Provider } from "../providers/types.ts";
import type { AskRequest, Todo, SubagentEvent } from "../tools/types.ts";
import type { Lsp } from "../lsp/manager.ts";
import { Session } from "../session.ts";

// Palette (D30) — the GNOME light/dark scheme's Adwaita colours, kept as one mutable object (not loose
// consts) so a live light/dark flip can Object.assign new values in place and every reader — app.ts and
// the extracted panel modules alike — sees them with no re-wiring. Read off the object (theme dot a name).
// The colour → SyntaxStyle mapping lives in theme.ts now (rebuilt on a flip so old markdown re-colours).
const theme = pickTheme();
let syntaxStyle = buildSyntaxStyle(theme);

type Content = string | ReturnType<typeof t>;

export interface TuiOptions {
  models: ModelEntry[];
  entry: ModelEntry;
  provider: Provider;
  session: Session;
  mode: Mode;
  cwd: string;
  system: string;
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
  // Hand the mouse + keyboard back to the terminal: no mouse capture (native selection + right-click
  // menu) and no Kitty keyboard protocol (so the terminal's own Ctrl+Shift+C/V copy-paste keep working
  // instead of being grabbed by the app). Trade-off: Shift+Enter isn't distinguishable from Enter without
  // Kitty, so the multi-line newline is Alt+Enter; and transcript scroll is by keyboard (Ctrl+↑/↓).
  // Mouse capture stays off for good: the side panels break rectangular selection, so capturing the wheel
  // would cost native select + right-click copy for a scroll the keyboard already covers — a bad trade.
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, useMouse: false, useKittyKeyboard: null });
  renderer.setBackgroundColor(theme.DARKFG);
  const { models, cwd, system, skills, commands, compactionPrompt, titlePrompt } = opts;
  const slashExtra: CommandInfo[] = [...skills, ...commands]; // file commands + skills join the `/` popup
  // Hot-swappable leaf seam (D7): interceptor factories — /reload re-imports them. Tool specs are read
  // fresh from the discovered registry each turn via toolSpecs(mode === "plan"), so there's no cache to refresh.
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
  let aborting = false; // ESC pressed during a turn — show "stopping…" until the turn actually ends
  const steerQueue: string[] = []; // D46: messages typed mid-turn — injected as user turns between turns (steering)
  let turnAbort: AbortController | null = null;
  let lineId = 0;
  let echoGuard: string | null = null;
  let prevInput = ""; // last input text — diffed in onContentChange to make paste tokens atomic on delete (#3)
  let bottomView: "files" | "git" = "files"; // D49: which panel fills the bottom sidebar slot — Ctrl+G toggles
  let gitData: { branch: string | null; status: GitStatus | null; graph: GraphRow[] } = { branch: null, status: null, graph: [] };
  // Long/multi-line pastes collapse to a "[Pasted N lines #id]" token at the cursor (so they don't flood
  // the box). Each paste is stashed under a unique id and substituted back **by id** on send. Deleting any
  // character of a token removes the WHOLE token (atomic — `dropBrokenPaste` in onContentChange), so it's
  // never left half-edited; tokens are independent (#1 cursor, #3 delete/undo).
  const pastes = new Map<number, string>();
  let pasteSeq = 0;
  let pendingRetheme = false; // a system light/dark change arrived mid-turn — apply it once idle (D30)
  let themeMonitor: ReturnType<typeof Bun.spawn> | null = null;

  let suggest: { kind: "at" | "slash" | "none"; items: Suggestion[]; sel: number } = { kind: "none", items: [], sel: 0 };
  let asking: { req: AskRequest; sel: number; resolve: (answer: string) => void } | null = null;
  // A reusable interactive command picker (e.g. /sessions, /model): a popup list with ↑/↓ + Enter, and an
  // optional `d`-to-delete action per row. Replaces typing `/command <param>` with a selection.
  interface PickerItem {
    label: string;
    desc?: string;
    current?: boolean;
  }
  let picker: { title: string; items: PickerItem[]; sel: number; onPick: (i: number) => void; onDelete?: (i: number) => void } | null = null;

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
    borderColor: theme.ACCENT, // the title (session name / "nerve") is drawn in the border colour — make it pop
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
    borderColor: theme.BORDER,
    flexDirection: "row",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const prompt = new TextRenderable(renderer, { id: "prompt", content: "❯ ", fg: theme.ACCENT, attributes: TextAttributes.BOLD });
  // Multi-line message box (#3): a Textarea (Enter sends, Alt+Enter inserts a newline — Shift+Enter needs
  // the Kitty protocol we turned off), growing 1→8 rows with content. No `value` accessor like the old
  // Input — read with `.plainText`, replace with `.setText`. Autosuggest + submit are wired via the
  // onContentChange / onSubmit callbacks (so the old input.on INPUT/ENTER handlers are gone).
  const input = new TextareaRenderable(renderer, {
    id: "input",
    flexGrow: 1,
    minHeight: 1,
    maxHeight: 8,
    wrapMode: "word",
    placeholder: "Message · @file · !shell · /command · Alt+Enter newline",
    textColor: theme.FG,
    cursorColor: theme.ACCENT,
    // Drop the default Enter→newline; Enter (send) and Alt+Enter (newline) are handled in the global
    // keypress handler, which definitely fires — so sending never depends on the Textarea's own binding.
    keyBindings: defaultTextareaKeyBindings.filter((b) => b.action !== "newline" || b.ctrl || b.shift || b.meta),
    onContentChange: () => {
      const cur = input.plainText;
      if (echoGuard !== null && cur === echoGuard) {
        echoGuard = null;
        prevInput = cur;
        return;
      }
      echoGuard = null;
      // #3: one backspace inside a "[Pasted N lines #id]" token removes the WHOLE token (atomic), not a char.
      if (pastes.size) {
        const dropped = dropBrokenPaste(prevInput, cur);
        if (dropped) {
          pastes.delete(dropped.id);
          prevInput = dropped.text;
          echoGuard = dropped.text; // guard the echo from the setText below
          input.setText(dropped.text);
          void updateSuggestions(dropped.text);
          return;
        }
      }
      prevInput = cur;
      void updateSuggestions(cur);
    },
  });
  inputBox.add(prompt);
  inputBox.add(input);

  const status = new TextRenderable(renderer, { id: "status", height: 1, flexShrink: 0, content: "", bg: theme.PANEL });

  // The responsive sidebar (populated in the sidebar block below); created here so it joins the row.
  const sidebar = createSidebar(renderer, theme); // the right-hand dashboard (./sidebar.ts); app.ts feeds it state
  mainCol.add(transcriptBox);
  mainCol.add(todoBox);
  mainCol.add(popup);
  mainCol.add(inputBox);
  mainCol.add(status);
  root.add(mainCol);
  root.add(sidebar.box);
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
  let todoVisible = false; // the full list is hidden by default (Ctrl+T toggles); the sidebar shows a 1-line summary
  // Render the pinned full-list panel below the transcript — only when toggled on (else height 0).
  const renderTodoPanel = (): void => {
    const rows: Content[] = [];
    if (todoVisible) {
      const shown = currentTodos.slice(0, MAX_TODO_ROWS - 1);
      const done = currentTodos.filter((td) => td.status === "completed").length;
      const extra = currentTodos.length > shown.length ? `  +${currentTodos.length - shown.length}` : "";
      rows.push(t`${bold(fg(theme.ACCENT)("☑ todos"))} ${fg(theme.MUTE)(currentTodos.length ? `· ${done}/${currentTodos.length}${extra}` : "· (none yet)")}`);
      for (const td of shown) {
        if (td.status === "completed") rows.push(t`${fg(theme.GREEN)(" ✓")} ${fg(theme.DIM)(td.content)}`);
        else if (td.status === "in_progress") rows.push(t`${fg(theme.YELLOW)(" ▸")} ${bold(fg(theme.WHITE)(td.content))}`);
        else rows.push(t`${fg(theme.MUTE)(" ○")} ${fg(theme.MUTE)(td.content)}`);
      }
    }
    for (let i = 0; i < todoRows.length; i++) {
      const tr = todoRows[i]!;
      tr.content = i < rows.length ? rows[i]! : "";
      tr.height = i < rows.length ? 1 : 0;
    }
    todoBox.height = rows.length;
  };
  const setTodos = (todos: Todo[]): void => {
    currentTodos = todos;
    renderTodoPanel(); // the full overlay panel (respects todoVisible)
    renderSidebar(); // membership-aware: shows/hides the sidebar todos panel + refreshes its 1-line summary
  };
  const toggleTodos = (): void => {
    todoVisible = !todoVisible;
    renderTodoPanel();
  };

  // --- responsive sidebar (D29): a dashboard of live panels (built in ./sidebar.ts). app.ts owns the
  // session state and gathers it into a SidebarState per render; Ctrl+B toggles, narrow terminals auto-hide.
  let sidebarOn = true;
  const sessionEdited = new Set<string>(); // files written/edited this session → ✎ in the files panel
  // Tools + subagents are TRANSIENT, not a session-long log: reset at the start of each exchange (a new turn
  // replaces the last turn's activity) and auto-hidden a while after the turn ends (`transientTimer`), so the
  // panels show "what's happening now", not an ever-growing list. Empty → the panel drops out of the sidebar.
  const subagents: { id: string; prompt: string; status: "running" | "done" | "failed" }[] = []; // `task` runs this exchange
  const toolCalls: { id: string; name: string; status: "running" | "ok" | "err" }[] = []; // main-agent tool calls this exchange
  let transientTimer: ReturnType<typeof setTimeout> | null = null;
  const TRANSIENT_MS = 60_000; // how long tools/subagents linger after a turn before they auto-hide
  const clearTransient = (): void => {
    if (transientTimer) clearTimeout(transientTimer);
    transientTimer = null;
  };
  // The working indicator: a static `●` bullet + label, shown in the session panel + status bar while busy
  // (task 2). It used to be an animated braille spinner re-rendered every ~90ms, but that repaint *lagged*
  // visibly when the sidebar was hidden (the wider status bar repaints). The label still flips to red
  // "stopping…" the instant ESC registers, and the indicator vanishes when the turn ends.
  const activityChunk = (pad = false) =>
    fg(aborting ? theme.RED : theme.YELLOW)(`${pad ? "   " : ""}● ${aborting ? "stopping…" : "working"}`);
  // Gather app.ts's live state into a snapshot and hand it to the sidebar module (./sidebar.ts) to paint.
  function renderSidebar(): void {
    const s = meter.snapshot();
    sidebar.render({
      model: active.id,
      contextWindow: active.contextWindow,
      mode,
      balance,
      usage: { costUsd: s.costUsd, contextTokens: s.contextTokens },
      busy,
      activity: busy ? t`${activityChunk()}` : "",
      skills: activeSkillNames(langTouched),
      lspServers: opts.lsp?.serverStatus() ?? [],
      tools: toolCalls,
      subagents,
      files: [...langTouched].reverse(),
      sessionEdited,
      cwd,
      branch: gitData.branch ?? undefined,
      gitDirty: gitData.status?.dirty,
      ahead: gitData.status?.ahead,
      behind: gitData.status?.behind,
      gitGraph: gitData.graph,
      bottomView,
      todos: currentTodos,
      termHeight: renderer.height,
    });
  }
  // D49: refresh cached git data — branch + status always (cheap), branches/log only when the git view is
  // shown (subprocesses). Called at startup, on Ctrl+G, and after anything that can change git state — every
  // turn, the `!`-shell escape, and each `bash`/`edit`/`write` tool result (so commits + working-tree changes
  // show live, not only at turn end). Coalesced: a burst of edits collapses to the in-flight run + one trailing
  // run, so we never spawn N `git status` subprocesses at once (also avoids out-of-order `gitData` writes).
  let gitRefreshing = false;
  let gitRefreshAgain = false;
  async function refreshGit(): Promise<void> {
    if (gitRefreshing) {
      gitRefreshAgain = true; // a refresh is already running — fold this request into one trailing run
      return;
    }
    gitRefreshing = true;
    try {
      const branch = gitBranch(cwd);
      const status = await gitStatus(cwd);
      const graph = bottomView === "git" ? await gitGraph(cwd, 24) : gitData.graph; // graph only while the view is open
      gitData = { branch, status, graph };
      renderSidebar();
    } finally {
      gitRefreshing = false;
      if (gitRefreshAgain) {
        gitRefreshAgain = false;
        void refreshGit(); // coalesced trailing refresh — picks up whatever changed while we were busy
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
    sidebar.setVisible(visible);
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
    const el = new TextRenderable(renderer, { id: `ln-${lineId++}`, content: make(), fg: theme.FG });
    transcript.add(el);
    lines.push({ kind: "text", el, make });
    return el;
  };
  // Plain-text line tinted by one role colour (recoloured via `fg`); supports `.content +=` growth.
  const addPlain = (text: string, role: () => string = () => theme.FG, attributes = 0): TextRenderable => {
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
  // Stop a (possibly-null) prose block's streaming cursor. A free helper so the call site isn't subject to
  // TS narrowing `answer` to `null` — it can't see the closures that mutate `answer` during the turn.
  const sealBlock = (m: MarkdownRenderable | null): void => void (m && (m.streaming = false));
  const spacer = (): void => void addText(() => "");
  // A faint full-width divider between turns. Width is recomputed per render (theme change / next paint).
  const rule = (): void => void addText(() => t`${fg(theme.DIM)("─".repeat(Math.max(4, (transcriptBox.width || renderer.width) - 4)))}`);
  // Consistent, color-coded system lines: info (· dim), ok (✦ magenta), warn (⚠ yellow), err (✗ red).
  const sysInfo = (msg: string): void => void addText(() => t`${fg(theme.DIM)("·")} ${fg(theme.MUTE)(msg)}`);
  const sysOk = (msg: string): void => void addText(() => t`${fg(theme.MAGENTA)("✦")} ${fg(theme.MUTE)(msg)}`);
  const sysWarn = (msg: string): void => void addText(() => t`${fg(theme.YELLOW)("⚠")} ${fg(theme.MUTE)(msg)}`);
  const sysErr = (msg: string): void => void addText(() => t`${fg(theme.RED)("✗")} ${fg(theme.RED)(msg)}`);
  const welcome = (): void => void addText(() => t`${fg(theme.ACCENT)("✦")} ${fg(theme.MUTE)("welcome to nerve")} ${fg(theme.DIM)("· /help for commands")}`);
  const clearTranscript = (): void => {
    for (const l of lines) transcript.remove(l.el.id);
    lines.length = 0;
  };
  // Re-theme the whole UI in place after a live light/dark switch (D30). Idle-only (deferred while busy).
  const retheme = (): void => {
    Object.assign(theme, pickTheme());
    syntaxStyle = buildSyntaxStyle(theme);
    renderer.setBackgroundColor(theme.DARKFG);
    transcriptBox.borderColor = theme.ACCENT; // titled panels keep their accent border (the title rides on it)
    inputBox.borderColor = theme.BORDER;
    sidebar.retheme(); // recolor the sidebar's panel borders
    status.bg = theme.PANEL;
    prompt.fg = theme.ACCENT;
    input.textColor = theme.FG;
    input.cursorColor = theme.ACCENT;
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
          if (pickTheme().DARKFG !== theme.DARKFG) requestRetheme(); // ground actually flipped
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
        addText(() => t`${bold(fg(theme.GREEN)("❯"))} ${m.content}`);
      } else if (m.role === "assistant") {
        if (m.content) {
          const md = addMarkdown();
          md.content = m.content;
          md.streaming = false;
        }
        for (const tc of m.toolCalls ?? []) addText(() => t`${fg(theme.DIM)("⎿")} ${fg(theme.MUTE)(tc.name)}`);
      } else if (m.role === "tool") {
        addText(() => t`${fg(theme.DIM)("⎿")} ${fg(theme.DIM)(firstLine(m.content))}`);
      }
    }
  };

  // --- popup (autosuggest + ask picker, with row highlight) -----------------
  // A fixed pool of row renderables we UPDATE in place (never recreate) — recreating with reused ids
  // left stale cells that bled old content through new rows. Inactive rows are height 0.
  const MAX_POPUP = 12;
  const popupRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_POPUP; i++) {
    const tr = new TextRenderable(renderer, { id: `pop-${i}`, content: "", height: 0, fg: theme.MUTE });
    popup.add(tr);
    popupRows.push(tr);
  }
  const setPopup = (rows: PopupRow[]): void => {
    const n = Math.min(rows.length, MAX_POPUP);
    for (let i = 0; i < MAX_POPUP; i++) {
      const tr = popupRows[i]!;
      const row = i < n ? rows[i]! : null;
      tr.content = row ? row.content : "";
      tr.fg = row ? row.fg : theme.MUTE;
      tr.bg = row?.bg ?? "transparent";
      tr.attributes = row?.bold ? TextAttributes.BOLD : 0;
      tr.height = row ? 1 : 0;
    }
    popup.height = n;
  };
  const suggestOpen = (): boolean => suggest.items.length > 0;
  const clearSuggest = (): void => {
    suggest = { kind: "none", items: [], sel: 0 };
    if (!asking && !picker) setPopup([]);
  };
  const renderSuggest = (): void => {
    if (asking || picker) return;
    // dynamic columns: name column fits the longest name; description fills the rest of the width
    const colW = Math.max(0, ...suggest.items.map((it) => it.name.length)) + 2;
    const budget = Math.max(10, renderer.width - colW - 6);
    setPopup(
      suggest.items.map((it, i) => ({
        content: it.desc ? `${it.name.padEnd(colW)}${trunc(it.desc, budget)}` : it.name,
        fg: i === suggest.sel ? theme.WHITE : theme.MUTE,
        bg: i === suggest.sel ? theme.SELBG : undefined,
        bold: i === suggest.sel,
      })),
    );
  };
  async function updateSuggestions(value: string): Promise<void> {
    if (asking || picker) return;
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
    const next = suggest.kind === "at" ? applyAtSuggestion(input.plainText, it.insert) : `/${it.insert} `;
    echoGuard = next;
    input.setText(next);
    clearSuggest();
  }

  const renderAsk = (): void => {
    if (!asking) return;
    const rows: PopupRow[] = [{ content: `? ${asking.req.question}`, fg: theme.ACCENT, bold: true }];
    asking.req.options.forEach((o, i) => {
      const sel = i === asking!.sel;
      rows.push({ content: `${o.label}${o.recommended ? "   (recommended)" : ""}${o.description ? `   ${trunc(o.description, Math.max(20, renderer.width - 28))}` : ""}`, fg: sel ? theme.WHITE : theme.MUTE, bg: sel ? theme.SELBG : undefined, bold: sel });
    });
    setPopup(rows);
  };
  function ask(req: AskRequest): Promise<string> {
    return new Promise((resolve) => {
      const rec = req.options.findIndex((o) => o.recommended);
      asking = { req, sel: rec >= 0 ? rec : 0, resolve };
      herdrReport("blocked"); // herdr telemetry: waiting on the human (ask_user picker)
      renderAsk();
    });
  }

  const renderPicker = (): void => {
    if (!picker) return;
    const rows: PopupRow[] = [{ content: picker.title, fg: theme.ACCENT, bold: true }];
    picker.items.forEach((it, i) => {
      const sel = i === picker!.sel;
      const label = `${it.current ? "● " : "  "}${it.label}`;
      const desc = it.desc ? `   ${trunc(it.desc, Math.max(16, renderer.width - label.length - 14))}` : "";
      rows.push({ content: `${label}${desc}`, fg: sel ? theme.WHITE : it.current ? theme.GREEN : theme.MUTE, bg: sel ? theme.SELBG : undefined, bold: sel });
    });
    setPopup(rows);
  };
  function openPicker(p: { title: string; items: PickerItem[]; onPick: (i: number) => void; onDelete?: (i: number) => void }): void {
    if (!p.items.length) return;
    suggest = { kind: "none", items: [], sel: 0 };
    picker = { ...p, sel: Math.max(0, p.items.findIndex((it) => it.current)) };
    renderPicker();
  }
  function closePicker(): void {
    picker = null;
    setPopup([]);
  }

  // --- status ---------------------------------------------------------------
  const setStatus = (): void => {
    const s = meter.snapshot();
    const badge = mode === "edit" ? bg(theme.GREEN)(fg(theme.DARKFG)(" EDIT ")) : bg(theme.YELLOW)(fg(theme.DARKFG)(" PLAN "));
    // cwd + git branch live in the sidebar's session panel; the status bar (under the input box) is the only
    // place they'd show when the sidebar is hidden, so mirror them here (task 3) — rendered **identically** to
    // the sidebar's branch row: cwd in FG, then `⎇ branch · ●dirty/✓clean · ↑ahead ↓behind`. Flat chunks only
    // (a nested `t` renders as "[object Object]"), so each piece is its own conditional interpolation.
    const ahead = gitData.status?.ahead, behind = gitData.status?.behind;
    const arrow = gitData.branch ? fg(theme.MAGENTA)("⎇") : "";
    const branch = gitData.branch ? fg(theme.FG)(` ${gitData.branch}`) : "";
    const dirty = gitData.branch ? (gitData.status?.dirty ? fg(theme.YELLOW)(` ●${gitData.status.dirty}`) : fg(theme.GREEN)(" ✓")) : "";
    const ab = gitData.branch && (ahead || behind) ? fg(theme.MUTE)(`${ahead ? ` ↑${ahead}` : ""}${behind ? ` ↓${behind}` : ""}`) : ""; // matches sidebar `aheadBehind`
    status.content = t` ${fg(theme.FG)(shortenPath(cwd))} ${arrow}${branch}${dirty}${ab}  ${fg(theme.DIM)("│")}  ${fg(theme.ACCENT)(active.id)}  ${badge}  ${fg(theme.MUTE)("cost")} ${fg(theme.FG)(formatCost(s.costUsd))}  ${fg(theme.MUTE)("ctx")} ${fg(theme.FG)(formatContext(s.contextTokens, active.contextWindow))}  ${fg(theme.MUTE)("bal")} ${fg(theme.GREEN)(formatBalance(balance))}${steerQueue.length ? fg(theme.YELLOW)(`  ↳${steerQueue.length} queued`) : ""}${busy ? activityChunk(true) : ""}`;
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
    addText(() => t`${bold(fg(theme.YELLOW)("$"))} ${c}`);
    try {
      addPlain(await bash.run({ command: c }, { cwd }), () => theme.MUTE); // full authority, ungated, not added to the session
    } catch (e) {
      sysErr(e instanceof Error ? e.message : String(e));
    }
    void refreshGit(); // a `!git commit`/`checkout`/… just ran — reflect it in the git UI
  }

  // D17: summarize old turns into one message to reclaim context. Manual for now; ESC cancels.
  const KEEP_TOKENS = 20_000;
  async function compact(): Promise<void> {
    if (busy) return;
    const cut = pickCutPoint(session.messages, KEEP_TOKENS);
    if (cut < 2) {
      sysInfo("nothing old enough to compact yet");
      return;
    }
    aborting = false;
    busy = true;
    setStatus();
    herdrReport("working"); // herdr telemetry: compaction is a working turn
    const note = addText(() => t`${fg(theme.MAGENTA)("✦")} ${fg(theme.MUTE)("compacting…")}`);
    turnAbort = new AbortController();
    try {
      const input = pruneToolOutputs(session.messages.slice(0, cut)).messages; // shrink the summarizer's input
      const keep = session.messages.length - cut;
      const summary = await summarize(provider, active.id, input, compactionPrompt, "", turnAbort.signal);
      session.compact(summary, keep);
      setText(note, () => t`${fg(theme.MAGENTA)("✦")} ${fg(theme.MUTE)(`compacted ${cut} earlier message(s) → summary · ${session.messages.length} now in context`)}`);
    } catch (e) {
      setText(note, () => t`${fg(theme.RED)("✗")} ${fg(theme.MUTE)(`compaction failed: ${e instanceof Error ? e.message : String(e)}`)}`);
    } finally {
      busy = false;
      turnAbort = null;
      setStatus();
      herdrReport("idle"); // herdr telemetry: compaction done
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
    if (rt.ok && !icErr) addText(() => t`${fg(theme.GREEN)("↻")} ${fg(theme.MUTE)(`reloaded ${rt.names.length} tools + interceptors from disk`)}`);
    else sysErr(`reload failed (kept the running set) — ${!rt.ok ? rt.error : icErr}`);
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
    welcome(); // fresh start — back to the welcome line, no session-id chatter
    setStatus();
  }

  // /resume [id] — switch to an existing session (default: the most recent one that isn't this one).
  async function resumeSession(idArg?: string): Promise<void> {
    if (busy) return;
    const id = idArg ?? lastSessionId(cwd, session.id);
    if (!id) return void sysInfo("no other session to resume");
    if (!sessionExists(cwd, id)) return void sysErr("that session no longer exists");
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
    sysOk(`resumed "${session.title || "untitled"}" · ${session.messages.length} message(s) in context`);
    setStatus();
  }

  // /sessions — an interactive picker: ↑/↓ navigate · Enter resume · d delete · Esc close.
  function sessionsCommand(): void {
    const list = listSessions(cwd);
    if (!list.length) return void sysInfo("no sessions yet");
    openPicker({
      title: "sessions · ↑/↓ · Enter resume · d delete · Esc close",
      items: list.map((s) => ({ label: s.title || s.preview || "(untitled)", desc: `${s.msgs} msg · ${rel(s.mtimeMs)}`, current: s.id === session.id })),
      onPick: (i) => {
        const s = list[i]!;
        if (s.id === session.id) return void sysInfo("already on this session");
        void resumeSession(s.id);
      },
      onDelete: (i) => {
        const s = list[i]!;
        if (s.id === session.id) return void sysErr("can't delete the current session — use /drop");
        deleteSession(cwd, s.id);
        closePicker();
        sessionsCommand(); // re-open with the updated list (or show "no sessions yet" if now empty)
      },
    });
  }

  // Color-coded /help: section headers (accent), command names (cyan), keys (yellow), descriptions (muted).
  function renderHelp(): void {
    const sec = (s: string): void => void addText(() => t`${bold(fg(theme.ACCENT)(s))}`);
    const cmd = (name: string, desc: string): void => void addText(() => t`  ${fg(theme.CYAN)(name.padEnd(18))} ${fg(theme.MUTE)(desc)}`);
    const key = (k: string, desc: string): void => void addText(() => t`  ${fg(theme.YELLOW)(k.padEnd(16))} ${fg(theme.MUTE)(desc)}`);
    spacer();
    sec("commands");
    cmd("/help", "this help");
    cmd("/sessions", "browse sessions — ↑/↓ · Enter resume · d delete");
    cmd("/resume", "resume the last session");
    cmd("/models", "switch model (interactive picker)");
    cmd("/mode", "toggle PLAN ↔ EDIT");
    cmd("/compact", "summarize old turns to reclaim context");
    cmd("/clear", "clear the transcript (keep the session)");
    cmd("/reload", "hot-reload tools + interceptors");
    cmd("/git", "swap the sidebar's files ↔ git view (Ctrl+G)");
    cmd("/drop", "delete this session, start a fresh one");
    cmd("/balance", "refresh the provider balance");
    cmd("/quit", "exit nerve");
    spacer();
    sec("input");
    cmd("@path", "reference a file");
    cmd("!cmd", "run a shell command directly (full authority)");
    cmd("/name", "a built-in command or a skill");
    spacer();
    sec("keys");
    key("Enter", "send  ·  Alt+Enter newline");
    key("Tab", "accept suggestion");
    key("Shift+Tab", "toggle PLAN ↔ EDIT");
    key("↑ / ↓", "navigate popups");
    key("Ctrl+↑ / Ctrl+↓", "scroll the transcript (Alt+↑/↓ too)");
    key("Ctrl+B", "toggle sidebar");
    key("Ctrl+T", "toggle the todo list");
    key("Ctrl+G", "swap the sidebar's files ↔ git view");
    key("Ctrl+R", "reload");
    key("ESC", "stop the turn / close a popup");
    key("Ctrl+C", "quit");
    spacer();
    sec("edit  (readline = zsh)");
    key("Ctrl+A / Ctrl+E", "start / end of line");
    key("Ctrl+W", "delete word back");
    key("Ctrl+K / Ctrl+U", "kill to end / start");
    key("Alt+B / Alt+F", "word back / forward");
    spacer();
    sec("copy / paste");
    addText(() => t`  ${fg(theme.MUTE)("selection, Ctrl+Shift+C/V, and right-click are your terminal's")}`);
  }

  async function runCommand(value: string): Promise<void> {
    const { name, args } = parseSlash(value);
    switch (name) {
      case "help":
        renderHelp();
        return;
      case "exit":
      case "quit":
        return void shutdown();
      case "clear":
        clearTranscript();
        return;
      case "compact":
        return void compact();
      case "reload":
        return void reload();
      case "drop":
        return void drop();
      case "mode":
        toggleMode(); // just flip PLAN ↔ EDIT — no need to name the target (badge is the indicator)
        return;
      case "git":
        bottomView = bottomView === "git" ? "files" : "git"; // D49: toggle the git view (same as Ctrl+G)
        void refreshGit();
        return;
      case "models":
        openPicker({
          title: "model · ↑/↓ · Enter select · Esc close",
          items: models.map((m) => ({ label: m.id, desc: m.label, current: m.id === active.id })),
          onPick: (i) => {
            const entry = models[i]!;
            try {
              provider = providerFor(entry); // may throw if the key is missing — leave `active` unchanged then
              active = entry;
              setStatus(); // the model id (status bar + session panel) is the indicator
              void refreshBalance();
            } catch (e) {
              sysErr(e instanceof Error ? e.message : String(e));
            }
          },
        });
        return;
      case "balance":
        await refreshBalance();
        addText(() => t`${fg(theme.MUTE)("balance")}  ${fg(theme.GREEN)(formatBalance(balance))}${active.provider === "gemini" ? fg(theme.DIM)("  (Gemini has no balance API)") : ""}`);
        return;
      case "resume":
        return void resumeSession(); // last session only — pick a specific one from /sessions
      case "sessions":
        return void sessionsCommand();
      default: {
        // D16: a markdown command file → expand its body and submit it as a prompt.
        const cmd = commands.find((c) => c.name === name);
        if (cmd) return void submit(expandCommand(cmd.body, args));
        // D12: a skill → load its SKILL.md on demand and invoke its instructions.
        const skill = skills.find((s) => s.name === name);
        if (skill) return void invokeSkill(skill, args);
        sysErr(`unknown command: /${name} (try /help)`);
      }
    }
  }

  async function submit(value: string): Promise<void> {
    const raw = value.trim();
    input.setText("");
    clearSuggest();
    if (!raw) {
      pastes.clear();
      pasteSeq = 0;
      return;
    }
    const expanded = expandPastes(raw, pastes); // restore any surviving "[Pasted N lines #id]" tokens (also clears the stash)
    pasteSeq = 0;
    if (busy) {
      // Mid-turn (D46): queue a plain prompt as steering — injected as a user turn once the current turn
      // finishes (a redirect without a hard ESC abort). Shell/commands aren't queued (they act now or not).
      if (raw.startsWith("!") || raw.startsWith("/")) return void sysInfo("busy — finish the turn first (ESC aborts)");
      steerQueue.push(expanded);
      setStatus(); // surface "↳N queued" in the status line (no transcript line — would split the live stream)
      return;
    }
    if (raw.startsWith("!")) return void runShell(expanded.slice(1));
    if (raw.startsWith("/")) return void runCommand(raw); // commands run literally (paste tokens pass through)
    await sendPrompt(expanded, () => t`${bold(fg(theme.GREEN)("❯"))} ${raw}`); // echo the compact text, send the full
  }

  // Send a prompt to the agent: echo a transcript line, persist the (possibly longer) model text, run a turn.
  async function sendPrompt(modelText: string, echo: () => Content): Promise<void> {
    if (busy) return;
    // New exchange → drop the previous turn's transient tools/subagents (they show "now", not a session log).
    clearTransient();
    toolCalls.length = 0;
    subagents.length = 0;
    aborting = false; // fresh turn → the indicator reads "working", never a stale "stopping…" (the timer used to reset this)
    busy = true;
    setStatus();
    herdrReport("working"); // herdr telemetry: a turn is now running
    if (lines.length > 1) {
      // not the first turn → a faint divider + breathing room separates this exchange from the last
      spacer();
      rule();
    }
    spacer();
    addText(echo);
    spacer(); // breathing room before the assistant's answer
    session.addUser(modelText);
    await runAgentTurn();
    await drainSteer(); // D46: a redirect typed during the turn preempts auto-continue
    await autoContinue(); // D34: drive an unfinished todo list to completion (bounded), then flag any remainder
    await drainSteer(); // D46: catch a redirect typed during the last auto-continue round
    void titleSession(); // D26: name the session from its first exchange (no-op once titled)
    busy = false;
    setStatus();
    herdrReport("idle"); // herdr telemetry: the exchange is done
    drainRetheme(); // apply a theme change that arrived mid-turn (D30)
    void refreshGit(); // D49: reflect any commit/branch/file changes the turn made
    // Let this turn's tools/subagents linger a moment, then auto-hide them (transient, not a forever log).
    clearTransient();
    transientTimer = setTimeout(() => {
      toolCalls.length = 0;
      subagents.length = 0;
      renderSidebar();
    }, TRANSIENT_MS);
    input.focus();
  }

  // D46: inject messages the user queued mid-turn (steering) as user turns — a redirect without a hard ESC
  // abort. Drains the whole queue (a steer can queue more); each runs a turn. Policy lives here, like D34;
  // the engine `loop` stays pure. ESC clears the queue (see the key handler).
  async function drainSteer(): Promise<void> {
    while (steerQueue.length && !turnAbort?.signal.aborted) {
      const msg = steerQueue.shift()!;
      setStatus(); // clear the queued count as we consume it
      spacer();
      addText(() => t`${bold(fg(theme.YELLOW)("↳"))} ${msg}`); // echo the steer (between turns → no live stream to split)
      spacer();
      session.addUser(msg);
      await runAgentTurn();
    }
  }

  // D34: keep an unfinished todo list moving without a human nudge (nerve runs unattended, D11). A cheap
  // model often ends a turn mid-plan; re-prompt it to continue. Bounded so it can't run away: ≤ MAX rounds,
  // and stop the instant a round finishes no new todo (no progress → it's stuck). ESC breaks out. If work
  // remains when we stop, a dim hint tells the user to nudge it on themselves.
  const MAX_AUTO_CONTINUE = 8;
  async function autoContinue(): Promise<void> {
    for (let round = 0; round < MAX_AUTO_CONTINUE; round++) {
      if (turnAbort?.signal.aborted) return;
      await drainSteer(); // D46: a queued redirect preempts this round's auto-continue nudge
      if (turnAbort?.signal.aborted) return;
      const total = currentTodos.length;
      const doneBefore = currentTodos.filter((td) => td.status === "completed").length;
      if (!total || doneBefore === total) break; // no todo list, or all done — nothing to drive
      session.addUser("Continue — work your remaining todos to completion. Don't stop to check in.");
      sysInfo(`continuing · ${total - doneBefore} todo${total - doneBefore === 1 ? "" : "s"} left`);
      await runAgentTurn();
      if (currentTodos.filter((td) => td.status === "completed").length <= doneBefore) break; // no progress → stuck
    }
    if (turnAbort?.signal.aborted) return;
    const pending = currentTodos.filter((td) => td.status !== "completed").length;
    if (pending) sysInfo(`stopped · ${pending} todo${pending === 1 ? "" : "s"} still pending — send a message to continue`);
  }

  // D12: invoke a skill — load its SKILL.md body lazily (progressive disclosure), expand args like a
  // command, and run it. The model gets the full instructions; the transcript shows a compact `/<skill>`.
  async function invokeSkill(skill: Skill, args: string[]): Promise<void> {
    let body: string;
    try {
      body = await loadSkillBody(skill.path);
    } catch (e) {
      return void sysErr(`couldn't load skill "${skill.name}": ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!body) return void sysErr(`skill "${skill.name}" is empty`);
    await sendPrompt(expandCommand(body, args), () => t`${bold(fg(theme.GREEN)("❯"))} ${fg(theme.MUTE)(`/${skill.name}`)} ${fg(theme.DIM)("(skill)")}`);
  }

  // One agent turn: stream → tools → post-edit hooks → (D24) hand failing checks back so the agent
  // triages + fixes. `prevIssues` is the prior turn's issue summary — if unchanged after an edit, the
  // agent's stuck, so we stop (no hardcoded retry cap; the agent's choice to stop editing ends it).
  async function runAgentTurn(prevIssues?: string): Promise<void> {
    let reasoningLine: TextRenderable | null = null;
    // The assistant's prose is rendered lazily (created on the first text delta) and **sealed when a tool
    // call starts**, so the next step's prose opens a FRESH block *below* the tool-result lines — the
    // transcript interleaves prose → tools → prose → tools chronologically, instead of pooling all prose
    // at the top and all tool lines at the bottom.
    let answer: MarkdownRenderable | null = null;
    const argSummaries = new Map<string, string>(); // tool-call id → its key arg, for the `⎿ name arg` line
    // After a tool block prints, the next prose/reasoning block gets a blank line above it for breathing room.
    // `gapLine` remembers that spacer so a retry (which drops the block) can drop the orphaned gap with it.
    let proseGap = false;
    let gapLine: TextRenderable | null = null;
    const gapIfNeeded = (): void => {
      if (proseGap) gapLine = addText(() => "");
      proseGap = false;
    };
    // D49: render an inline +/- diff of an agent edit (like Claude Code) — display-only; the model still gets
    // the tool's text result, and onToolResult skips the generic line for a successful edit/write.
    const renderEditDiff = (path: string, oldText: string, newText: string): void => {
      const rp = displayPath(path, cwd);
      const { added, removed } = diffStat(oldText, newText);
      // filename header (bold path) + colored +a/-b stat
      addText(
        () =>
          t`${fg(theme.GREEN)("⎿")} ${bold(fg(theme.CYAN)(`✎ ${rp}`))}  ${added ? fg(theme.GREEN)(`+${added}`) : ""}${added && removed ? " " : ""}${removed ? fg(theme.RED)(`-${removed}`) : ""}${!added && !removed ? fg(theme.DIM)("no change") : ""}`,
      );
      const rows = diffRows(oldText, newText);
      const CAP = 80; // don't flood the transcript on a huge edit
      for (const row of rows.slice(0, CAP)) {
        if (row.tag === "⋯") {
          addText(() => t`${fg(theme.DIM)("        ⋯")}`);
          continue;
        }
        // green +, red -, dim context; each line prefixed with its (right-aligned) line number.
        addText(() => {
          const num = fg(theme.DIM)(String(row.n ?? "").padStart(4));
          if (row.tag === "+") return t`${num} ${fg(theme.GREEN)(`+ ${row.text}`)}`;
          if (row.tag === "-") return t`${num} ${fg(theme.RED)(`- ${row.text}`)}`;
          return t`${num} ${fg(theme.MUTE)(`  ${row.text}`)}`;
        });
      }
      if (rows.length > CAP) addText(() => t`${fg(theme.DIM)(`        … ${rows.length - CAP} more lines`)}`);
      proseGap = true;
    };
    // D24: inject the active language packs' skills into the system prompt (cached); track this turn's edits.
    const packs = activePacks(langTouched);
    const key = packs.map((p) => p.id).join(",");
    if (packs.length && key !== langSkillKey) {
      langSkillText = await langSkills(packs);
      langSkillKey = key;
    }
    const sys = [system, nestedMemory(cwd, langTouched), await defaultSkills(), mode === "plan" ? PLAN_NOTE : "", packs.length ? langSkillText : ""].filter(Boolean).join("\n\n");
    const edited = new Set<string>();
    const ac = new AbortController();
    turnAbort = ac;
    try {
      await loop({
        provider,
        session,
        model: active.id,
        mode,
        ctx: { cwd, ask, lsp: opts.lsp, touched: langTouched, edited, setTodos, signal: ac.signal, onSubagent, onFileChange: renderEditDiff, onCost: (usd) => (meter.addCost(usd), setStatus()) },
        interceptors: [
          ic.secretRedaction(),
          ic.reasoningRouter((d) => {
            if (!reasoningLine) {
              gapIfNeeded();
              reasoningLine = addPlain("✻ ", () => theme.DIM, TextAttributes.ITALIC);
            }
            reasoningLine.content += d;
          }),
          ic.tokenTap(session),
        ],
        signal: ac.signal,
        system: sys,
        tools: toolSpecs(mode === "plan"), // D39: PLAN advertises only PLAN-visible tools (read-only + bash)
        status: () => formatModelStatus(meter.snapshot(), active.contextWindow, currentTodos), // D43: ambient tail note
        thinking: active.thinking ?? false,
        temperature: active.temperature,
        fallbacks: fallbacksFor(models, active), // D15: rate-limited model falls down the ladder
        onEvent: (ev) => {
          if (ev.type === "text") {
            if (!answer) {
              gapIfNeeded(); // blank line after a tool block, before this fresh prose
              answer = addMarkdown();
            }
            answer.content += ev.delta;
          } else if (ev.type === "usage") {
            meter.record({ input: ev.input, output: ev.output }, active.pricing);
            setStatus();
          }
        },
        onToolStart: (name, id, args) => {
          // the model finished talking for this step → seal the prose so the next step opens fresh below
          if (answer) {
            answer.streaming = false;
            answer = null;
          }
          reasoningLine = null;
          gapLine = null; // the block + its gap are committed now — a later retry mustn't remove this gap
          argSummaries.set(id, toolArgSummary(name, args)); // remember what this call does, for its line
          toolCalls.push({ id, name, status: "running" }); // sidebar tools panel: in-flight ●
          renderSidebar();
        },
        onToolResult: (name, result, id) => {
          const ok = !/^(Error|Refused)/.test(result);
          const tc = toolCalls.find((c) => c.id === id); // match by id — read-only calls finish out of order
          if (tc) tc.status = ok ? "ok" : "err"; // ✓ / ✗
          renderSidebar();
          // a mutating tool may have changed git state (a `git` commit via bash, or the working tree via
          // edit/write) — refresh the git UI live, not just at turn end (coalesced, so a burst is cheap).
          if (ok && (name === "bash" || name === "edit" || name === "write")) void refreshGit();
          if (name === "todo") return; // shown in the pinned todo panel, not as a transcript line
          if ((name === "edit" || name === "write") && ok) return; // D49: the inline diff (onFileChange) is its visual
          // `⎿ name  <arg>` — name + glyph colored by outcome (cyan/green ok, red error); on failure the
          // error message tails it (the arg alone isn't enough to know what went wrong).
          const arg = argSummaries.get(id) ?? "";
          const tail = ok ? "" : `  ${firstLine(result)}`;
          addText(() => t`${fg(ok ? theme.GREEN : theme.RED)("⎿")} ${fg(ok ? theme.CYAN : theme.RED)(name)}  ${fg(ok ? theme.MUTE : theme.RED)(arg)}${fg(theme.RED)(tail)}`);
          proseGap = true; // a tool just printed → the next prose block gets a blank line above it
        },
        onRetry: ({ delayMs, model }) => {
          if (answer) removeLine(answer); // drop the failed (usually empty) attempt
          if (gapLine) removeLine(gapLine); // …and the blank line that opened above it (no orphan gap)
          answer = null; // the retried attempt opens a fresh block on its first text delta
          gapLine = null;
          reasoningLine = null;
          addText(() => t`${fg(theme.YELLOW)("↻")} ${fg(theme.MUTE)(`retrying on ${model}${delayMs ? ` in ${Math.round(delayMs / 1000)}s` : ""}…`)}`);
        },
        onError: (e) => sysErr(e instanceof Error ? e.message : String(e)),
      });
    } catch (e) {
      sysErr(e instanceof Error ? e.message : String(e));
    } finally {
      sealBlock(answer); // close the final prose block's streaming cursor (if any)
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
      const note = addText(() => t`${fg(theme.DIM)("⚙")} ${fg(theme.MUTE)(`post-edit (${pack.id})…`)}`);
      // surface each hook (ruff format, prettier --write, pyrefly check, …) in the tools panel as it runs
      const res = await runHooks(pack, files, cwd, (name) => {
        const id = `hook-${lineId++}`;
        toolCalls.push({ id, name, status: "running" });
        renderSidebar();
        return (ok) => {
          const e = toolCalls.find((c) => c.id === id);
          if (e) e.status = ok ? "ok" : "err";
          renderSidebar();
        };
      });
      if (res.summary) setText(note, () => t`${fg(theme.MUTE)(res.summary)}`);
      if (res.summary) summaries.push(res.summary);
      issues ||= res.issues;
    }
    if (!issues) return;
    const issueSummary = summaries.join("\n\n");
    if (issueSummary === prevIssues) {
      sysWarn("post-edit issues unchanged after a fix attempt — leaving them for you");
      return;
    }
    // Hand the failing checks back; the agent triages (fix critical/quick, defer non-critical).
    session.addUser(triagePrompt(summaries));
    addText(() => t`${fg(theme.YELLOW)("↪")} ${fg(theme.MUTE)("post-edit checks failed — agent triaging…")}`);
    await runAgentTurn(issueSummary);
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // (No herdr report on exit: "done" isn't a valid herdr state, and the pane closes on exit so herdr
    //  detects PaneExited itself — a fire-and-forget report wouldn't flush before process.exit anyway.)
    turnAbort?.abort();
    clearTransient(); // cancel the pending tools/subagents auto-hide (no render after destroy)
    themeMonitor?.kill(); // stop following the system theme (D30)
    await session.close();
    await opts.lsp?.stop();
    renderer.destroy();
    process.exit(0);
  }

  // --- events ---------------------------------------------------------------
  // (Autosuggest + submit are wired via the Textarea's onContentChange / onSubmit, set at construction.)
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") return void shutdown(); // Ctrl+Shift+C is now the terminal's copy (Kitty off)
    // Keyboard scroll (mouse capture is off, so there's no wheel). Ctrl+↑/↓ or Alt+↑/↓ scroll a few lines —
    // keys ghostty passes to the app and the input's Textarea doesn't bind. (PgUp/PgDn were dropped: many
    // terminals grab them for their own scrollback, so they never arrived.) ScrollBox drops sticky on scroll.
    const scroll = (delta: number): void => void (key.preventDefault(), transcript.scrollBy(delta));
    if ((key.ctrl || key.meta || key.option) && key.name === "up") return scroll(-3);
    if ((key.ctrl || key.meta || key.option) && key.name === "down") return scroll(3);
    if (key.ctrl && key.name === "r") return void reload(); // D7 hot-swap
    if (key.ctrl && key.name === "b") {
      key.preventDefault(); // else the Textarea also runs readline Ctrl+B (move-back-char)
      key.stopPropagation();
      sidebarOn = !sidebarOn;
      applySidebar(); // the panel appearing/disappearing is the indicator — no transcript log
      return;
    }
    if (key.ctrl && key.name === "t") {
      key.preventDefault(); // else the Textarea runs readline Ctrl+T (transpose-chars)
      key.stopPropagation();
      toggleTodos(); // show/hide the full todo list (hidden by default; sidebar shows the 1-line summary)
      return;
    }
    if (key.ctrl && key.name === "g") {
      key.preventDefault(); // else the Textarea runs readline Ctrl+G (abort)
      key.stopPropagation();
      bottomView = bottomView === "git" ? "files" : "git"; // D49: swap the bottom sidebar slot files ↔ git
      void refreshGit(); // fetch branches/log when switching to git; repaints the sidebar
      return;
    }
    // Enter-family: we OWN it (preventDefault), so the Textarea doesn't *also* newline/submit (double-act).
    // Enter sends (or accepts a popup / resolves the picker); Alt+Enter inserts a newline.
    if (key.name === "return" || key.name === "kpenter") {
      key.preventDefault();
      key.stopPropagation();
      if (key.meta || key.option) return void input.insertText("\n"); // Alt+Enter → newline
      if (asking) {
        const a = asking;
        asking = null;
        setPopup([]);
        a.resolve(a.req.options[a.sel]!.label);
        herdrReport("working"); // herdr telemetry: human answered → the turn resumes
        return;
      }
      if (picker) {
        const p = picker;
        const i = p.sel;
        closePicker();
        p.onPick(i); // Enter → primary action (resume / select)
        return;
      }
      if (suggestOpen()) {
        const it = suggest.items[suggest.sel];
        if (it && suggest.kind === "slash") return void submit(`/${it.insert}`); // `/ex`↵ → run /exit
        if (it && suggest.kind === "at") {
          const next = applyAtSuggestion(input.plainText, it.insert);
          if (it.insert.endsWith("/")) {
            // a directory drills in — complete + keep the popup open, don't send
            echoGuard = next;
            input.setText(next);
            void updateSuggestions(next);
            return;
          }
          return void submit(next); // a file completes and sends
        }
        return; // popup open but nothing highlighted → swallow Enter
      }
      return void submit(input.plainText); // Enter sends the message
    }

    if (asking) {
      key.preventDefault(); // own every key while the picker blocks the turn
      key.stopPropagation();
      if (key.name === "up") {
        asking.sel = Math.max(0, asking.sel - 1);
        renderAsk();
      } else if (key.name === "down") {
        asking.sel = Math.min(asking.req.options.length - 1, asking.sel + 1);
        renderAsk();
      }
      return;
    }

    if (picker) {
      key.preventDefault(); // own every key while open so none leak into the (hidden) Textarea
      key.stopPropagation();
      if (key.name === "up") {
        picker.sel = Math.max(0, picker.sel - 1);
        renderPicker();
      } else if (key.name === "down") {
        picker.sel = Math.min(picker.items.length - 1, picker.sel + 1);
        renderPicker();
      } else if (key.name === "d" && picker.onDelete) {
        picker.onDelete(picker.sel); // 'd' → delete the highlighted row (the handler re-renders/closes)
      } else if (key.name === "escape") {
        closePicker();
      }
      return; // swallow everything else while the picker is open (Enter handled in the Enter-family block)
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
      // (Enter over a popup is handled in the Enter-family block above.)
    }
    // (plain Tab no longer toggles the mode — Shift+Tab / `/mode` do that; Tab only accepts a suggestion.)
    if (key.name === "escape" && busy && turnAbort) {
      aborting = true; // flip the indicator to red "stopping…" immediately so ESC visibly registers
      turnAbort.abort();
      steerQueue.length = 0; // D46: ESC means stop — drop any queued steering too
      herdrReport("idle"); // herdr telemetry: user interrupted the turn
      if (sidebar.visible) sidebar.setActivity(t`${activityChunk()}`);
      else setStatus();
    }
  });

  // Paste shortening (#3): a long or multi-line paste becomes a compact "[Pasted N lines]" token in the
  // input (the full text is stashed + restored on send), so the single-line box isn't flooded / collapsed.
  renderer.keyInput.on("paste", (ev: { bytes: Uint8Array; preventDefault: () => void }) => {
    const text = new TextDecoder().decode(ev.bytes);
    const lines = pasteToken(text);
    if (lines === null) return; // short single-line paste → let the input insert it normally
    ev.preventDefault();
    const id = ++pasteSeq;
    pastes.set(id, text);
    // insert AT the cursor (not append) so the token lands left of the caret and the caret moves past it (#1)
    input.insertText(`[Pasted ${lines} line${lines === 1 ? "" : "s"} #${id}]`);
  });

  if (session.title) transcriptBox.title = ` ◆ ${session.title} `; // resumed session keeps its title
  addText(() => t`${fg(theme.ACCENT)("✦")} ${fg(theme.MUTE)("welcome to nerve")} ${fg(theme.DIM)("· /help for commands")}`);
  applySidebar(); // size sidebar + status bar to the terminal width, and render their content (calls setStatus)
  watchSystemTheme(); // D30: live-follow GNOME light/dark
  void refreshBalance();
  void refreshGit(); // D49: populate the session panel's branch + status on launch
}
