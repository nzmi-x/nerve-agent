# docs/providers.md

Implementation reference for the **only two providers nerve supports: DeepSeek and Gemini**.
This is the ground-truth spec the `src/providers/*` clients are coded against — including by **nerve
itself**, since the Gemini provider is its first self-hosted task ([DECISIONS.md D11](DECISIONS.md)).
Each client talks to its API **raw** (Bun `fetch` + SSE), maps the native wire format onto the
internal `StreamEvent` union, and shares nothing else (see [ARCHITECTURE_BRIEF.md §1, §4](ARCHITECTURE_BRIEF.md)).

> **Verified:** 2026-06-06 against the official docs (full URL list at the bottom). Field names are
> quoted to match the wire. Items marked **⚠ confirm** are unverified and must be checked when the
> client is implemented.

---

## 0. The internal contract (what both clients emit)

```ts
type StreamEvent =
  | { type: "text";      delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; args: string; signature?: string } // args = JSON *string* accumulated by index; signature = Gemini thoughtSignature (§2.6)
  | { type: "usage";     input: number; output: number }
  | { type: "done";      reason: "stop" | "length" | "tool_calls" | "safety" | "error" }
  | { type: "error";     error: unknown };
```

`ProviderRequest` (neutral) carries: `system` text, `messages[]`, declared `tools[]` (JSON Schema),
`model`, `temperature?`, `thinking?`. Keys come from `.env` via `Bun.env`
(`DEEPSEEK_API_KEY`, `GEMINI_API_KEY`); model ids from `config/models.json`.

### ⚠ Cross-cutting rule both providers impose: **store & replay reasoning artifacts**
Both APIs are **stateless** (you resend the full history each turn) AND both require, on
tool-calling turns, that the model's *own reasoning artifact* from the prior assistant turn be sent
back verbatim:
- **DeepSeek:** the assistant turn's **`reasoning_content`** must be replayed when that turn made tool
  calls (§1.6).
- **Gemini:** the **`thoughtSignature`** must ride on the `functionCall` part it came on, or you get a
  **400** (§2.6).

→ **`session` must store these on the assistant message**, not drop them after rendering. This is the
single most important provider constraint on the session model. (See [ARCHITECTURE_BRIEF.md §6](ARCHITECTURE_BRIEF.md).)

---

## 1. DeepSeek (`src/providers/deepseek.ts`)

OpenAI-compatible. Treat it as DeepSeek-specific, **not** a reusable "OpenAI" base.

