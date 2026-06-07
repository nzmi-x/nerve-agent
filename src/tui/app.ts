// The interactive terminal UI (OpenTUI imperative core). Paneled layout: a bordered transcript that
// renders assistant output as markdown, an autosuggest/ask popup with row highlighting, a bordered
// input, and a styled status bar (model · mode · cost · context · balance). Affordances: @file, !shell,
// /command + an interactive ask_user picker. See docs/manual/tui.md; OpenTUI API via manual("opentui").
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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
import { parseAffordance, atSuggestions, slashSuggestions, parseSlash, applyAtSuggestion, type CommandInfo } from "./affordances.ts";
import { expandCommand, type Command } from "../commands.ts";
import { pickCutPoint, pruneToolOutputs, summarize } from "../compaction.ts";
import { activePacks, defaultSkills, langForFile, langSkills, runHooks, triagePrompt } from "../langpack.ts";
import { listSessions, lastSessionId } from "../sessions.ts";
import { sessionsDir } from "../paths.ts";
import type { Mode } from "../dispatch.ts";
import type { Message, Provider, ToolSpec } from "../providers/types.ts";
import type { AskRequest, Todo } from "../tools/types.ts";
import type { Lsp } from "../lsp/manager.ts";
import { Session } from "../session.ts";

// Tokyo Night palette
const FG = "#c0caf5";
const MUTE = "#737aa2";
const DIM = "#565f89";
const BORDER = "#2f334d";
const ACCENT = "#7aa2f7";
const GREEN = "#9ece6a";
const YELLOW = "#e0af68";
const RED = "#f7768e";
const MAGENTA = "#bb9af7";
const CYAN = "#7dcfff";
const ORANGE = "#ff9e64";
const SELBG = "#283457";
const PANEL = "#16161e";
const DARKFG = "#1a1b26";
const WHITE = "#ffffff";

