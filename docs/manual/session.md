# session

**Status:** built (Phase 1; SQLite persistence D31)
**What:** the conversation accumulator + persistence. Folds `StreamEvent`s into the in-progress
assistant turn and persists the transcript as **rows in the per-project SQLite DB** (`bun:sqlite`).
**Code:** `src/session.ts` + `src/db.ts` (schema/connection) + `src/sessions.ts` (discovery/admin).
Tests: `tests/session.test.ts`, `tests/sessions.test.ts`. See [DECISIONS D8](../DECISIONS.md) / [D31](../DECISIONS.md).

**How it works:**
- `Session` holds `messages: Message[]` and an in-progress assistant buffer (text, reasoning,
  tool-call fragments keyed by index).
- `apply(ev)` folds an event: text/reasoning concatenate; `tool_call` fragments accumulate by index
  (id/name/signature captured on the first fragment, `args` strings concatenated).
- `commitAssistant()` finalizes the buffer into an assistant `Message` — **including the reasoning
  artifact** (`reasoning`, and each tool call's `signature`) needed to replay to the providers
  ([providers.md §0](../providers.md)) — appends it, INSERTs a `messages` row, and resets the buffer.
- **Persistence is SQLite** ([D31](../DECISIONS.md)) in `~/.nerve/projects/<slug>/nerve.db` (one DB per
  project, opened/migrated by `src/db.ts`, WAL): `sessions(id, title, created_at, updated_at)` +
  `messages(session_id, seq, role, content, reasoning, tool_calls, tool_call_id)` +
  `compactions(session_id, at, summary, first_kept)`. `addUser`/`commitAssistant`/`addToolResult` INSERT a
  row at the global ordinal `seq`; the `sessions` row is created **lazily** on the first write ([D27](../DECISIONS.md)).
  `loadSession(cwd, id)` rebuilds `messages` from the rows (ordered by `seq`) with the **latest**
  compaction applied — `messages = [summary, …allMsgs.slice(first_kept)]`. `tap(ev)` is a **no-op** —
  token-tap telemetry isn't persisted (a row per token would bloat the DB).
- **Compaction ([D17](../DECISIONS.md)).** `discardAssistant()` drops a failed in-progress turn (retry,
  [D15](../DECISIONS.md)). `compact(summary, keepCount)` replaces live context with
  `[summaryMessage, …last keepCount msgs]` and INSERTs a compaction marker — message rows are **never
  deleted**. `totalMsgs` is the global ordinal `first_kept` anchors against; a summary is *not* a row,
  so it doesn't advance it and kept messages keep their original ordinals across compactions.
- **Discovery/admin** (`src/sessions.ts`): `listSessions(cwd)` / `lastSessionId(cwd, exclude?)` /
  `sessionExists(cwd, id)` / `deleteSession(cwd, id)` are indexed queries; delete cascades via FK.

**How to change it:**
- A new message field → extend `Message` (in `providers/types.ts`) + a column in `messages` (and the
  INSERT/`toMessage` mapping); make sure `commitAssistant` carries it and the providers translate it.
  Keep the reasoning artifacts — dropping them breaks tool-calling turns (DeepSeek `reasoning_content`,
  Gemini `thoughtSignature`).
- Schema changes live in `src/db.ts` (additive `CREATE TABLE IF NOT EXISTS` / `ALTER`); the connection is
  cached per project, so it migrates once.

**Gotchas:**
- `close()` is a no-op now (writes are synchronous + committed) — kept async so callers don't change.
- `$NERVE_HOME` repoints the whole tree (incl. the DB) — tests set it per case for an isolated DB.
- `compact`'s `keepCount` counts **real** kept messages (from `pickCutPoint`) — never include a prior
  synthetic summary in it, or `first_kept` ordinals drift.
- Skills + config stay on the **filesystem**, not in the DB ([D31](../DECISIONS.md)) — SQLite is for state.

**See:** [ARCHITECTURE_BRIEF §6](../ARCHITECTURE_BRIEF.md) · [providers.md §0](../providers.md) · [compaction](compaction.md) · [loop](loop.md)
