# compaction

**Status:** built (Phase 1.5). `/compact` + pruning + resume work; the summary call wants a live-model
verify pass. Auto-threshold trigger is deferred.
**What:** context maintenance — summarize old turns into one message so long sessions stay under the
window, plus tool-output pruning. The lean 20% of oh-my-pi's machine (no tree/branch/handoff).
**Code:** `src/compaction.ts` (pure core, tested in `tests/compaction.test.ts`) + `Session.compact`
(persistence) + `compact()` in `src/tui/app.ts` (the `/compact` command). See [DECISIONS D17](../DECISIONS.md).

**How it works:**
- **`/compact [focus]`** (TUI): `pickCutPoint(messages, keepRecentTokens)` finds the boundary — walk
  back from the end keeping ~20k recent tokens, then **snap to a user turn** so a `tool` result is
  never orphaned from its call. Everything before the cut is summarized; from it on is kept.
- `pruneToolOutputs(...)` shrinks the **summarizer's input** (and is available for live context):
  stale large `tool` results become `[output truncated — N tokens]`, protecting the newest ~40k and
  **never** touching `read` results (their `LINE#HASH` anchors must stay valid for `edit`, [D3](../DECISIONS.md)).
- `summarize(provider, model, messages, system, focus, signal)` drains a one-shot provider stream to
  text using `prompts/compaction.md`. ESC cancels (the command shares `turnAbort`).
- `Session.compact(summary, keepCount)` swaps live context to `[summaryMessage, …kept]` and appends a
  `{"t":"compaction",summary,firstKept}` line. **Append-only — the log is never rewritten** ([D8](../DECISIONS.md)).
  Resume (`loadSession`) replays it: latest marker → `[summary, …allMsgs.slice(firstKept)]`.
- Pruning is a **live optimization, not persisted** — the JSONL keeps full fidelity, so a resume
  re-expands truncated outputs.

**How to change it:**
- Tune what's kept → `KEEP_TOKENS` in `app.ts` (passed to `pickCutPoint`).
- Change the summary's content → edit `prompts/compaction.md` (read fresh; no code change).
- Add an **auto-threshold** trigger → call the same `compact()` path from the loop after a turn whose
  measured context exceeds a threshold (deferred; keep it off the hot per-delta path).

**Gotchas:**
- The summary call is a real model round-trip — verify in a live session; the pure cut/prune/rebuild
  are unit-tested but the summary text quality is not.
- `keepCount` must count only real kept messages (`messages.length - cut`), never a prior synthetic
  summary, or `firstKept` ordinals drift on a second compaction.
- Context overflow is **not** a retry case ([D15](../DECISIONS.md)) — it routes here.

**See:** [DECISIONS D17](../DECISIONS.md) · [session](session.md) · [loop](loop.md) · [providers.md §0](../providers.md)
