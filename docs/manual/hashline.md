# hashline

**Status:** built (Phase 1)
**What:** content-anchored line editing — the format behind `read`/`edit`. Lines are addressed by a
`LINE#HASH` anchor; a stale read diverges and is rejected before it can corrupt a file.
**Code:** `src/hashline.ts` (tests: `tests/hashline.test.ts`). The sole edit mechanism ([D3](../DECISIONS.md)).

**How it works:**
- `hashLine(content, lineNo)` → 2 chars from `ZPMQVRWSNKTXJBYH` (`Bun.hash`, no deps). Alphanumeric
  lines hash on content alone; punctuation-only lines seed from the line number so many `}` don't collide.
- `encode(content)` renders `LINE#HASH:content` with left-padded line numbers — what the `read` tool emits.
- `parseAnchor("11#KT")` → `{ line, hash }`.
- `applyEdits(content, edits)` validates **every** anchor against the *original* file, then applies
  bottom-up so line numbers don't shift across hunks. Edit ops: `replace` (`pos`, optional `end` for
  a range), `append` (after `pos`), `prepend` (before `pos`); `lines` is the replacement.
- **Stale → hard reject + re-anchor:** any hash mismatch (or out-of-range line) rejects the *whole*
  patch and returns `{ ok:false, error, anchors }`, where `anchors` is fresh `LINE#HASH:content` for
  the affected region (±1 line) so the model retries without a full re-read. No silent relocation.

**How to change it:**
- A new edit op → extend `HashOp` + the apply switch in `applyEdits`. Keep "validate-all-then-apply"
  and bottom-up application (the no-shift invariant). **Never** add fuzzy relocation on a stale anchor.
- The hash is intentionally short (2 chars / 256 values); the line number in the anchor disambiguates.
  Don't widen it without reason — fewer tokens is the point.

**Gotchas:**
- `read` and `edit` are coupled by this format — change the rendering in `encode` and the read tool
  together.
- Hashing strips a trailing `\r` (CRLF-agnostic) but is otherwise exact, so any real content change
  to an anchored line is detected.
- `applyEdits` assumes hunks don't overlap; overlapping ranges are not yet guarded (add if it bites).

**See:** [DECISIONS D3](../DECISIONS.md) · [providers.md (pi-hashline-edit format)](../providers.md) · [tools](README.md)
