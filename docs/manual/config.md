# config

**Status:** built (Phase 1)
**What:** loads the model catalog and resolves the active model + its provider. Keys come from `.env`.
**Code:** `src/config.ts` (tests: `tests/config.test.ts`). Boot wiring lives in `index.ts`.

**How it works:**
- `loadModels(path?)` reads the committed `config/models.json` (resolved against the install dir).
- `selectModel(models, id?)` picks by id, else the `default` entry, else the first.
- `selectSubagentModel(models)` picks the `subagent`-flagged entry (the cheap model the `task` subagent
  runs on, [D6](../DECISIONS.md)), else the default. Flag it in `models.json` (`"subagent": true`).
- `providerFor(entry)` returns the `Provider` and checks its key in `Bun.env`; both `deepseek` and
  `gemini` are wired now. `fallbacksFor(models, active)` builds the [D15](../DECISIONS.md) ladder from
  catalog entries after `active` that are usable (implemented provider + key present).
- `index.ts` (the kernel runner) boots: **`preflight()`** (exit if a required external dep — the shell
  or `git` — is missing on PATH; *optional* deps like a headless browser only **hint** via `optionalHints`,
  Fedora `dnf` — D55, shown in the TUI welcome / headless stderr) → `loadModels → selectModel → providerFor`, builds a `Session`
  (or resumes), reads `prompts/system.md`, and drives `loop` — one-shot with `-p "…"` or a stdin REPL,
  streaming to stdout (reasoning dimmed). Flags: `-p/--print`, `--model <id>`, `--mode plan|edit`
  (default edit), `--resume <id>|last`. `--resume last` = newest session by mtime (`src/sessions.ts`).
  Default thinking effort comes from each model's `effort` (D52); unset → `off` ([D11](../DECISIONS.md)).

**How to change it:**
- Add a model → edit `config/models.json` (+ its schema); no code change. Set its `effort`
  (off|low|medium|high|xhigh, per provider — DeepSeek off/high/xhigh, Gemini low/medium/high). Runtime:
  `/model` picks a model then its effort; `/effort` changes the current model's effort ([D52](../DECISIONS.md)).
- Wire a new provider → add it to the `PROVIDERS` map. Keys stay in `.env`, never in the catalog.
- LSP servers live in the parallel `config/lsp.json` (same pattern: committed catalog + schema, with a
  `~/.nerve/lsp.json` override, [D22](../DECISIONS.md)). See [lsp](lsp.md). The `Lsp` manager is created
  at boot (unless `--no-lsp`) and passed to tools via `ctx.lsp`.

**Gotchas:**
- The interactive OpenTUI front-end isn't built yet — `index.ts` is headless for now (the TUI is the
  next slice and will replace the REPL when stdin is a TTY).

**See:** [DECISIONS D5](../DECISIONS.md) · [providers](providers.md) · [loop](loop.md)
