# providers

**Status:** deepseek + gemini both built (Phase 1.5); gemini live-verified 2026-06-07 incl. thoughtSignature replay.
**What:** the raw DeepSeek + Gemini clients that turn a neutral `ProviderRequest` into a stream of
`StreamEvent`s. Each talks to its API directly (`fetch` + `sse`) and shares nothing but the contract.
**Code:** `src/providers/types.ts` (contract) · `src/providers/deepseek.ts` · `src/providers/gemini.ts`
(tests: `tests/deepseek.test.ts`, `tests/gemini.test.ts`).
**Spec:** the verified wire details live in [docs/providers.md](../providers.md) — read it before editing a client.

**How it works (gemini.ts):**
- `buildRequestBody(req)` — pure translation to v1beta `generateContent`: user/assistant→`user`/`model`
  `contents`, `system`→`systemInstruction`, tools→`functionDeclarations`. An assistant tool turn becomes
  `model` parts with a `functionCall` per call (**`thoughtSignature` replayed on the first** — a 400 if
  omitted, §2.6); consecutive `tool` results merge into **one** `user` turn of `functionResponse` parts
  (`{name,id,response:{result}}`). Gemini 3.x: `effort`→`thinkingConfig.thinkingLevel` (low/medium/high; off
  or absent → omit, model default — D52); sampling params (temperature) omitted.
- `mapStream` — each SSE frame is a whole `GenerateContentResponse`; parts → text / reasoning
  (`thought:true`) / `tool_call` (complete in one part, running `index`; signature read camelCase
  `thoughtSignature` with a snake_case fallback). `usageMetadata` captured and emitted once at the end.

**How it works (deepseek.ts):**
- `buildRequestBody(req)` — pure translation to DeepSeek's `chat/completions` body: prepends
  `system`, maps assistant tool-call turns (replaying `reasoning_content`), tool results
  (`role:"tool"`, `tool_call_id`), tools, and `effort` → `reasoning_effort` high/xhigh or `thinking:disabled`
  (off); absent → omit, V4 defaults ON (D52).
- `mapStream(frames)` — pure: consumes `sse()` payloads, emits `text`/`reasoning`/`tool_call`/`usage`,
  and a single `done` at the end (`[DONE]` ends the stream). `finish_reason` maps to `DoneReason`.
- `deepseek.stream(req, signal)` — wires `fetch` → `sse` → `mapStream`; on `!res.ok` emits a raw
  `error` + `done:"error"`; on an intentional abort (`signal.aborted`) it returns silently.

**How to change it:**
- **Add a provider** = a new file exporting a `Provider` (`name` + `stream()`); map its wire format
  to `StreamEvent` and its request to its native body. Don't unify it with the others beyond the
  `Provider` interface ([AGENT_RULES §1](../AGENT_RULES.md)).
- **Wire change** (new field, new finish reason) → update the `DS*` shapes + `mapStream`/`mapFinish`,
  and reconcile [docs/providers.md](../providers.md) in the same commit.
- Keep request-building and wire-mapping **pure** (factored out of `stream`) so they stay unit-testable
  offline without a key — see `tests/deepseek.test.ts`.

**Gotchas:**
- `tool_call` events are **fragments** accumulated downstream by `index` — the client does not
  assemble `args` (the session does).
- `reasoning_content` on an assistant turn is **mandatory to replay** when that turn called tools.
- Thinking mode ignores `temperature`; both clients omit it then (Gemini omits it always, §2.3).
- Gemini's `thoughtSignature` is **mandatory** on the first `functionCall` of a tool turn — Session
  stores it on that call, `buildRequestBody` replays it. Drop it → HTTP 400.
- Live end-to-end needs `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` in `.env` — the pure functions don't.

**See:** [docs/providers.md](../providers.md) · [ARCHITECTURE_BRIEF §4](../ARCHITECTURE_BRIEF.md) · [stream](stream.md)
