# config

**Status:** built (Phase 1)
**What:** loads the model catalog and resolves the active model + its provider. Keys come from `.env`.
**Code:** `src/config.ts` (tests: `tests/config.test.ts`). Boot wiring lives in `index.ts`.

**How it works:**
- `loadModels(path?)` reads the committed `config/models.json` (resolved against the install dir).
- `selectModel(models, id?)` picks by id, else the `default` entry, else the first.
- `providerFor(entry)` returns the `Provider` and checks its key in `Bun.env` — `deepseek` is wired;
  `gemini` is `null` (nerve's first self-hosted task, [D11](../DECISIONS.md)) and throws a clear error.
- `index.ts` (the kernel runner) boots: `loadModels → selectModel → providerFor`, builds a `Session`
  (or resumes), reads `prompts/system.md`, and drives `loop` — one-shot with `-p "…"` or a stdin REPL,
  streaming to stdout (reasoning dimmed). Flags: `-p/--print`, `--model <id>`, `--mode plan|yolo`
  (default yolo), `--resume <id>|last`. Kernel default: `thinking` off ([D11](../DECISIONS.md)).

**How to change it:**
- Add a model → edit `config/models.json` (+ its schema); no code change.
- Wire a new provider → add it to the `PROVIDERS` map. Keys stay in `.env`, never in the catalog.

**Gotchas:**
- The interactive OpenTUI front-end isn't built yet — `index.ts` is headless for now (the TUI is the
  next slice and will replace the REPL when stdin is a TTY).

**See:** [DECISIONS D5](../DECISIONS.md) · [providers](providers.md) · [loop](loop.md)
