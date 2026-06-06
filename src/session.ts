// The conversation accumulator + persistence. Folds StreamEvents into the in-progress assistant
// turn and persists typed JSONL lines: {"t":"msg"} (canonical — replayed on resume) and {"t":"delta"}
// (token-tap telemetry — ignored on resume). See ARCHITECTURE_BRIEF §6, DECISIONS D8, docs/manual/session.md.
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Message, StreamEvent, ToolCall } from "./providers/types.ts";

export interface SessionInit {
  id?: string;
  dir?: string;
  /** Reload prior `msg` lines from the existing file (for `--resume`). */
  resume?: boolean;
}

interface ToolCallBuf {
  id?: string;
  name?: string;
  args: string;
  signature?: string;
}

export class Session {
  readonly id: string;
  readonly messages: Message[] = [];
  private readonly sink: WriteStream;

  // in-progress assistant turn
  private text = "";
  private reasoning = "";
  private readonly toolBufs = new Map<number, ToolCallBuf>();

  constructor(init: SessionInit = {}) {
    this.id = init.id ?? new Date().toISOString().replace(/[:.]/g, "-");
    const dir = init.dir ?? join(".nerve", "sessions");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.id}.jsonl`);
    if (init.resume && existsSync(path)) this.messages.push(...loadMessages(path));
    this.sink = createWriteStream(path, { flags: "a" });
  }

  private writeLine(obj: unknown): void {
    this.sink.write(JSON.stringify(obj) + "\n");
  }

  addUser(content: string): void {
    const msg: Message = { role: "user", content };
    this.messages.push(msg);
    this.writeLine({ t: "msg", ...msg });
  }

  /** Token-tap telemetry: raw text/reasoning deltas + usage, written as `delta` lines. */
  tap(ev: StreamEvent): void {
    if (ev.type === "text" || ev.type === "reasoning") this.writeLine({ t: "delta", type: ev.type, delta: ev.delta });
    else if (ev.type === "usage") this.writeLine({ t: "delta", type: "usage", input: ev.input, output: ev.output });
  }

  /** Fold one StreamEvent into the in-progress assistant turn. */
  apply(ev: StreamEvent): void {
    if (ev.type === "text") this.text += ev.delta;
    else if (ev.type === "reasoning") this.reasoning += ev.delta;
    else if (ev.type === "tool_call") {
      const buf = this.toolBufs.get(ev.index) ?? { args: "" };
      if (ev.id) buf.id = ev.id;
      if (ev.name) buf.name = ev.name;
      if (ev.signature) buf.signature = ev.signature;
      buf.args += ev.args;
      this.toolBufs.set(ev.index, buf);
    }
    // usage / done / error don't accumulate into the message
  }

  /** Finalize the in-progress assistant turn into a Message, persist it, reset the buffer. */
  commitAssistant(): Message {
    const toolCalls = this.assembleToolCalls();
    const msg: Message = {
      role: "assistant",
      content: this.text,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    this.messages.push(msg);
    this.writeLine({ t: "msg", ...msg });
    this.text = "";
    this.reasoning = "";
    this.toolBufs.clear();
    return msg;
  }

  private assembleToolCalls(): ToolCall[] {
    return [...this.toolBufs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => ({
        id: b.id ?? "",
        name: b.name ?? "",
        args: b.args,
        ...(b.signature ? { signature: b.signature } : {}),
      }));
  }

  addToolResult(toolCallId: string, content: string): void {
    const msg: Message = { role: "tool", content, toolCallId };
    this.messages.push(msg);
    this.writeLine({ t: "msg", ...msg });
  }

  /** Flush and close the JSONL sink. */
  close(): Promise<void> {
    return new Promise((resolve) => this.sink.end(resolve));
  }
}

/** Read a session file and rebuild its messages from the `msg` lines (delta lines are ignored). */
export function loadMessages(path: string): Message[] {
  if (!existsSync(path)) return [];
  const out: Message[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown> & { t?: string };
      if (o.t === "msg") {
        const { t, ...msg } = o;
        out.push(msg as unknown as Message);
      }
    } catch {
      // skip a malformed line rather than fail the whole resume
    }
  }
  return out;
}
