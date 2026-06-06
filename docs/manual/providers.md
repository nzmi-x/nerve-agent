# providers

**Status:** deepseek built (Phase 1) · gemini pending (first self-hosted task, [D11](../DECISIONS.md))
**What:** the raw DeepSeek + Gemini clients that turn a neutral `ProviderRequest` into a stream of
`StreamEvent`s. Each talks to its API directly (`fetch` + `sse`) and shares nothing but the contract.
**Code:** `src/providers/types.ts` (contract) · `src/providers/deepseek.ts` · `src/providers/gemini.ts` (todo)
**Spec:** the verified wire details live in [docs/providers.md](../providers.md) — read it before editing a client.

**How it works (deepseek.ts):**
- `buildRequestBody(req)` — pure translation to DeepSeek's `chat/completions` body: prepends
  `system`, maps assistant tool-call turns (replaying `reasoning_content`), tool results
  (`role:"tool"`, `tool_call_id`), tools, and `thinking` (only when explicit; V4 defaults ON).
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
- Thinking mode ignores `temperature`; the client omits it then.
- Live end-to-end needs `DEEPSEEK_API_KEY` in `.env` — the pure functions don't.

**See:** [docs/providers.md](../providers.md) · [ARCHITECTURE_BRIEF §4](../ARCHITECTURE_BRIEF.md) · [stream](stream.md)
