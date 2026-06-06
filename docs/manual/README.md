# docs/manual/ — nerve's operator manual

The pages the **`manual` tool** serves: nerve's own "how it works / how to change it" docs, read by
the agent (and you) before modifying a subsystem. See [DECISIONS.md D13](../DECISIONS.md).

- `manual()` → an auto-discovered topic index (every `*.md` here + the top-level `docs/*.md` +
  `opentui`).
- `manual("<topic>")` → that page. e.g. `manual("skills")`, `manual("hashline")`, `manual("opentui")`.
- The index is just the filesystem — **drop a `.md` here and it's a topic.** No registration.

## Page template (keep pages thin — pointers, not duplicated code)

```markdown
# <subsystem>
**Status:** built | spec (code lands in Phase N)
**What:** one line.
**Code:** `src/<file>.ts` (+ related)
**How it works:** 2–5 bullets.
**How to change it:** where to edit · what stays invariant · steps.
**Gotchas:** the traps.
**See:** [DECISIONS Dn](../DECISIONS.md) · [ARCHITECTURE_BRIEF §n](../ARCHITECTURE_BRIEF.md)
```

A page is a **thin pointer** to the authoritative code + decisions. Don't paste code into prose —
that's what rots. The rule ([AGENT_RULES §2](../AGENT_RULES.md)): **a subsystem change updates its
page in the same commit.** Pages are authored *alongside* their code, so the manual never runs ahead
of the implementation.

## Topic map (✓ = page exists; rest land with their subsystem in Phase 1/3)

| Topic | Subsystem | Code |
| --- | --- | --- |
| `tui` ✓ | terminal UI + how to reach the OpenTUI API | `src/tui/` |
| `skills` ✓ | Claude-compatible skills loading | `src/context.ts` |
| `opentui` | OpenTUI API reference (lazy, federated from the skill) | *(vendored `.claude/skills/opentui`)* |
| `providers` | DeepSeek/Gemini clients + the wire spec | `src/providers/` |
| `stream` | SSE reader + interceptor pipeline (the "nerve") | `src/stream.ts` |
| `interceptors` | the v1 interceptors + ordering | `src/interceptors.ts` |
| `hashline` | content-anchored edit format | `src/hashline.ts` |
| `tools` | the tool registry + the rent heuristic | `src/tools/` |
| `modes` | PLAN/EDIT dispatch + the human-only switch | `src/dispatch.ts` |
| `loop` | the re-entrant turn loop | `src/loop.ts` |
| `session` | accumulator + typed-line JSONL persistence | `src/session.ts` |
| `lsp` | language-server client + diagnostics | `src/lsp/` |
| `context` | CLAUDE.md layering + skills discovery | `src/context.ts` |
| `config` | `.env` keys + `config/*.json` loading | `src/config.ts` |

Top-level `docs/` (architecture, decisions, agent-rules, providers) are also reachable via the
`manual` tool by name — the manual is a single lookup over the whole corpus.
