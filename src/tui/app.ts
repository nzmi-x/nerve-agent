// The interactive terminal UI (OpenTUI imperative core): sticky-bottom transcript, an autosuggest
// row, a status line (mode · model · cost · context% · balance), and an input with affordances —
// @path files, !cmd shell, /cmd commands, plus an interactive ask_user picker. See docs/manual/tui.md.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextAttributes,
  type KeyEvent,
} from "@opentui/core";
import { loop } from "../loop.ts";
import { reasoningRouter, secretRedaction, tokenTap } from "../interceptors.ts";
import { bash } from "../tools/bash.ts";
import { selectModel, providerFor, type ModelEntry } from "../config.ts";
import { UsageMeter, formatCost, formatContext } from "../usage.ts";
import { fetchBalance, formatBalance, type Balance } from "../balance.ts";
import {
  parseAffordance,
  atSuggestions,
  slashSuggestions,
  parseSlash,
  applyAtSuggestion,
  type CommandInfo,
} from "./affordances.ts";
import type { Mode } from "../dispatch.ts";
import type { Provider, ToolSpec } from "../providers/types.ts";
import type { AskRequest } from "../tools/types.ts";
import { Session } from "../session.ts";

const FG = "#c0caf5";
const DIM = "#565f89";
const USER = "#7aa2f7";
const ACCENT = "#9ece6a";
const ERR = "#f7768e";

