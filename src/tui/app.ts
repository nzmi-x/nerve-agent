// The interactive terminal UI (OpenTUI imperative core). Paneled layout: a bordered transcript that
// renders assistant output as markdown, an autosuggest/ask popup with row highlighting, a bordered
// input, and a styled status bar (model · mode · cost · context · balance). Affordances: @file, !shell,
// /command + an interactive ask_user picker. See docs/manual/tui.md; OpenTUI API via manual("opentui").
import { unlinkSync } from "node:fs";
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
import { reasoningRouter, secretRedaction, tokenTap } from "../interceptors.ts";
import { bash } from "../tools/bash.ts";
import { selectModel, providerFor, type ModelEntry } from "../config.ts";
import { UsageMeter, formatCost, formatContext } from "../usage.ts";
import { fetchBalance, formatBalance, type Balance } from "../balance.ts";
import { parseAffordance, atSuggestions, slashSuggestions, parseSlash, applyAtSuggestion, type CommandInfo } from "./affordances.ts";
import type { Mode } from "../dispatch.ts";
import type { Provider, ToolSpec } from "../providers/types.ts";
import type { AskRequest } from "../tools/types.ts";
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
  "commands  /help · /model [id] · /mode plan|edit · /clear · /drop · /balance · /resume · /quit",
  "input     @path file ref · !cmd run shell directly · /cmd command",
  "keys      Enter send · Tab accept · ↑/↓ navigate · Shift+Tab mode · ESC stop · Ctrl+C quit",
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
  const { models, cwd, system, tools, skills } = opts;

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
  root.add(popup);
  root.add(inputBox);
  root.add(status);
  renderer.root.add(root);
  input.focus();

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
      const cmds = slashSuggestions(aff.query, skills).slice(0, MAX_POPUP);
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

  async function drop(): Promise<void> {
    const old = session.id;
    await session.close();
    try {
      unlinkSync(join(".nerve", "sessions", `${old}.jsonl`));
    } catch {
      /* already gone */
    }
    session = new Session({});
    meter = new UsageMeter();
    clearTranscript();
    addText(t`${fg(MAGENTA)("✦")} ${fg(MUTE)(`dropped ${old} · new session ${session.id}`)}`);
    setStatus();
  }

  async function runCommand(value: string): Promise<void> {
    const { name, args } = parseSlash(value);
    switch (name) {
      case "help":
        addText(HELP, MUTE);
        return;
      case "quit":
        return void shutdown();
      case "clear":
        clearTranscript();
        return;
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
        addText("resume is a launch flag: bun index.ts --resume <id>|last", MUTE);
        return;
      default:
        addText(skills.some((s) => s.name === name) ? `skill "${name}" — invocation lands in Phase 2; for now: manual("${name}")` : `unknown command: /${name} (try /help)`, MUTE);
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
    let reasoningLine: TextRenderable | null = null;
    const answer = addMarkdown();
    turnAbort = new AbortController();
    try {
      await loop({
        provider,
        session,
        model: active.id,
        mode,
        ctx: { cwd, ask },
        interceptors: [
          secretRedaction(),
          reasoningRouter((d) => {
            reasoningLine ??= addText("✻ ", DIM, TextAttributes.ITALIC);
            reasoningLine.content += d;
          }),
          tokenTap(session),
        ],
        signal: turnAbort.signal,
        system,
        tools,
        thinking: active.thinking ?? false,
        temperature: active.temperature,
        onEvent: (ev) => {
          if (ev.type === "text") answer.content += ev.delta;
          else if (ev.type === "usage") {
            meter.record({ input: ev.input, output: ev.output }, active.pricing);
            setStatus();
          }
        },
        onToolResult: (name, result) => addText(t`${fg(DIM)("⎿")} ${fg(MUTE)(name)}  ${fg(DIM)(firstLine(result))}`),
      });
    } catch (e) {
      addText(`✗ ${e instanceof Error ? e.message : String(e)}`, RED);
    } finally {
      answer.streaming = false;
      busy = false;
      turnAbort = null;
      setStatus();
      input.focus();
    }
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    turnAbort?.abort();
    await session.close();
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
    if (!asking) void submit(value);
  });

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") return void shutdown();

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

    if (key.shift && key.name === "tab") {
      mode = mode === "plan" ? "edit" : "plan";
      setStatus();
      return;
    }
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
    if (key.name === "escape") turnAbort?.abort();
  });

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
