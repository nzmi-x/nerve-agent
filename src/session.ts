// The conversation accumulator + persistence. Folds StreamEvents into the in-progress assistant
// turn and persists typed JSONL lines: {"t":"msg"} (canonical — replayed on resume) and {"t":"delta"}
// (token-tap telemetry — ignored on resume). See ARCHITECTURE_BRIEF §6, DECISIONS D8, docs/manual/session.md.
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { summaryMessage } from "./compaction.ts";
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

  // Count of canonical `msg` lines ever written — the global ordinal compaction anchors against (D17).
  // A compacted summary is NOT a msg line, so it doesn't advance this; kept messages keep their ordinals.
  private totalMsgs = 0;

  // in-progress assistant turn
  private text = "";
  private reasoning = "";
  private readonly toolBufs = new Map<number, ToolCallBuf>();

  constructor(init: SessionInit = {}) {
    this.id = init.id ?? new Date().toISOString().replace(/[:.]/g, "-");
    const dir = init.dir ?? join(".nerve", "sessions");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.id}.jsonl`);
    if (init.resume && existsSync(path)) {
      const loaded = loadSession(path);
      this.messages.push(...loaded.messages);
      this.totalMsgs = loaded.total;
    }
    this.sink = createWriteStream(path, { flags: "a" });
  }

  private writeLine(obj: unknown): void {
    this.sink.write(JSON.stringify(obj) + "\n");
  }

  addUser(content: string): void {
    const msg: Message = { role: "user", content };
    this.messages.push(msg);
    this.totalMsgs++;
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
    this.totalMsgs++;
    this.writeLine({ t: "msg", ...msg });
    this.text = "";
    this.reasoning = "";
    this.toolBufs.clear();
    return msg;
  }

  /** Drop the in-progress assistant turn without committing it — a failed attempt being retried (D15). */
  discardAssistant(): void {
    this.text = "";
    this.reasoning = "";
    this.toolBufs.clear();
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
    this.totalMsgs++;
    this.writeLine({ t: "msg", ...msg });
  }

  /**
   * Compaction (D17): replace live context with `[summary, …last keepCount messages]` and append a
   * `{"t":"compaction"}` marker. The append-only log is NOT rewritten — `firstKept` is the global
   * ordinal of the first kept message, and resume rebuilds the same shape from it. `keepCount` counts
   * real (kept) messages; the caller derives it from `pickCutPoint` (so kept never includes a prior
   * synthetic summary).
   */
  compact(summary: string, keepCount: number): void {
    const firstKept = this.totalMsgs - keepCount;
    const kept = this.messages.slice(this.messages.length - keepCount);
    this.messages.length = 0;
    this.messages.push(summaryMessage(summary), ...kept);
    this.writeLine({ t: "compaction", summary, firstKept });
  }

  /** Flush and close the JSONL sink. */
  close(): Promise<void> {
    return new Promise((resolve) => this.sink.end(resolve));
  }
}

/**
 * Read a session file into the live message list + the global `msg` count (D8/D17). `msg` lines are
 * the canonical conversation; `delta` lines are telemetry (ignored); a `compaction` line collapses
 * history — the LATEST one wins: `messages = [summary, …allMsgs.slice(firstKept)]`. `total` always
 * counts every `msg` line so the next compaction's ordinals line up.
 */
export function loadSession(path: string): { messages: Message[]; total: number } {
  if (!existsSync(path)) return { messages: [], total: 0 };
  const all: Message[] = [];
  let latest: { summary: string; firstKept: number } | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown> & { t?: string };
      if (o.t === "msg") {
        const { t, ...msg } = o;
        all.push(msg as unknown as Message);
      } else if (o.t === "compaction") {
        latest = { summary: String(o.summary ?? ""), firstKept: Number(o.firstKept ?? 0) };
      }
    } catch {
      // skip a malformed line rather than fail the whole resume
    }
  }
  const total = all.length;
  if (!latest) return { messages: all, total };
  return { messages: [summaryMessage(latest.summary), ...all.slice(latest.firstKept)], total };
}

/** Back-compat: just the rebuilt message list (see {@link loadSession}). */
export function loadMessages(path: string): Message[] {
  return loadSession(path).messages;
}