const HELP = [
  "commands: /help /model [id] /mode plan|yolo /clear /drop /balance /resume /quit",
  "input:    @path (file ref) · !cmd (run shell directly) · /cmd (command)",
  "keys:     Enter send · Tab accept suggestion · ↑/↓ navigate · Shift+Tab mode · ESC stop · Ctrl+C quit",
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
  label: string;
  insert: string;
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
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

  let suggest: { kind: "at" | "slash" | "none"; items: Suggestion[]; sel: number } = { kind: "none", items: [], sel: 0 };
  let asking: { req: AskRequest; sel: number; resolve: (answer: string) => void } | null = null;

  // --- layout ---------------------------------------------------------------
  const root = new BoxRenderable(renderer, { id: "root", width: "100%", height: "100%", flexDirection: "column" });
  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    width: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const popup = new TextRenderable(renderer, { id: "popup", content: "", fg: DIM, paddingLeft: 1 });
  const status = new TextRenderable(renderer, { id: "status", content: "", bg: "#1f2335" });
  const input = new InputRenderable(renderer, {
    id: "input",
    width: "100%",
    placeholder: "Message · @file · !shell · /command — Enter send · Shift+Tab mode · Ctrl+C quit",
    textColor: FG,
    cursorColor: ACCENT,
  });
  root.add(transcript);
  root.add(popup);
  root.add(status);
  root.add(input);
  renderer.root.add(root);
  input.focus();

  const lines: TextRenderable[] = [];
  const addLine = (content: string, fg = FG, attributes = 0): TextRenderable => {
    const line = new TextRenderable(renderer, { id: `line-${lineId++}`, content, fg, attributes });
    transcript.add(line);
    lines.push(line);
    return line;
  };
  const clearTranscript = (): void => {
    for (const l of lines) transcript.remove(l.id);
    lines.length = 0;
  };

  const setStatus = (): void => {
    const s = meter.snapshot();
    status.content = ` ${active.id} · ${mode === "plan" ? "PLAN" : "YOLO"} · ${formatCost(s.costUsd)} · ctx ${formatContext(s.contextTokens, active.contextWindow)} · bal ${formatBalance(balance)}${busy ? " · …" : ""}`;
  };

  // --- suggestions ----------------------------------------------------------
  const suggestOpen = (): boolean => suggest.items.length > 0;
  const clearSuggest = (): void => {
    suggest = { kind: "none", items: [], sel: 0 };
    if (!asking) popup.content = "";
  };
  const renderSuggest = (): void => {
    if (asking || suggest.items.length === 0) {
      if (!asking) popup.content = "";
      return;
    }
    popup.fg = DIM;
    popup.content = suggest.items.map((it, i) => `${i === suggest.sel ? "▶ " : "  "}${it.label}`).join("\n");
  };
  async function updateSuggestions(value: string): Promise<void> {
    if (asking) return;
    const aff = parseAffordance(value);
    if (aff.kind === "at") {
      const paths = await atSuggestions(aff.query, cwd);
      suggest = { kind: "at", items: paths.map((p) => ({ label: p, insert: p })), sel: 0 };
    } else if (aff.kind === "slash") {
      const cmds = slashSuggestions(aff.query, skills);
      suggest = { kind: "slash", items: cmds.map((c) => ({ label: `/${c.name}${c.description ? `  ${c.description}` : ""}`, insert: c.name })), sel: 0 };
    } else {
      suggest = { kind: "none", items: [], sel: 0 };
    }
    renderSuggest();
  }
  function acceptSuggestion(): void {
    const it = suggest.items[suggest.sel];
    if (!it) return;
    input.value = suggest.kind === "at" ? applyAtSuggestion(input.value, it.insert) : `/${it.insert} `;
    clearSuggest();
    void updateSuggestions(input.value);
  }

  // --- ask_user picker (ctx.ask) -------------------------------------------
  const renderAsk = (): void => {
    if (!asking) return;
    const rows = [`? ${asking.req.question}`];
    asking.req.options.forEach((o, i) => {
      rows.push(`${i === asking!.sel ? "▶ " : "  "}${o.label}${o.recommended ? " (recommended)" : ""}${o.description ? ` — ${o.description}` : ""}`);
    });
    popup.fg = ACCENT;
    popup.content = rows.join("\n");
  };
  function ask(req: AskRequest): Promise<string> {
    return new Promise((resolve) => {
      const rec = req.options.findIndex((o) => o.recommended);
      asking = { req, sel: rec >= 0 ? rec : 0, resolve };
      renderAsk();
    });
  }

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
    addLine(`! ${c}`, ACCENT);
    try {
      addLine(await bash.run({ command: c }, { cwd }), DIM); // full authority, ungated, not added to the session
    } catch (e) {
      addLine(`✗ ${e instanceof Error ? e.message : String(e)}`, ERR);
    }
  }

  async function drop(): Promise<void> {
    const old = session.id;
    await session.close();
    try {
      unlinkSync(join(".nerve", "sessions", `${old}.jsonl`));
    } catch {
      // already gone — fine
    }
    session = new Session({});
    meter = new UsageMeter();
    clearTranscript();
    addLine(`dropped session ${old} · new session ${session.id}`, DIM);
    setStatus();
  }

  async function runCommand(value: string): Promise<void> {
    const { name, args } = parseSlash(value);
    switch (name) {
      case "help":
        addLine(HELP, DIM);
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
        if (m === "plan" || m === "yolo") {
          mode = m;
          setStatus();
          addLine(`mode → ${m.toUpperCase()}`, DIM);
        } else addLine("usage: /mode plan|yolo", DIM);
        return;
      }
      case "model": {
        const id = args[0];
        if (!id) {
          addLine(`models: ${models.map((m) => m.id).join(", ")}`, DIM);
          return;
        }
        try {
          active = selectModel(models, id);
          provider = providerFor(active);
          setStatus();
          addLine(`model → ${active.id}`, DIM);
          void refreshBalance();
        } catch (e) {
          addLine(`✗ ${e instanceof Error ? e.message : String(e)}`, ERR);
        }
        return;
      }
      case "balance":
        await refreshBalance();
        addLine(`balance: ${formatBalance(balance)}${active.provider === "gemini" ? " (Gemini has no balance API)" : ""}`, DIM);
        return;
      case "resume":
        addLine("resume is a launch flag: bun index.ts --resume <id>|last", DIM);
        return;
      default:
        addLine(
          skills.some((s) => s.name === name)
            ? `skill "${name}" — invocation lands in Phase 2; for now: manual("${name}")`
            : `unknown command: /${name} (try /help)`,
          DIM,
        );
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
    addLine(`› ${text}`, USER, TextAttributes.BOLD);
    session.addUser(text);
    let reasoningLine: TextRenderable | null = null;
    const answer = addLine("", FG);
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
            reasoningLine ??= addLine("", DIM, TextAttributes.ITALIC);
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
        onToolResult: (name, result) => addLine(`→ ${name}: ${firstLine(result)}`, DIM),
      });
    } catch (e) {
      addLine(`✗ ${e instanceof Error ? e.message : String(e)}`, ERR);
    } finally {
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
  input.on(InputRenderableEvents.INPUT, (value: string) => void updateSuggestions(value));
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
        popup.content = "";
        a.resolve(a.req.options[a.sel]!.label);
      }
      return;
    }

    if (key.shift && key.name === "tab") {
      mode = mode === "plan" ? "yolo" : "plan";
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

  addLine(`nerve · ${active.id} (${active.provider}) · ${mode === "plan" ? "PLAN" : "YOLO"} · /help for commands`, DIM);
  setStatus();
  void refreshBalance();
}

function firstLine(s: string): string {
  const l = s.split("\n")[0] ?? "";
  return l.length > 120 ? `${l.slice(0, 117)}…` : l;
}
