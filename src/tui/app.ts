// The interactive terminal UI (OpenTUI imperative core). A sticky-bottom transcript, a status line,
// and an input. Streaming text lands in a live TextRenderable; reasoning renders dim; tool results
// dim. Keys: Enter submit, Shift+Tab toggle mode, ESC abort turn, Ctrl+C exit. See docs/manual/tui.md.
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
import type { Mode } from "../dispatch.ts";
import type { Provider, ToolSpec } from "../providers/types.ts";
import type { Session } from "../session.ts";

const FG = "#c0caf5";
const DIM = "#565f89";
const USER = "#7aa2f7";
const ACCENT = "#9ece6a";
const ERR = "#f7768e";

export interface TuiOptions {
  provider: Provider;
  providerName: string;
  session: Session;
  model: string;
  mode: Mode;
  cwd: string;
  system: string;
  tools: ToolSpec[];
  thinking: boolean;
  temperature?: number;
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });

  let mode: Mode = opts.mode;
  let busy = false;
  let turnAbort: AbortController | null = null;
  let lineId = 0;

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
  const status = new TextRenderable(renderer, { id: "status", height: 1, content: "", bg: "#1f2335" });
  const input = new InputRenderable(renderer, {
    id: "input",
    width: "100%",
    placeholder: "Message nerve — Enter to send · Shift+Tab mode · ESC stop · Ctrl+C quit",
    textColor: FG,
    cursorColor: ACCENT,
  });
  root.add(transcript);
  root.add(status);
  root.add(input);
  renderer.root.add(root);
  input.focus();

  const setStatus = (): void => {
    status.content = ` ${opts.model} (${opts.providerName}) · ${mode === "plan" ? "PLAN" : "YOLO"} · ${opts.session.id}${busy ? " · streaming… (ESC)" : ""}`;
  };
  setStatus();

  const addLine = (content: string, fg = FG, attributes = 0): TextRenderable => {
    const line = new TextRenderable(renderer, { id: `line-${lineId++}`, content, fg, attributes });
    transcript.add(line);
    return line;
  };

  async function submit(value: string): Promise<void> {
    const text = value.trim();
    input.value = "";
    if (!text || busy) return;
    busy = true;
    setStatus();
    addLine(`› ${text}`, USER, TextAttributes.BOLD);
    opts.session.addUser(text);

    let reasoningLine: TextRenderable | null = null;
    const answer = addLine("", FG);
    turnAbort = new AbortController();
    try {
      await loop({
        provider: opts.provider,
        session: opts.session,
        model: opts.model,
        mode,
        ctx: { cwd: opts.cwd },
        interceptors: [
          secretRedaction(),
          reasoningRouter((d) => {
            if (!reasoningLine) reasoningLine = addLine("", DIM, TextAttributes.ITALIC);
            reasoningLine.content += d;
          }),
          tokenTap(opts.session),
        ],
        signal: turnAbort.signal,
        system: opts.system,
        tools: opts.tools,
        thinking: opts.thinking,
        temperature: opts.temperature,
        onEvent: (ev) => {
          if (ev.type === "text") answer.content += ev.delta;
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

  input.on(InputRenderableEvents.ENTER, (value: string) => void submit(value));

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    turnAbort?.abort();
    await opts.session.close();
    renderer.destroy();
    process.exit(0);
  }

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") void shutdown();
    else if (key.shift && key.name === "tab") {
      mode = mode === "plan" ? "yolo" : "plan";
      setStatus();
    } else if (key.name === "escape") {
      turnAbort?.abort();
    }
  });

  addLine(`nerve · ${opts.model} (${opts.providerName}) · start in ${mode === "plan" ? "PLAN" : "YOLO"} mode`, DIM);
}

function firstLine(s: string): string {
  const l = s.split("\n")[0] ?? "";
  return l.length > 120 ? `${l.slice(0, 117)}…` : l;
}
