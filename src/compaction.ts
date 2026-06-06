// Context maintenance (D17): lean compaction + tool-output pruning. Keeps long sessions usable
// without oh-my-pi's full tree/branch/handoff machine — we take the 20% that gives 80%. The pure
// pieces (cut-point, pruning, serialization, the summary message) live here and are unit-tested; the
// one impure piece, summarize(), drains a one-shot provider stream to text. Persistence is in
// session.ts (an append-only `{"t":"compaction"}` line — the log is never rewritten, D8).
import type { Message, Provider, ProviderRequest } from "./providers/types.ts";

/** Cheap token estimate (≈4 chars/token). Good enough to budget context; not billed against. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function msgTokens(m: Message): number {
  let n = estimateTokens(m.content) + estimateTokens(m.reasoning ?? "");
  for (const tc of m.toolCalls ?? []) n += estimateTokens(tc.name) + estimateTokens(tc.args);
  return n;
}

/**
 * The compaction boundary: the index of the first message to KEEP. Everything before it is
 * summarized. Walks back from the end keeping recent messages within `keepRecentTokens`, then snaps
 * the boundary to the start of a user turn so a `tool` result is never orphaned from its call. A
 * return of `0` means "nothing old enough to compact".
 */
export function pickCutPoint(messages: Message[], keepRecentTokens: number): number {
  let acc = 0;
  let cut = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += msgTokens(messages[i]!);
    if (acc > keepRecentTokens) {
      cut = i + 1;
      break;
    }
  }
  // snap to a user-turn boundary (kept region must START at a user message → no orphaned tool result)
  while (cut > 0 && messages[cut]?.role !== "user") cut--;
  return cut;
}

export interface PruneOptions {
  /** Protect the newest N tokens of tool output from pruning. */
  protectRecentTokens?: number;
  /** Don't bother truncating a result smaller than this. */
  minResultTokens?: number;
}

/**
 * Replace stale, large `tool` results with `[output truncated — N tokens]`, protecting the newest
 * `protectRecentTokens` and NEVER touching `read` results (their `LINE#HASH` anchors must stay valid
 * for `edit`, D3). Pure — returns a new array. This is a LIVE-context optimization only; the JSONL
 * log keeps full fidelity (append-only, D8), so a resume re-expands.
 */
export function pruneToolOutputs(messages: Message[], opts: PruneOptions = {}): { messages: Message[]; saved: number } {
  const protect = opts.protectRecentTokens ?? 40_000;
  const minResult = opts.minResultTokens ?? 20;
  const nameById = new Map<string, string>();
  for (const m of messages) for (const tc of m.toolCalls ?? []) nameById.set(tc.id, tc.name);

  const out = messages.slice();
  let acc = 0;
  let saved = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "tool") continue;
    const tok = estimateTokens(m.content);
    if (acc < protect) {
      acc += tok; // protect the newest tool output
      continue;
    }
    if (tok <= minResult) continue;
    if (m.toolCallId && nameById.get(m.toolCallId) === "read") continue; // D3: keep read anchors intact
    out[i] = { ...m, content: `[output truncated — ${tok} tokens]` };
    saved += tok;
  }
  return { messages: out, saved };
}

/** The summary, as the user-role context message injected at the head of a compacted conversation.
 *  MUST match what session resume reconstructs from a compaction line, so live == resumed. */
export function summaryMessage(summary: string): Message {
  return { role: "user", content: `[Summary of the earlier conversation so far, compacted to save context]\n\n${summary}` };
}

/** Render messages to plain text for the summarizer's input. */
export function serializeConversation(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "tool") lines.push(`[tool result]\n${m.content}`);
    else if (m.role === "assistant") {
      if (m.content) lines.push(`Assistant: ${m.content}`);
      for (const tc of m.toolCalls ?? []) lines.push(`Assistant called ${tc.name}(${tc.args})`);
    } else {
      lines.push(`${m.role[0]!.toUpperCase()}${m.role.slice(1)}: ${m.content}`);
    }
  }
  return lines.join("\n\n");
}

/**
 * One-shot summarization: drain a provider stream to text. `focus` lets the user steer what to keep.
 * Throws on a provider error so the caller can leave the session untouched.
 */
export async function summarize(
  provider: Provider,
  model: string,
  messages: Message[],
  system: string,
  focus: string,
  signal: AbortSignal,
): Promise<string> {
  const convo = serializeConversation(messages);
  const ask = focus.trim() ? `\n\nFocus the summary on: ${focus.trim()}` : "";
  const req: ProviderRequest = {
    model,
    system,
    messages: [{ role: "user", content: `<conversation>\n${convo}\n</conversation>${ask}` }],
    thinking: false,
  };
  let text = "";
  for await (const ev of provider.stream(req, signal)) {
    if (ev.type === "text") text += ev.delta;
    else if (ev.type === "error") throw ev.error instanceof Error ? ev.error : new Error(String(ev.error));
  }
  const out = text.trim();
  if (!out) throw new Error("summarizer returned no text");
  return out;
}
