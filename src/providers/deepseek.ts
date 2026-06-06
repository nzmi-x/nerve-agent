// Raw DeepSeek client (OpenAI-shaped) → StreamEvent. Treated as DeepSeek-specific, not a reusable
// "OpenAI" base. Coded against the verified spec in docs/providers.md §1; see docs/manual/providers.md.
import { sse } from "../stream.ts";
import type { DoneReason, Provider, ProviderRequest, StreamEvent } from "./types.ts";

const ENDPOINT = "https://api.deepseek.com/chat/completions";

// --- request translation (pure, unit-tested) --------------------------------

/** Translate a neutral ProviderRequest into DeepSeek's chat/completions body. */
export function buildRequestBody(req: ProviderRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });

  for (const m of req.messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: m.content,
        // reasoning_content MUST be replayed on tool-calling turns (providers.md §1.6)
        ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        })),
      });
    } else if (m.role === "tool") {
      messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true }, // required for a usage chunk in-stream (§1.3)
  };

  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  // V4 defaults thinking ON; the kernel passes `thinking: false` for speed (D11). Only an explicit
  // value is sent. Thinking mode ignores temperature, so omit it then (§1.6).
  if (req.thinking === true) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = "high";
  } else if (req.thinking === false) {
    body.thinking = { type: "disabled" };
  }
  if (req.temperature !== undefined && req.thinking !== true) body.temperature = req.temperature;

  return body;
}

// --- wire → StreamEvent mapping (pure over the sse() output, unit-tested) ----

interface DSToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface DSChunk {
  choices?: {
    delta?: { content?: string; reasoning_content?: string; tool_calls?: DSToolCall[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function mapFinish(reason: string): DoneReason {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "safety";
    default:
      return "stop";
  }
}

/** Map DeepSeek SSE payloads to StreamEvents. `[DONE]` ends the stream; `done` is emitted last. */
export async function* mapStream(frames: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  let finish: DoneReason = "stop";
  for await (const data of frames) {
    if (data === "[DONE]") break;
    let chunk: DSChunk;
    try {
      chunk = JSON.parse(data) as DSChunk;
    } catch {
      continue; // defensively skip anything non-JSON (keep-alives are already filtered by sse())
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (delta.content) yield { type: "text", delta: delta.content };
      if (delta.reasoning_content) yield { type: "reasoning", delta: delta.reasoning_content };
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          yield {
            type: "tool_call",
            index: tc.index ?? 0,
            id: tc.id,
            name: tc.function?.name,
            args: tc.function?.arguments ?? "",
          };
        }
      }
    }
    if (choice?.finish_reason) finish = mapFinish(choice.finish_reason);
    if (chunk.usage) {
      yield { type: "usage", input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
    }
  }
  yield { type: "done", reason: finish };
}

// --- the provider -----------------------------------------------------------

export const deepseek: Provider = {
  name: "deepseek",
  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const key = Bun.env.DEEPSEEK_API_KEY;
    if (!key) {
      yield { type: "error", error: new Error("DEEPSEEK_API_KEY is not set") };
      yield { type: "done", reason: "error" };
      return;
    }

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(buildRequestBody(req)),
        signal,
      });
    } catch (error) {
      if (signal.aborted) return; // intentional ESC/stop-guard abort — stay quiet
      yield { type: "error", error };
      yield { type: "done", reason: "error" };
      return;
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      yield { type: "error", error: new Error(`DeepSeek ${res.status}: ${detail || res.statusText}`) };
      yield { type: "done", reason: "error" };
      return;
    }

    try {
      yield* mapStream(sse(res.body));
    } catch (error) {
      if (signal.aborted) return;
      yield { type: "error", error };
      yield { type: "done", reason: "error" };
    }
  },
};
