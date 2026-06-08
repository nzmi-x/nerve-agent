// The one shared contract between the engine and the two providers (DeepSeek, Gemini).
// Each client maps its native wire format onto these types and shares nothing else.
// See docs/ARCHITECTURE_BRIEF.md §1 and docs/providers.md §0.
import type { Effort } from "../effort.ts";

/** A normalized streaming event — the only abstraction the loop, interceptors, and TUI see. */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; args: string; signature?: string }
  | { type: "usage"; input: number; output: number }
  | { type: "done"; reason: DoneReason }
  | { type: "error"; error: unknown };

export type DoneReason = "stop" | "length" | "tool_calls" | "safety" | "error";

/**
 * A tool the model invoked. `args` is a JSON *string* (accumulated from DeepSeek fragments, or a
 * stringified Gemini object). `signature` carries Gemini's opaque `thoughtSignature`, which must be
 * replayed on later turns or Gemini 400s (providers.md §2.6); DeepSeek leaves it undefined.
 */
export interface ToolCall {
  id: string;
  name: string;
  args: string;
  signature?: string;
}

export type Role = "system" | "user" | "assistant" | "tool";

/** A neutral conversation message. Each provider translates this into its native shape. */
export interface Message {
  role: Role;
  content: string;
  /** Present on assistant turns that called tools. */
  toolCalls?: ToolCall[];
  /** For `role: "tool"` results — matches the originating `ToolCall.id`. */
  toolCallId?: string;
  /** DeepSeek `reasoning_content`, stored so it can be replayed on tool-calling turns (providers.md §0). */
  reasoning?: string;
}

/** A tool declaration. `parameters` is a JSON Schema object, passed to both providers unchanged. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The neutral request a provider translates into its native body. */
export interface ProviderRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  temperature?: number;
  /** Thinking effort (D52). Provider-mapped: DeepSeek `reasoning_effort`/disable, Gemini `thinkingLevel`. */
  effort?: Effort;
  /** Inline image input (D53) — **request-scoped, never persisted**. Gemini attaches these as `inlineData`
   *  on the current user turn; DeepSeek (text-only) ignores them. */
  images?: ImageInput[];
}

/** A base64 inline image for a request (D53). `data` is base64-encoded bytes; `mimeType` e.g. `image/png`. */
export interface ImageInput {
  mimeType: string;
  data: string;
}

/** A provider speaks its API raw (fetch + SSE) and emits StreamEvents. Nothing else is shared. */
export interface Provider {
  readonly name: "gemini" | "deepseek";
  stream(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent>;
}
