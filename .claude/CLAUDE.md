# CLAUDE.md — operating guide for agents working on `nerve`

`nerve` is a lean, self-hackable **coding agent** for **Gemini and DeepSeek only**.
Before changing anything, read [AGENT_RULES.md](../docs/AGENT_RULES.md) (the non-negotiables),
[ARCHITECTURE_BRIEF.md](../docs/ARCHITECTURE_BRIEF.md) (how the pieces fit), and [DECISIONS.md](../docs/DECISIONS.md)
(what was decided and why). Keep the codebase small. **Record any new design decision in
DECISIONS.md** so it isn't re-litigated.

**Build strategy ([DECISIONS.md D11](../docs/DECISIONS.md)):** nerve is **self-hosted**. Claude Code
hand-builds the Phase-1 trustworthy kernel + all safety rails; then **nerve builds itself** (first
task: the Gemini provider), with Claude reviewing/rescuing. Never let nerve author its own
guardrails — the PLAN/EDIT boundary (the model can't change its own mode) and safe hot-reload are
hand-built and stay that way. `git init` is a prerequisite before nerve self-edits.

## Commands

```bash
bun install              # deps
bun run dev              # bun --watch index.ts — runs the TUI, restarts on change
bun run start            # bun index.ts — one-shot run
bun index.ts --resume last   # resume the most recent session (replays .nerve/sessions/<id>.jsonl)
bun run test             # bun test ./tests/ — our suite (scoped; references/ is NOT a test root)
bun test ./tests/stream.test.ts   # run one file
# NB: bare `bun test` scans the whole tree incl. references/ — always scope to ./tests/
bun run typecheck        # tsc --noEmit (no build step exists — Bun runs .ts directly)
```

Run `bun run typecheck` before declaring a change done. There is no compile/bundle step.

## Configuration

- **Keys** live in `.env` (gitignored): `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`. Read via `Bun.env`.
  Never move keys into `models.json` or any committed/agent-editable file.
- **Models** live in committed `config/models.json` (Bun imports JSON natively), validated by
  `config/models.schema.json` via an inline `$schema` ref (editor IntelliSense + validation). Entries are
  `{ id, provider, label?, default?, temperature?, thinking? }`. Add a model = add an entry, not code.
- **LSP servers** live in committed `config/lsp.json` (+ `config/lsp.schema.json`), mapping
  `extensions → { id, command, args, rootMarkers? }`. Add a language = add an entry; the `command`
  must already be on PATH (nerve doesn't install servers).
- Any config field you add must be reflected in its `*.schema.json` so the IntelliSense stays honest.
- **System prompt** is `prompts/system.md`, read fresh each turn (so it hot-swaps).
- **Claude-compat ([D12](../docs/DECISIONS.md)):** `src/context.ts` layers `CLAUDE.md` (`~/.claude` →
  `./.claude`/`./CLAUDE.md`, resolving `@imports`) onto the system prompt, and discovers skills from
  `~/.claude/skills` + `./.claude/skills`. nerve's own guide lives at `.claude/CLAUDE.md` (root
  `CLAUDE.md` is just an `@.claude/CLAUDE.md` import so Claude Code still loads it).

## Runtime behavior to respect

- **Two modes, human-only switch (`Shift+Tab`):** PLAN (read-only) and EDIT (all auto). Enforced in
  `src/dispatch.ts`. **Never** add a way for the model to change the mode (no `set_mode` tool, no
  model-writable flag). PLAN allows read tools + obviously-safe single-program bash only.
- **`edit` is hashline-only.** `read` emits `LINE#HASH:content`; edits anchor at hashes; a stale
  anchor hard-rejects with fresh anchors. Don't add a second edit tool or silent relocation.
- **Hot-swap seams:** `/reload` (and `Ctrl+R`) re-imports `src/tools/` + `src/interceptors.ts` via
  Bun cache-busted dynamic import, conversation preserved. Keep those modules re-import-safe (no
  top-level side effects that can't run twice). The engine (loop/providers/session) never swaps.
- **`ESC`** aborts the current streaming turn (provider `AbortSignal`); **`Ctrl+C`** exits.
- **`loop` stays a pure, re-entrant function over a session** — subagents (deferred) depend on it.
- **LSP (Phase 2):** `edit`/`write`/`read` append language-server diagnostics to their results; the
  `lsp` tool (definition/references/hover/symbols/…) is `readonly: true` and usable in PLAN. The
  client is **raw JSON-RPC over stdio, zero deps** — don't add an LSP library. Servers spawn lazily
  per language and are killed on exit.
- **Self-docs ([D13](../docs/DECISIONS.md)):** the `manual` tool (`readonly`, PLAN-safe) serves
  `docs/manual/*.md` + `docs/*.md` + the `opentui` skill (lazy). **When you change a subsystem,
  update its `docs/manual/<x>.md` page in the same commit** ([AGENT_RULES §2](../docs/AGENT_RULES.md)).
  Keep pages thin pointers. OpenTUI API is reached via `manual("opentui")`, never always-loaded.

## Runtime: Bun, not Node

- `bun <file>` to execute; never `node`, `ts-node`, `tsc` (typecheck only).
- `bun test` for tests; never jest/vitest. `bun install` / `bun run`; never npm/yarn/pnpm. `bunx` not `npx`.
- Bun auto-loads `.env` — **no `dotenv`**. Read keys via `Bun.env.GEMINI_API_KEY` / `process.env`.

### Use Bun's built-ins over npm packages
- `fetch` (global) for all provider HTTP + SSE streaming — no axios, no node-fetch.
- `Bun.file` / `Bun.write` for filesystem — prefer over `node:fs` for tool implementations.
- `Bun.$\`...\`` for shell — not execa/zx.
- `bun:sqlite` if persistence is ever needed — not better-sqlite3.
- `Bun.serve()` only if a control surface is ever exposed — not express. (This is a TUI; usually N/A.)

## UI: OpenTUI

- Engine is `@opentui/core` (imperative: `createCliRenderer`, `Box`, `Text`, `markdown`, `code`, `diff`, `scrollbox`, `input`). Factory functions: first arg props, rest children.
- Reference the OpenTUI skill before touching UI: `.claude/skills/opentui/SKILL.md` → `docs/**/*.mdx`.
- Default to the imperative core API. Only reach for a React/Solid binding if a screen genuinely needs reactive state — and justify it in the PR/commit.

## House style

- Strict TS, native ESM. Relative imports only — no path aliases, no barrel files.
- Small files with one job. If a file outgrows ~150 lines, it's probably two files.
- Discriminated unions over class hierarchies. Plain functions over services.
- Comment *why*, not *what*. Match the density of surrounding code.
- Don't add a dependency to do what Bun or ~30 lines of local code already does.
- New work that isn't trivially obvious gets a test in `tests/` (`bun:test`).

```ts
// tests/example.test.ts
import { test, expect } from "bun:test";
test("normalizes a delta", () => { expect(1).toBe(1); });
```
