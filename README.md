# Nerve Agent

**A personal, single-developer coding-agent harness.** Lean enough to hold in your head, transparent enough that the agent running *inside* it can safely refactor its own machinery mid-session.

> The CLI command is `nerve`. The "nerve" is the point: a synchronous, per-delta interceptor pipeline that lets you *feel every token* as it streams and splice into the wire mid-thought.

## This is a personal harness, not a product

I built this for **me** — my workflow, my taste, my two model providers. It is not a framework, not a startup, not something I maintain for users. No roadmap, no support, no stability promise, and plenty of opinionated choices you may disagree with.

**But it's public and MIT-licensed, so take it.** Fork it, rip out what you don't like, and make it *your own* nerve agent. The whole thing is deliberately small and flat so that's genuinely easy. If something here is useful to you, great; if you bend it into something better for yourself, even better. I just won't be running it as a project — issues and PRs may sit unanswered.

## What it is

A terminal coding agent for **Google Gemini** and **DeepSeek** — nothing else, on purpose. It works in the directory you launch it in: reads, edits, runs shell, iterates on code. Launched inside its own repo (or via the `self:` path prefix from anywhere), it can edit its own tools, prompts, and docs *while running*.

The guiding constraint: **if an abstraction doesn't pay rent *for me* today, it isn't here.** No MCP, no ACP, no A2A, no plugin marketplace, no provider aggregator, no multi-agent swarm — not because they're wrong, but because I haven't needed them. If you do, that's exactly what the fork button is for. The *why* of every choice lives in [DECISIONS.md](docs/DECISIONS.md).

## What makes it itself

- **The "nerve" — a mid-stream interceptor pipeline.** A synchronous, per-delta hook into the model's output: observe, rewrite, drop, or `abort()` *between tokens*. Ships with a token-tap, a live stop-guard, a reasoning router, and secret redaction.
- **Hashline editing — the only edit path.** `read` tags each line `LINE#HASH:content`; edits point at hash anchors instead of retyping lines (fewer tokens), and a stale read is hard-rejected before it can corrupt a file. Zero deps (`Bun.hash`).
- **Two human-controlled modes.** **PLAN** (read-only — read tools + obviously-safe bash) and **EDIT** (everything auto). Switched only by you (`Shift+Tab`); the model can't escalate its own permissions.
- **Self-hackable at runtime.** Tools and interceptors hot-swap live (`/reload`, no restart, conversation preserved); the system prompt is re-read each turn. The agent can rewrite its own harness and reload it.
- **Filesystem-discovered tools.** Drop a `Tool`-shaped file in `src/tools/` and it's registered — no wiring — and `/reload` picks it up live.
- **LSP code intelligence.** A raw, zero-dep Language Server client: `read`/`write`/`edit` append diagnostics so the agent self-corrects, and an `lsp` tool gives it definitions/references/hover/symbols (read-only, usable in PLAN).
- **Claude- / agents.md-compatible.** Loads `CLAUDE.md` + `AGENTS.md` as project memory (layered across the nerve/claude/agent ecosystem dirs, with the nearest file in your tree taking precedence), and discovers skills + slash-commands the same way — so an existing setup mostly just works.
- **SQLite-persisted, resumable sessions.** A per-project database under `~/.nerve`; `--resume last` picks up where you left off.
- **Self-documenting.** A `manual` tool serves the operator manual in `docs/manual/` — the agent reads "how X works / how to change X" before it touches X.

## Quick start

Needs [Bun](https://bun.sh) and an API key for at least one provider.

```bash
bun install
bun run dev          # bun --watch index.ts — runs the TUI, restarts on change
bun run build        # installs a `nerve` launcher to ~/.local/bin (a shim, not a compiled binary)
```

Keys live in `.env` (gitignored; Bun loads it automatically — no dotenv). Models live in a committed, schema-backed catalog:

```sh
# .env
GEMINI_API_KEY=...
DEEPSEEK_API_KEY=...
```

```jsonc
// config/models.json  (committed; no secrets). The $schema ref drives editor IntelliSense.
{
  "$schema": "./models.schema.json",
  "models": [
    { "id": "deepseek-v4-flash", "provider": "deepseek", "default": true },
    { "id": "gemini-3.5-pro",    "provider": "gemini" }
  ]
}
```

State lives under **`~/.nerve`** (never inside your project), namespaced per project — so the repos you work in stay clean. Override the root with `$NERVE_HOME`.

## Layout

Small files with one job each; relative imports only, no barrels or `utils/` junk drawer.

```
index.ts            boot: config → loop → TUI (or headless `-p "…"`, `--resume last`)
prompts/system.md   the agent's system prompt, re-read each turn (hot-swappable)
config/             committed model + LSP catalogs ($schema-backed)
src/
  loop.ts           pure, re-entrant agent turn loop
  stream.ts         SSE parse + the synchronous interceptor pipeline (the "nerve")
  interceptors.ts   token-tap, stop-guard, reasoning-router, secret-redaction (hot-swappable)
  dispatch.ts       tool dispatch + the PLAN/EDIT mode gate (human-only)
  hashline.ts       LINE#HASH anchoring via Bun.hash (powers read + edit)
  session.ts        conversation state + bun:sqlite persistence
  context.ts        loads CLAUDE.md / AGENTS.md as project memory
  providers/        raw Gemini + DeepSeek streaming clients → a normalized StreamEvent
  tools/            one file per tool, filesystem-discovered by registry.ts
  lsp/              raw JSON-RPC Language Server client (zero deps)
  tui/              the OpenTUI terminal UI
docs/               design docs + the manual/ served by the `manual` tool
```

## Docs

- [docs/DECISIONS.md](docs/DECISIONS.md) — the standing decision log: every choice, why it won, and what it beat. The best map of *why this is the way it is.*
- [docs/ARCHITECTURE_BRIEF.md](docs/ARCHITECTURE_BRIEF.md) — how the pieces fit (streaming, interception, hashline, modes, hot-swap, persistence).
- [docs/AGENT_RULES.md](docs/AGENT_RULES.md) — the non-negotiables (anti-redundancy, self-hackability, the human-only safety boundaries, the two-provider scope).
- [docs/providers.md](docs/providers.md) — the verified DeepSeek + Gemini wire spec, mapped to `StreamEvent`.

## Built with

[Bun](https://bun.sh) (runtime, test runner, sqlite, shell), strict TypeScript, ESM only, and [OpenTUI](https://github.com/sst/opentui) for the terminal UI. No other runtime dependencies of note — the absence of an aggregator/framework layer is a feature.

## License

[MIT](LICENSE) © 2026 Nazmi Maizan. Fork freely; make it your own.
