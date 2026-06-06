# session

**Status:** built (Phase 1)
**What:** the conversation accumulator + persistence. Folds `StreamEvent`s into the in-progress
assistant turn and persists the transcript as typed-line JSONL.
**Code:** `src/session.ts` (tests: `tests/session.test.ts`). See [DECISIONS D8](../DECISIONS.md).

**How it works:**
- `Session` holds `messages: Message[]` and an in-progress assistant buffer (text, reasoning,
  tool-call fragments keyed by index).
- `apply(ev)` folds an event: text/reasoning concatenate; `tool_call` fragments accumulate by index
  (id/name/signature captured on the first fragment, `args` strings concatenated).
- `commitAssistant()` finalizes the buffer into an assistant `Message` — **including the reasoning
  artifact** (`reasoning`, and each tool call's `signature`) needed to replay to the providers
  ([providers.md §0](../providers.md)) — appends it, persists a `msg` line, and resets the buffer.
- Persistence is **typed JSONL** at `~/.nerve/projects/<slug>/sessions/<id>.jsonl`: `{"t":"msg",…}` canonical messages,
  `{"t":"delta",…}` token-tap telemetry, and `{"t":"compaction",summary,firstKept}` markers ([D17](../DECISIONS.md)).
  `tap(ev)` writes delta lines; `loadSession()` reads back the `msg` lines (deltas ignored) and applies
  the **latest** compaction marker — `messages = [summary, …allMsgs.slice(firstKept)]`.
- **Compaction ([D17](../DECISIONS.md)).** `discardAssistant()` drops a failed in-progress turn (retry,
  [D15](../DECISIONS.md)). `compact(summary, keepCount)` replaces live context with
  `[summaryMessage, …last keepCount msgs]` and appends a compaction marker — the log is **never
  rewritten**. `totalMsgs` is the global ordinal `firstKept` anchors against; a summary is *not* a `msg`
  line, so it doesn't advance it and kept messages keep their original ordinals across compactions.

**How to change it:**
- A new message field → extend `Message` (in `providers/types.ts`) and make sure `commitAssistant`
  carries it and the providers translate it. Keep the reasoning artifacts — dropping them breaks
  tool-calling turns (DeepSeek `reasoning_content`, Gemini `thoughtSignature`).
- Persistence is append-only via a write stream (`flags:"a"`); resume opens the same file and appends.

**Gotchas:**
- `close()` flushes the sink — call it on exit or the tail of the log can be lost.
- `loadSession`/`loadMessages` skip malformed lines rather than failing the whole resume.
- `compact`'s `keepCount` counts **real** kept messages (from `pickCutPoint`) — never include a prior
  synthetic summary in it, or `firstKept` ordinals drift.

**See:** [ARCHITECTURE_BRIEF §6](../ARCHITECTURE_BRIEF.md) · [providers.md §0](../providers.md) · [compaction](compaction.md) · [loop](loop.md)
