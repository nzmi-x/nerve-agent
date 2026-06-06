# nerve

A bespoke, single-developer AI agent harness. Lean enough to hold in your head, transparent enough that the agent running *inside* it can safely refactor its own machinery mid-session.

> **nerve** — because the whole point is to *feel every token* as it streams, and to splice into the wire mid-thought.

## What this is (and isn't)

- **Not** a `claude-code` / `opencode` clone. No generic framework, no plugin marketplace, no provider zoo.
- **A personal coding agent.** Operates on the dir you launch it in — reads, edits, runs shell, iterates on code.
- **Self-hackable above all.** Every part is small, flat, and obvious so that a human *or the LLM in the loop* can **hot-swap a tool or an interceptor at runtime** (`/reload`, no restart) without spelunking. Launched inside this repo, the agent can edit its own harness.
- **Two providers, hardcoded:** **Google Gemini** and **DeepSeek**. Nothing else. No Anthropic, no OpenAI, no OpenRouter, no LangChain. The absence of an aggregator layer is a feature.
- **Bun-native, strict TypeScript, ESM only.** Zero legacy Node bloat.
- **OpenTUI** ([`@opentui/core`](https://github.com/sst/opentui)) for the terminal UI — imperative core API, no React layer unless a screen earns it.

If an abstraction doesn't pay rent today, it isn't here. The *why* of every choice lives in
[AGENT_RULES.md](docs/AGENT_RULES.md); the *what* (with rejected alternatives) in [DECISIONS.md](docs/DECISIONS.md).

## Defining features

- **The "nerve":** a synchronous, per-delta **interceptor pipeline** — splice into the model's
  output between tokens to observe, rewrite, drop, or `abort()` mid-stream. Ships with token-tap,
  live stop-guard, reasoning router, and secret redaction.
- **Hashline editing:** the only edit path. `read` tags each line `LINE#HASH:content`; edits point
  at hash anchors instead of retyping lines (fewer tokens), and a stale read is hard-rejected
  before it can corrupt a file. Zero deps (`Bun.hash`).
- **Two human-controlled modes:** **PLAN** (read-only — read tools + obviously-safe bash) and
  **EDIT** (everything auto). Switched only by you (`Shift+Tab`); the model can't escalate.
- **Hot-swap seams:** reload tools + interceptors live without losing the conversation.
- **Resumable sessions:** append-only JSONL transcripts you can replay and grep.
- **LSP code intelligence:** a raw, zero-dep Language Server client. `edit`/`write`/`read` append
  diagnostics so the agent self-corrects, and an `lsp` tool gives it definition/references/hover/
  symbols (read-only, so it works in PLAN mode). Seeded for TypeScript. *(Phase 2.)*
- **Claude-compatible:** loads `CLAUDE.md` (layered from `~/.claude` + project `./.claude` + root)
  into the system prompt, and discovers skills from `~/.claude/skills` + `./.claude/skills` — so your
  existing Claude ecosystem (like the bundled `opentui` skill) just works.
- **Self-documenting:** a `manual` tool serves nerve's own operator manual (`docs/manual/`) — the
  agent reads "how X works / how to change X" before it touches X. The OpenTUI API is federated in
  lazily (`manual("opentui")`), so our only dependency's docs cost context only when the UI is touched.

## Quick start

```bash
bun install
bun run dev          # bun --watch index.ts (restarts the TUI on change)
bun test             # bun:test
bun run typecheck    # tsc --noEmit
```

Configure keys and models — **keys in `.env`** (Bun loads it automatically — no dotenv),
**models in `config/models.json`** (schema-backed, so you get IntelliSense + validation while editing):

```sh
# .env  (gitignored)
GEMINI_API_KEY=...
DEEPSEEK_API_KEY=...
```

```jsonc
// config/models.json  (committed catalog — no secrets). The $schema ref drives editor IntelliSense.
{
  "$schema": "./models.schema.json",
  "models": [
    { "id": "deepseek-v4-flash", "provider": "deepseek", "default": true },
    { "id": "gemini-3.5-pro",    "provider": "gemini" }
  ]
}
```

## Proposed directory map (flat by design)

Phase 0 (this commit) establishes only context + config. Phase 1 fills `src/`. The target shape:

```
nerve/
├── index.ts             # boot: wire config → loop → TUI; --resume <id>|last
├── README.md
├── CLAUDE.md            # tiny: `@.claude/CLAUDE.md` import so Claude Code still loads the guide
├── .env                 # GEMINI_API_KEY / DEEPSEEK_API_KEY (gitignored)
├── .claude/             # Claude-compatible: CLAUDE.md + skills/ (also read by nerve at runtime)
│   ├── CLAUDE.md        # operational guide for agents working on this repo
│   └── skills/
├── config/             # committed runtime config (no secrets), $schema-backed for IntelliSense
│   ├── models.json      #   model catalog (id, provider, label, default)
│   ├── models.schema.json
│   ├── lsp.json         #   LSP server catalog (extensions → command)
│   └── lsp.schema.json
├── docs/                # design docs (read order: ARCHITECTURE_BRIEF → AGENT_RULES → DECISIONS)
│   ├── ARCHITECTURE_BRIEF.md
│   ├── AGENT_RULES.md
│   ├── DECISIONS.md
│   ├── providers.md     #   verified DeepSeek + Gemini wire spec
│   └── manual/          #   operator manual served by the `manual` tool (per-subsystem how-to-change)
├── prompts/
│   └── system.md        # the agent's system prompt — read fresh per turn (hot-swappable)
├── src/
│   ├── loop.ts          # pure, re-entrant agent loop (one turn = stream → tools → repeat)
│   ├── session.ts       # conversation state + append-only JSONL persistence
│   ├── stream.ts        # SSE line parser + the synchronous interceptor pipeline (the "nerve")
│   ├── interceptors.ts  # v1: token-tap, stop-guard, reasoning-router, secret-redaction (hot-swappable)
│   ├── dispatch.ts      # tool dispatcher + PLAN/EDIT mode gate (human-only switch)
│   ├── hashline.ts      # LINE#HASH anchoring via Bun.hash (powers read + edit)
│   ├── lsp/             # raw JSON-RPC LSP client (client.ts) + manager (index.ts) — Phase 2
│   ├── config.ts        # loads .env keys + config/models.json + config/lsp.json; active profile
│   ├── context.ts       # Claude-compat: discover + layer CLAUDE.md and skills (~/.claude + ./.claude)
│   ├── providers/
│   │   ├── types.ts     # StreamEvent union + Provider interface (the contract)
│   │   ├── gemini.ts    # raw Gemini streamGenerateContent client → StreamEvent
│   │   └── deepseek.ts  # raw DeepSeek (OpenAI-shaped) client → StreamEvent
│   ├── tools/           # one file per tool + registry.ts (read, write, edit, bash, grep, glob, ls, manual)
│   │   └── registry.ts
│   └── tui/
│       └── app.ts       # OpenTUI views: transcript, streaming md/diff, reasoning fold, status line
├── tests/               # bun:test, colocated by concern
└── src/paths.ts         # global-state layout (D22) — nerve writes NOTHING into the project dir
```

State lives under **`~/.nerve`** (not the project), namespaced like `~/.claude/projects` (D22):
`~/.nerve/projects/<cwd with / → ->/sessions/<id>.jsonl` for transcripts, plus global + per-project
`skills/` and `commands/`. So contribution repos stay clean. Override the root with `$NERVE_HOME`.

No barrels, no `utils/` junk drawer, no path aliases — relative imports keep the graph legible.

## Documents

- [docs/ARCHITECTURE_BRIEF.md](docs/ARCHITECTURE_BRIEF.md) — the streaming model, the normalized event contract, mid-token interception, hashline editing, modes, hot-swap, persistence, the local execution path.
- [docs/providers.md](docs/providers.md) — verified DeepSeek + Gemini wire spec (endpoints, streaming chunks, tool calls, thinking) mapped to `StreamEvent`. Ground truth for the provider clients.
- [docs/DECISIONS.md](docs/DECISIONS.md) — the standing decision log: every choice, its rationale, and the alternatives it beat.
- [docs/AGENT_RULES.md](docs/AGENT_RULES.md) — anti-redundancy mandate, self-hackability rules, the human-only safety boundaries, the strict two-provider scope.
- [.claude/CLAUDE.md](.claude/CLAUDE.md) — operational guidelines for an agent working *on* this repo (loaded via the root `CLAUDE.md` import).