### 1.1 Endpoint & auth
```
POST https://api.deepseek.com/chat/completions
Authorization: Bearer $DEEPSEEK_API_KEY
Content-Type: application/json
```
Base `https://api.deepseek.com` (`/beta` only for beta features nerve doesn't use). **Stateless** —
resend the full `messages[]` every request.

### 1.2 Models
- `deepseek-v4-flash` — default; concurrency limit **2500**.
- `deepseek-v4-pro` — harder tasks; concurrency limit **500**.
- Legacy `deepseek-chat`/`deepseek-reasoner` **deprecated 2026-07-24** — don't use; thinking is a param now.

### 1.3 Request body
```jsonc
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system",    "content": "..." },
    { "role": "user",      "content": "..." },
    // assistant turn that called tools — MUST replay reasoning_content + tool_calls (§1.6):
    { "role": "assistant", "content": "", "reasoning_content": "<prior CoT>", "tool_calls": [
      { "id": "call_abc", "type": "function", "function": { "name": "edit", "arguments": "{...}" } } ] },
    { "role": "tool",      "tool_call_id": "call_abc", "content": "<tool result>" }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },         // REQUIRED for a usage chunk in-stream
  "tools": [ { "type": "function", "function": { "name": "...", "description": "...", "parameters": { /* JSON Schema */ } } } ],
  "tool_choice": "auto",                                // "none" | "auto" | "required" | {type:"function",function:{name}}
  "max_tokens": 8192,                                   // default 32K, max 64K (INCLUDES chain-of-thought)
  "thinking": { "type": "disabled" },                  // ⚠ DEFAULT IS "enabled" — set "disabled" for fast/no-CoT
  "reasoning_effort": "high"                            // "high" | "max"  (low/medium→high, xhigh→max). Only with thinking enabled.
  // temperature/top_p ONLY when thinking is disabled (see §1.6)
}
```

### 1.4 Streaming response — SSE frames `data: {chunk}`, terminated by `data: [DONE]`
```jsonc
{
  "choices": [{
    "index": 0,
    "delta": {
      "content": "answer piece",            // → text
      "reasoning_content": "CoT piece",      // → reasoning
      "tool_calls": [{
        "index": 0,                          // accumulate by THIS index
        "id": "call_abc",                    // first fragment of each call
        "type": "function",
        "function": { "name": "edit", "arguments": "{\"pa" }  // arguments = JSON STRING, streamed in pieces
      }]
    },
    "finish_reason": null                     // → "stop" | "length" | "tool_calls" | "content_filter"
  }],
  "usage": null                               // populated only on the final usage chunk
}
```
Final usage chunk: `usage: { prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens,
prompt_cache_miss_tokens, completion_tokens_details: { reasoning_tokens } }`.

### 1.5 ⚠ SSE parser requirement (both providers share `sse()` in `src/stream.ts`)
Under load DeepSeek keeps the connection alive by sending **SSE comment lines** (`: keep-alive`) for
streaming and **empty lines** for non-streaming. The parser **must skip lines starting with `:` and
blank lines** and not treat them as data. The server closes the connection if inference hasn't
started within **10 minutes**.

### 1.6 Thinking + tools (both resolved ✅)
- **Thinking defaults to `enabled` on V4.** To go fast/no-CoT, explicitly send `thinking:{type:"disabled"}`.
- **Tools work with thinking on.** BUT: on any turn where the assistant made tool calls, the
  **`reasoning_content` of that assistant turn must be passed back** in the replayed history (it's
  optional for plain multi-turn, **required** for tool-calling turns). Store it on the assistant message.
- Thinking mode **ignores** `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` (no error,
  no effect). Only send sampling params when thinking is disabled.

### 1.7 Context caching, errors, limits
- **KV cache is automatic** (on-disk, no config). `usage.prompt_cache_hit_tokens` /
  `prompt_cache_miss_tokens` report it. Cache hits need a **full prefix match** — keep a stable
  prefix (system + early history), append rather than reorder, to maximize hits.
- **Errors:** `400` bad format · `401` bad key · `402` insufficient balance · `422` invalid params ·
  `429` rate/concurrency · `500` server · `503` overloaded. → **Fix** 400/401/402/422; **retry w/ backoff**
  429/500/503. Per [AGENT_RULES §4](AGENT_RULES.md) surface these raw; don't silently auto-retry forever.
- **Rate limits** are concurrency-based (above); exceeding → `429`.

### 1.8 Mapping → StreamEvent
| Wire | StreamEvent |
| --- | --- |
| `delta.content` | `{ type:"text", delta }` |
| `delta.reasoning_content` | `{ type:"reasoning", delta }` |
| `delta.tool_calls[i]` | `{ type:"tool_call", index:i, id, name, args:<fragment> }` (concat by `index`, `JSON.parse` at end) |
| final `usage` | `{ type:"usage", input:prompt_tokens, output:completion_tokens }` |
| `finish_reason` | `{ type:"done", reason }` (`content_filter`→`safety`) |
| `[DONE]` | end of generator |

---

## 2. Gemini (`src/providers/gemini.ts`) — Gemini Developer API (API key, not Vertex)

### 2.1 Endpoint & auth
```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
x-goog-api-key: $GEMINI_API_KEY
Content-Type: application/json
```
`alt=sse` is **required** for real token SSE (else a single streamed JSON array). Use `--no-buffer`
when testing with curl. **Stateless** — resend full `contents[]` each turn.

### 2.2 Models (verified 2026-06-06) + default thinking level
| `config/models.json` id | status | default `thinkingLevel` |
| --- | --- | --- |
| `gemini-3.5-flash` | **GA** | `medium` |
| `gemini-3.1-pro-preview` | preview (**current Pro tier**) | `high` |
| `gemini-3.1-flash-preview` | preview | — |
| `gemini-3.1-flash-lite` | GA | `minimal` |
| `gemini-3.5-pro` | **does NOT exist yet** (expected later) | — |

⚠ **Catalog fix:** `gemini-3.5-pro` in `config/models.json` will 404 — the working Pro today is
**`gemini-3.1-pro-preview`** (added to the catalog; keep `gemini-3.5-pro` only as a future placeholder).
Context window: **1M+ tokens**.

### 2.3 Request body
```jsonc
{
  "contents": [
    { "role": "user",  "parts": [ { "text": "..." } ] },
    // assistant turn that called a tool — MUST carry the thoughtSignature on the functionCall part (§2.6):
    { "role": "model", "parts": [ { "functionCall": { "name": "edit", "args": {/*obj*/}, "id": "fc_1" }, "thoughtSignature": "<sig>" } ] },
    { "role": "user",  "parts": [ { "functionResponse": { "name": "edit", "id": "fc_1", "response": {/*result*/} } } ] }
  ],
  "systemInstruction": { "parts": [ { "text": "..." } ] },     // text only; no system role in contents
  "tools": [ { "functionDeclarations": [ { "name": "...", "description": "...", "parameters": { /* JSON Schema subset */ } } ] } ],
  "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } }, // AUTO(default) | ANY | VALIDATED | NONE  (+ allowedFunctionNames[])
  "generationConfig": {
    "maxOutputTokens": 8192,
    "thinkingConfig": { "thinkingLevel": "high", "includeThoughts": true } // 3.x uses thinkingLevel (replaces thinking_budget)
    // ⚠ For Gemini 3.5, temperature/topP/topK are "no longer recommended" — omit them.
  }
}
```
- Roles are `user` and `model` (assistant = `model`). No system role — use `systemInstruction`.
- `thinkingLevel` ∈ `minimal|low|medium|high`; `includeThoughts:true` streams rolling thought summaries.
  `config/models.json` `thinking:true` → `{ thinkingLevel:"high", includeThoughts:true }`; `false` → omit.

### 2.4 Streaming response — SSE frames `data: {GenerateContentResponse}`, **no `[DONE]` sentinel** (stream just ends)
```jsonc
{
  "candidates": [{
    "content": { "role": "model", "parts": [
      { "text": "answer piece" },                                   // → text
      { "text": "reasoning summary", "thought": true },             // → reasoning
      { "functionCall": { "name": "edit", "args": {/*COMPLETE obj*/}, "id": "fc_1" }, "thoughtSignature": "<sig>" } // → tool_call (whole, one part)
    ] },
    "finishReason": "STOP"   // STOP | MAX_TOKENS | SAFETY | RECITATION | ...
  }],
  "usageMetadata": { "promptTokenCount": 0, "candidatesTokenCount": 0, "thoughtsTokenCount": 0, "cachedContentTokenCount": 0, "totalTokenCount": 0 }
}
```

### 2.5 Function calling
- `functionDeclarations[]`: `name`, `description`, `parameters` (JSON-Schema/OpenAPI subset:
  string/number/integer/boolean/object/array + enum/required/description). Same schema feeds DeepSeek unchanged.
- Response `functionCall`: `{ name, id, args:object }` — **`id` is always present in Gemini 3 and must be echoed.**
- Send result as a **`user`** part: `functionResponse: { name, id, response }` — include **both** `id`
  **and** `name` matching the call (3.5 migration explicitly requires `name` too).
- **Parallel calls:** multiple `functionCall` parts in one response; map results by `id`, order-independent.

### 2.6 ⚠ thoughtSignature — strict, and a 400 if you get it wrong
Encrypted reasoning context returned on parts. Rules:
- **On `functionCall` parts it is MANDATORY to echo back.** The **first** `functionCall` part in **each
  step** of the current turn must include its `thoughtSignature` in the exact part it arrived on.
  Omitting → **HTTP 400** (`Function call FC1 ... is missing a thought_signature`).
- **Parallel calls:** the signature is attached to the **first** functionCall part **only**; preserve it
  there, omit from the others. Wrong interleaving (`FC1+sig, FR1, FC2, FR2`) errors — correct order is
  `FC1+sig, FC2, FR1, FR2`.
- May also appear on the final **text** part; replaying those is **recommended** (not enforced; omitting degrades quality).
- ✅ **Field casing resolved (live-verified 2026-06-07):** the v1beta REST stream uses **`thoughtSignature`**
  (camelCase); `thought_signature` (snake_case) only appears in the OpenAI-compat layer. `gemini.ts`
  **writes** camelCase and **reads** `thoughtSignature ?? thought_signature` for safety. End-to-end tool
  call + replay confirmed (no 400) against `gemini-3.5-flash`.

### 2.7 Structured output (optional; tools usually suffice)
`generationConfig.responseMimeType:"application/json"` + `responseSchema` (or `responseJsonSchema`).
Composable with function calling. nerve relies on tool calls for structure, so this is optional.

### 2.8 Mapping → StreamEvent
| Wire | StreamEvent |
| --- | --- |
| part `{ text }` (no `thought`) | `{ type:"text", delta:text }` |
| part `{ text, thought:true }` | `{ type:"reasoning", delta:text }` |
| part `{ functionCall:{name,args,id} }` (+`thoughtSignature`) | `{ type:"tool_call", index:n, id, name, args:JSON.stringify(args) }` — complete in one event; **stash the signature on the session msg** |
| `usageMetadata` | `{ type:"usage", input:promptTokenCount, output:candidatesTokenCount }` |
| `finishReason` | `{ type:"done", reason }` (`STOP`→`stop`, `MAX_TOKENS`→`length`, `SAFETY`/`RECITATION`→`safety`) |

---

## 3. `config/models.json` `thinking` → per-provider translation
| `models.json` | DeepSeek | Gemini 3.x |
| --- | --- | --- |
| `thinking: true` | `thinking:{type:"enabled"}` + `reasoning_effort:"high"` | `thinkingConfig:{thinkingLevel:"high", includeThoughts:true}` |
| `thinking: false` | `thinking:{type:"disabled"}` (then sampling params OK) | omit `thinkingConfig` (model default applies) |
| *absent* | DeepSeek default = **enabled** ⚠ | Gemini model default (flash=medium, pro=high) |

## 4. Shared notes
- One `sse()` reader serves both: split on blank lines, strip `data: `, **skip `:`-comment lines**
  (§1.5). DeepSeek ends with `data: [DONE]`; Gemini just ends the stream.
- Both **stateless** → resend full history; both need **reasoning-artifact replay** on tool turns (§0).
- Tool **JSON Schema** authored once per tool, passed through unchanged to both (`function.parameters`
  / `functionDeclarations[].parameters`). Keep schemas to the common subset.
- Reasoning deltas (`reasoning_content` / `thought:true`) → `StreamEvent{type:"reasoning"}` →
  reasoning-router interceptor → dimmed/foldable TUI region.

## 5. Open items to confirm empirically (promote to DECISIONS.md when resolved)
1. ✅ **Resolved (2026-06-07).** Gemini wire key is **`thoughtSignature`** (camelCase) on the v1beta REST
   stream; `gemini.ts` writes camelCase, reads either. Full tool-call + signature replay verified live.
2. `gemini-3.5-pro` exact id + availability once released (use `gemini-3.1-pro-preview` until then).
3. DeepSeek streaming `tool_calls` fragment shape under real load (the guide showed non-streaming);
   verify args arrive incrementally by `index` as the API ref implies.
4. Whether to default the agent loop to `thinking` on or off per profile (latency vs. quality).

## Sources (verified 2026-06-06)
- DeepSeek: [create-chat-completion](https://api-docs.deepseek.com/api/create-chat-completion) ·
  [thinking_mode](https://api-docs.deepseek.com/guides/thinking_mode) ·
  [tool_calls](https://api-docs.deepseek.com/guides/tool_calls) ·
  [multi_round_chat](https://api-docs.deepseek.com/guides/multi_round_chat) ·
  [json_mode](https://api-docs.deepseek.com/guides/json_mode) ·
  [kv_cache](https://api-docs.deepseek.com/guides/kv_cache) ·
  [error_codes](https://api-docs.deepseek.com/quick_start/error_codes) ·
  [rate_limit](https://api-docs.deepseek.com/quick_start/rate_limit)
- Gemini: [text-generation](https://ai.google.dev/gemini-api/docs/text-generation) ·
  [function-calling](https://ai.google.dev/gemini-api/docs/function-calling) ·
  [thinking](https://ai.google.dev/gemini-api/docs/thinking) ·
  [thought-signatures](https://ai.google.dev/gemini-api/docs/thought-signatures) ·
  [structured-output](https://ai.google.dev/gemini-api/docs/structured-output) ·
  [models](https://ai.google.dev/gemini-api/docs/models) ·
  [whats-new-3.5](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5) ·
  [long-context](https://ai.google.dev/gemini-api/docs/long-context)
