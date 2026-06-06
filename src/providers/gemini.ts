// Raw Gemini client (Gemini Developer API, API key — not Vertex) → StreamEvent. Coded against the
// verified spec in docs/providers.md §2; see docs/manual/providers.md. Shares the `sse()` reader with
// DeepSeek but speaks Gemini's own shape: `contents` (user/model roles), `systemInstruction`,
// `functionDeclarations`, and the strict `thoughtSignature` replay (a 400 if omitted on a tool turn).
import { sse } from "../stream.ts";
import type { DoneReason, Provider, ProviderRequest, StreamEvent } from "./types.ts";

const endpoint = (model: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

// --- request translation (pure, unit-tested) --------------------------------

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Translate a neutral ProviderRequest into Gemini's generateContent body. */
export function buildRequestBody(req: ProviderRequest): Record<string, unknown> {
  // tool results (role:"tool") only carry an id — recover the function name from the matching call.
  const nameById = new Map<string, string>();
  for (const m of req.messages) for (const tc of m.toolCalls ?? []) nameById.set(tc.id, tc.name);

  const contents: Record<string, unknown>[] = [];
  for (let i = 0; i < req.messages.length; ) {
    const m = req.messages[i]!;
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
      i++;
    } else if (m.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        const part: Record<string, unknown> = { functionCall: { name: tc.name, id: tc.id, args: parseArgs(tc.args) } };
        // MANDATORY on the first functionCall part of a tool turn (§2.6) — Session stores it only there.
        if (tc.signature) part.thoughtSignature = tc.signature;
        parts.push(part);
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      i++;
    } else if (m.role === "tool") {
      // Gemini wants ALL functionResponses for a step in ONE user turn (order: FC1+sig,FC2,FR1,FR2).
      const parts: Record<string, unknown>[] = [];
      while (i < req.messages.length && req.messages[i]!.role === "tool") {
        const t = req.messages[i]!;
        parts.push({
          functionResponse: { name: t.toolCallId ? nameById.get(t.toolCallId) ?? "" : "", id: t.toolCallId, response: { result: t.content } },
        });
        i++;
      }
      contents.push({ role: "user", parts });
    } else {
      i++; // no system role in contents — it goes to systemInstruction below
    }
  }

  const body: Record<string, unknown> = { contents };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }
  // 3.x uses thinkingLevel (replaces thinking_budget). thinking:false / absent → omit (model default).
  // Gemini 3.x: temperature/topP/topK are no longer recommended (§2.3) — we omit sampling params.
  if (req.thinking === true) body.generationConfig = { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } };

  return body;
}

// --- wire → StreamEvent mapping (pure over the sse() output, unit-tested) ----

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string; // tolerate snake_case (proto field name) too
  functionCall?: { name?: string; id?: string; args?: Record<string, unknown> };
}
interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function mapFinish(reason: string): DoneReason {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "safety";
    default:
      return "stop"; // STOP and anything else
  }
}

/** Map Gemini SSE payloads (each a complete GenerateContentResponse) to StreamEvents. */
export async function* mapStream(frames: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  let finish: DoneReason = "stop";
  let fcIndex = 0; // Gemini delivers each functionCall complete in one part — assign a running index
  let usage: { input: number; output: number } | null = null;

  for await (const data of frames) {
    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(data) as GeminiChunk;
    } catch {
      continue; // defensively skip non-JSON frames
    }
    const cand = chunk.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (part.functionCall) {
        const sig = part.thoughtSignature ?? part.thought_signature;
        yield {
          type: "tool_call",
          index: fcIndex++,
          id: part.functionCall.id,
          name: part.functionCall.name,
          args: JSON.stringify(part.functionCall.args ?? {}),
          ...(sig ? { signature: sig } : {}),
        };
      } else if (part.thought && part.text) {
        yield { type: "reasoning", delta: part.text };
      } else if (part.text) {
        yield { type: "text", delta: part.text };
      }
    }
    if (cand?.finishReason) finish = mapFinish(cand.finishReason);
    // usageMetadata can repeat (cumulative) across chunks — keep the latest, emit once at the end.
    if (chunk.usageMetadata) usage = { input: chunk.usageMetadata.promptTokenCount ?? 0, output: chunk.usageMetadata.candidatesTokenCount ?? 0 };
  }

  if (usage) yield { type: "usage", ...usage };
  yield { type: "done", reason: finish };
}

// --- the provider -----------------------------------------------------------

export const gemini: Provider = {
  name: "gemini",
  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const key = Bun.env.GEMINI_API_KEY;
    if (!key) {
      yield { type: "error", error: new Error("GEMINI_API_KEY is not set") };
      yield { type: "done", reason: "error" };
      return;
    }

    let res: Response;
    try {
      res = await fetch(endpoint(req.model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
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
      yield { type: "error", error: new Error(`Gemini ${res.status}: ${detail || res.statusText}`) };
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