const syntaxStyle = SyntaxStyle.fromStyles({
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

type Content = string | ReturnType<typeof t>;

const HELP = [
  "commands  /help · /model [id] · /mode plan|edit · /clear · /compact · /reload · /sessions · /resume [id] · /drop · /balance · /quit",
  "input     @path file ref · !cmd run shell directly · /cmd command",
  "keys      Enter send · Tab accept / toggle mode · ↑/↓ navigate · Shift+Tab mode · Ctrl+R reload · ESC stop · Ctrl+C quit",
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
  skills: CommandInfo[];
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

  let suggest: { kind: "at" | "slash" | "none"; items: Suggestion[]; sel: number } = { kind: "none", items: [], sel: 0 };
  let asking: { req: AskRequest; sel: number; resolve: (answer: string) => void } | null = null;

  // --- layout ---------------------------------------------------------------
  const root = new BoxRenderable(renderer, { id: "root", width: "100%", height: "100%", flexDirection: "column", padding: 0 });
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

  root.add(transcriptBox);
  root.add(todoBox);
  root.add(popup);
  root.add(inputBox);
  root.add(status);
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
  const setTodos = (todos: Todo[]): void => {
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

  // --- transcript -----------------------------------------------------------
  const lineIds: string[] = [];
  const addText = (content: Content, fgColor = FG, attributes = 0): TextRenderable => {
    const tr = new TextRenderable(renderer, { id: `ln-${lineId++}`, content, fg: fgColor, attributes });
    transcript.add(tr);
    lineIds.push(tr.id);
    return tr;
  };
  const addMarkdown = (): MarkdownRenderable => {
    const md = new MarkdownRenderable(renderer, { id: `md-${lineId++}`, width: "100%", content: "", syntaxStyle, streaming: true });
    transcript.add(md);
    lineIds.push(md.id);
    return md;
  };
  const spacer = (): void => void addText("");
  const clearTranscript = (): void => {
    for (const id of lineIds) transcript.remove(id);
    lineIds.length = 0;
  };
  // Replay loaded messages into the transcript (for /resume). Reasoning isn't replayed (telemetry only).
  const renderHistory = (messages: Message[]): void => {
    for (const m of messages) {
      if (m.role === "user") {
        spacer();
        addText(t`${bold(fg(GREEN)("❯"))} ${m.content}`);
      } else if (m.role === "assistant") {
        if (m.content) {
          const md = addMarkdown();
          md.content = m.content;
          md.streaming = false;
        }
        for (const tc of m.toolCalls ?? []) addText(t`${fg(DIM)("⎿")} ${fg(MUTE)(tc.name)}`);
      } else if (m.role === "tool") {
        addText(t`${fg(DIM)("⎿")} ${fg(DIM)(firstLine(m.content))}`);
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
  };

  const toggleMode = (): void => {
    mode = mode === "plan" ? "edit" : "plan";
    setStatus();
    addText(`mode → ${mode.toUpperCase()}`, MUTE);
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
    addText(t`${bold(fg(YELLOW)("$"))} ${c}`);
    try {
      addText(await bash.run({ command: c }, { cwd }), MUTE); // full authority, ungated, not added to the session
    } catch (e) {
      addText(`✗ ${e instanceof Error ? e.message : String(e)}`, RED);
    }
  }

  // D17: summarize old turns into one message to reclaim context. Manual for now; ESC cancels.
  const KEEP_TOKENS = 20_000;
  async function compact(focus: string): Promise<void> {
    if (busy) return;
    const cut = pickCutPoint(session.messages, KEEP_TOKENS);
    if (cut < 2) {
      addText(t`${fg(MAGENTA)("✦")} ${fg(MUTE)("nothing old enough to compact yet")}`);
      return;
    }
    busy = true;
    setStatus();
    const note = addText(t`${fg(MAGENTA)("✦")} ${fg(MUTE)("compacting…")}`);
    turnAbort = new AbortController();
    try {
      const input = pruneToolOutputs(session.messages.slice(0, cut)).messages; // shrink the summarizer's input
      const keep = session.messages.length - cut;
      const summary = await summarize(provider, active.id, input, compactionPrompt, focus, turnAbort.signal);
      session.compact(summary, keep);
      note.content = t`${fg(MAGENTA)("✦")} ${fg(MUTE)(`compacted ${cut} earlier message(s) → summary · ${session.messages.length} now in context`)}`;
    } catch (e) {
      note.content = t`${fg(RED)("✗")} ${fg(MUTE)(`compaction failed: ${e instanceof Error ? e.message : String(e)}`)}`;
    } finally {
      busy = false;
      turnAbort = null;
      setStatus();
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
    if (rt.ok && !icErr) addText(t`${fg(GREEN)("↻")} ${fg(MUTE)(`reloaded ${rt.names.length} tools + interceptors from disk`)}`);
    else addText(`✗ reload failed (kept the running set) — ${!rt.ok ? rt.error : icErr}`, RED);
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
    try {
      unlinkSync(join(sessionsDir(cwd), `${old}.jsonl`));
    } catch {
      /* already gone */
    }
    session = new Session({});
    meter = new UsageMeter();
    clearTranscript();
    setTodos([]); // fresh session, fresh task list
    transcriptBox.title = " ◆ nerve ";
    addText(t`${fg(MAGENTA)("✦")} ${fg(MUTE)(`dropped ${old} · new session ${session.id}`)}`);
    setStatus();
  }

  // /resume [id] — switch to an existing session (default: the most recent one that isn't this one).
  async function resumeSession(idArg?: string): Promise<void> {
    if (busy) return;
    const id = idArg ?? lastSessionId(sessionsDir(cwd), session.id);
    if (!id) return void addText("no other session to resume", MUTE);
    if (!existsSync(join(sessionsDir(cwd), `${id}.jsonl`))) return void addText(`✗ no session '${id}'`, RED);
    await session.close();
    session = new Session({ id, resume: true });
    meter = new UsageMeter();
    clearTranscript();
    renderHistory(session.messages);
    transcriptBox.title = session.title ? ` ◆ ${session.title} ` : " ◆ nerve ";
    addText(t`${fg(MAGENTA)("✦")} ${fg(MUTE)(`resumed ${id}${session.title ? ` · ${session.title}` : ""} · ${session.messages.length} message(s) in context`)}`);
    setStatus();
  }

  // /sessions — list sessions; /sessions delete <id> removes one (not the current — that's /drop).
  function sessionsCommand(args: string[]): void {
    const sub = args[0];
    if (sub === "delete" || sub === "rm") {
      const id = args[1];
      if (!id) return void addText("usage: /sessions delete <id>", MUTE);
      if (id === session.id) return void addText("✗ that's the current session — use /drop", RED);
      try {
        unlinkSync(join(sessionsDir(cwd), `${id}.jsonl`));
        addText(t`${fg(MAGENTA)("✦")} ${fg(MUTE)(`deleted ${id}`)}`);
      } catch {
        addText(`✗ no session '${id}'`, RED);
      }
      return;
    }
    const list = listSessions(sessionsDir(cwd));
    if (!list.length) return void addText("no sessions yet", MUTE);
    addText(t`${fg(ACCENT)("sessions")}  ${fg(DIM)("/resume <id> · /sessions delete <id>")}`);
    for (const s of list) {
      const cur = s.id === session.id;
      const label = s.title || s.preview;
      addText(t`${cur ? fg(GREEN)("●") : fg(DIM)("·")} ${fg(cur ? GREEN : FG)(s.id)}  ${fg(MUTE)(`${s.msgs}msg`)}  ${fg(DIM)(rel(s.mtimeMs))}  ${fg(s.title ? CYAN : DIM)(trunc(label, Math.max(16, renderer.width - 52)))}`);
    }
  }

  async function runCommand(value: string): Promise<void> {
    const { name, args } = parseSlash(value);
    switch (name) {
      case "help":
        addText(HELP, MUTE);
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
          setStatus();
          addText(`mode → ${m.toUpperCase()}`, MUTE);
        } else addText("usage: /mode plan|edit", MUTE);
        return;
      }
      case "model": {
        const id = args[0];
        if (!id) {
          addText(`models: ${models.map((m) => m.id).join(", ")}`, MUTE);
          return;
        }
        try {
          active = selectModel(models, id);
          provider = providerFor(active);
          setStatus();
          addText(`model → ${active.id}`, MUTE);
          void refreshBalance();
        } catch (e) {
          addText(`✗ ${e instanceof Error ? e.message : String(e)}`, RED);
        }
        return;
      }
      case "balance":
        await refreshBalance();
        addText(`balance: ${formatBalance(balance)}${active.provider === "gemini" ? "  (Gemini has no balance API)" : ""}`, MUTE);
        return;
      case "resume":
        return void resumeSession(args[0]);
      case "sessions":
        return void sessionsCommand(args);
      default: {
        // D16: a markdown command file → expand its body and submit it as a prompt.
        const cmd = commands.find((c) => c.name === name);
        if (cmd) return void submit(expandCommand(cmd.body, args));
        addText(skills.some((s) => s.name === name) ? `skill "${name}" — invocation lands in Phase 2; for now: manual("${name}")` : `unknown command: /${name} (try /help)`, MUTE);
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

    busy = true;
    setStatus();
    spacer();
    addText(t`${bold(fg(GREEN)("❯"))} ${text}`);
    session.addUser(text);
    await runAgentTurn();
    void titleSession(); // D26: name the session from its first exchange (no-op once titled)
    busy = false;
    setStatus();
    input.focus();
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
        ctx: { cwd, ask, lsp: opts.lsp, touched: langTouched, edited, setTodos },
        interceptors: [
          ic.secretRedaction(),
          ic.reasoningRouter((d) => {
            reasoningLine ??= addText("✻ ", DIM, TextAttributes.ITALIC);
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
        onToolResult: (name, result) => {
          if (name === "todo") return; // shown in the pinned todo panel, not as a transcript line
          addText(t`${fg(DIM)("⎿")} ${fg(MUTE)(name)}  ${fg(DIM)(firstLine(result))}`);
        },
        onRetry: ({ delayMs, model }) => {
          transcript.remove(answer.id); // drop the failed (usually empty) attempt
          reasoningLine = null;
          addText(t`${fg(YELLOW)("↻")} ${fg(MUTE)(`retrying on ${model}${delayMs ? ` in ${Math.round(delayMs / 1000)}s` : ""}…`)}`);
          answer = addMarkdown(); // fresh block for the retried attempt
        },
        onError: (e) => addText(`✗ ${e instanceof Error ? e.message : String(e)}`, RED),
      });
    } catch (e) {
      addText(`✗ ${e instanceof Error ? e.message : String(e)}`, RED);
    } finally {
      answer.streaming = false;
      turnAbort = null;
    }
    if (ac.signal.aborted) return; // user hit ESC — skip hooks + auto-fix

    // D24 post-edit hooks: fix + check the files edited this turn (EDIT only). Files were just written,
    // so this is the safe time to reformat (next turn re-reads / hashline re-anchors).
    if (mode !== "edit" || edited.size === 0) return;
    const summaries: string[] = [];
    let issues = false;
    for (const pack of activePacks(edited)) {
      const files = [...edited].filter((f) => langForFile(f) === pack);
      const note = addText(t`${fg(DIM)("⚙")} ${fg(MUTE)(`post-edit (${pack.id})…`)}`);
      const res = await runHooks(pack, files, cwd);
      note.content = res.summary || note.content;
      note.fg = MUTE;
      if (res.summary) summaries.push(res.summary);
      issues ||= res.issues;
    }
    if (!issues) return;
    const issueSummary = summaries.join("\n\n");
    if (issueSummary === prevIssues) {
      addText(t`${fg(YELLOW)("⚠")} ${fg(MUTE)("post-edit issues unchanged after a fix attempt — leaving them for you")}`);
      return;
    }
    // Hand the failing checks back; the agent triages (fix critical/quick, defer non-critical).
    session.addUser(triagePrompt(summaries));
    addText(t`${fg(YELLOW)("↪")} ${fg(MUTE)("post-edit checks failed — agent triaging…")}`);
    await runAgentTurn(issueSummary);
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    turnAbort?.abort();
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
    if (key.ctrl && key.name === "c") return void shutdown();
    if (key.ctrl && key.name === "r") return void reload(); // D7 hot-swap

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
  addText(t`${fg(ACCENT)("✦")} ${fg(MUTE)("welcome to nerve")} ${fg(DIM)("— type a message · @file · !shell · /command · /help")}`);
  setStatus();
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
