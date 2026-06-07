// The conversation accumulator + SQLite persistence (D31). Folds StreamEvents into the in-progress
// assistant turn and persists each canonical message as a row in the per-project DB (src/db.ts),
// replacing the old append-only JSONL. Resume rebuilds the live message list from the rows + the latest
// compaction marker. The public API is unchanged, so loop.ts/surfaces are untouched. See
// ARCHITECTURE_BRIEF §6, DECISIONS D8/D17/D31, docs/manual/session.md.
import type { Database } from "bun:sqlite";
import { summaryMessage } from "./compaction.ts";
import { openDb } from "./db.ts";
import type { Message, StreamEvent, ToolCall } from "./providers/types.ts";

export interface SessionInit {
  id?: string;
  cwd?: string;
  /** Reload prior messages from the DB (for `--resume`). */
  resume?: boolean;
  /** In-memory only — never persisted (subagent sessions, D6). Accumulates `messages` but writes no rows. */
  ephemeral?: boolean;
}

interface ToolCallBuf {
  id?: string;
  name?: string;
  args: string;
  signature?: string;
}

interface MsgRow {
  role: string;
  content: string;
  reasoning: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
}

export class Session {
  readonly id: string;
  readonly messages: Message[] = [];
  title = ""; // a short agent-generated label, set once near the start of the session (D26)
  private readonly db: Database;
  private readonly ephemeral: boolean; // D6: subagent sessions accumulate in memory but persist nothing
  private started = false; // whether the `sessions` row exists — created lazily on the first write (D27)

  // Count of canonical messages ever written — the global ordinal compaction anchors against (D17).
  // A compacted summary is NOT a message, so it doesn't advance this; kept messages keep their ordinals.
  private totalMsgs = 0;

  // in-progress assistant turn
  private text = "";
  private reasoning = "";
  private readonly toolBufs = new Map<number, ToolCallBuf>();

  constructor(init: SessionInit = {}) {
    this.id = init.id ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.ephemeral = init.ephemeral ?? false;
    this.db = openDb(init.cwd);
    if (init.resume) {
      const loaded = load(this.db, this.id);
      this.messages.push(...loaded.messages);
      this.totalMsgs = loaded.total;
      this.title = loaded.title;
      this.started = loaded.exists;
    }
    // No `sessions` row is created here — only on the first write (D27), so opening the TUI without
    // sending anything leaves no empty session behind.
  }

  private ensureStarted(): void {
    if (this.started) return;
    const now = Date.now();
    this.db.query("INSERT OR IGNORE INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(this.id, this.title, now, now);
    this.started = true;
  }

  /** Persist one canonical message as a row at the current global ordinal, then bump it. */
  private insert(msg: Message): void {
    const seq = this.totalMsgs++;
    if (this.ephemeral) return; // in-memory only — `messages` already holds it
    this.ensureStarted();
    this.db
      .query("INSERT INTO messages(session_id, seq, role, content, reasoning, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(this.id, seq, msg.role, msg.content, msg.reasoning ?? null, msg.toolCalls ? JSON.stringify(msg.toolCalls) : null, msg.toolCallId ?? null);
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), this.id);
  }

  addUser(content: string): void {
    const msg: Message = { role: "user", content };
    this.messages.push(msg);
    this.insert(msg);
  }

  /** Token-tap telemetry is not persisted in the SQLite store — it was unused on resume (D31). No-op. */
  tap(_ev: StreamEvent): void {}

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
    this.insert(msg);
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
    this.insert(msg);
  }

  /**
   * Compaction (D17): replace live context with `[summary, …last keepCount messages]` and record a
   * compaction marker. The message rows are NOT deleted — `first_kept` is the global ordinal of the
   * first kept message, and resume rebuilds the same shape from it. `keepCount` counts real (kept)
   * messages; the caller derives it from `pickCutPoint` (so kept never includes a prior summary).
   */
  compact(summary: string, keepCount: number): void {
    const firstKept = this.totalMsgs - keepCount;
    const kept = this.messages.slice(this.messages.length - keepCount);
    this.messages.length = 0;
    this.messages.push(summaryMessage(summary), ...kept);
    if (this.ephemeral) return;
    this.ensureStarted();
    this.db.query("INSERT INTO compactions(session_id, at, summary, first_kept) VALUES (?, ?, ?, ?)").run(this.id, Date.now(), summary, firstKept);
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), this.id);
  }

  /** Set the session's short title (D26) — a column on the `sessions` row; latest wins on resume. */
  setTitle(title: string): void {
    this.title = title;
    if (this.ephemeral) return;
    this.ensureStarted();
    this.db.query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), this.id);
  }

  /** No-op: writes are synchronous and already committed. Kept async so callers don't change. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Rebuild a stored session from its rows: messages (latest compaction applied) + total ordinal + title. */
function load(db: Database, id: string): { messages: Message[]; total: number; title: string; exists: boolean } {
  const srow = db.query("SELECT title FROM sessions WHERE id = ?").get(id) as { title: string } | null;
  if (!srow) return { messages: [], total: 0, title: "", exists: false };
  const rows = db.query("SELECT role, content, reasoning, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY seq").all(id) as MsgRow[];
  const all = rows.map(toMessage);
  const comp = db.query("SELECT summary, first_kept FROM compactions WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(id) as { summary: string; first_kept: number } | null;
  const total = all.length;
  const messages = comp ? [summaryMessage(comp.summary), ...all.slice(comp.first_kept)] : all;
  return { messages, total, title: srow.title, exists: true };
}

function toMessage(r: MsgRow): Message {
  const m: Message = { role: r.role as Message["role"], content: r.content };
  if (r.reasoning) m.reasoning = r.reasoning;
  if (r.tool_calls) m.toolCalls = JSON.parse(r.tool_calls) as ToolCall[];
  if (r.tool_call_id) m.toolCallId = r.tool_call_id;
  return m;
}

/** Rebuild a stored session (messages + total ordinal + title), applying the latest compaction (D17). */
export function loadSession(cwd: string, id: string): { messages: Message[]; total: number; title: string } {
  const { messages, total, title } = load(openDb(cwd), id);
  return { messages, total, title };
}
