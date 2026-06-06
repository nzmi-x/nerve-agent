# lsp

**Status:** built (Phase 1.5). Live-verified vs pyrefly + ruff (diagnostics, hover, documentSymbol,
missing-server hint). vtsls path verified for the missing case — `bun install -g @vtsls/language-server` to run it live.
**What:** Language-Server integration at two seams ([D10](../DECISIONS.md)): diagnostics appended to
`read`/`write`/`edit`, and a read-only `lsp` query tool. Raw JSON-RPC over stdio, **zero deps**.
**Code:** `src/lsp/client.ts` (one connection) · `src/lsp/manager.ts` (`Lsp`) · `src/lsp/format.ts`
(pure mappers) · `src/tools/lsp.ts` (the tool). Catalog: `config/lsp.json` (+ schema). Tests: `tests/lsp.test.ts`.

**How it works:**
- **Catalog** (`config/lsp.json`, or `~/.nerve/lsp.json` if present, [D22](../DECISIONS.md)): entries
  `{ id, extensions, command, args?, rootMarkers?, install? }`. **Multiple servers can share an
  extension** — Python = `pyrefly lsp` + `ruff server`.
- **`client.ts`** spawns the server (`Bun.spawn`), frames messages with `Content-Length` (byte-counted,
  parsed off the raw stdout stream), correlates request↔response by id, answers server→client requests
  (`workspace/configuration` → `{}`s) so it can't hang, syncs docs (`didOpen`/`didChange`, full-text),
  caches `publishDiagnostics` by URI, and captures the server's `capabilities`.
- **`manager.ts`** (`Lsp`): lazy-spawns the servers for a file's extension (root via `rootMarkers`
  walk-up), aggregates diagnostics from all (tagged by server id), and routes a query to the **first
  server that advertises the capability** (so ruff — no `definitionProvider` — is skipped for queries
  but still contributes diagnostics). `diagnostics(path, text, wait)` settles `SETTLE_MS` (write/edit)
  or returns cached (read). A missing binary → a one-time `install` hint, never a crash.
- **Seam 1 — diagnostics:** `read`/`write`/`edit` call `ctx.lsp.diagnostics(...)` and append the block
  (`server L:C severity: message [code]`). `read` passes `wait:false` (prime + report cached, no latency).
- **Seam 2 — the `lsp` tool:** `readonly` (PLAN-safe). ops: `definition`/`references`/`implementation`/
  `typeDefinition`/`hover`/`documentSymbol`/`workspaceSymbol`; 1-based `line`/`character` → 0-based for LSP.
- Created at boot (`index.ts`, passed via `ctx.lsp` / `TuiOptions.lsp`), stopped on exit. `--no-lsp` disables.

**How to change it:**
- **Add a language** = add an entry (or two) to `config/lsp.json` + a `LANGUAGE_ID` mapping in `manager.ts`.
  The server must be on PATH; set `install` so a missing one gives an actionable hint. (Rust/Zig: just add entries.)
- Tune diagnostics latency → `SETTLE_MS` in `manager.ts`. Map a new result shape → `format.ts` (tested).

**Gotchas:**
- nerve does **not** install servers (D10) — missing ones degrade to an install hint.
- **Ruff is diagnostics-only and never auto-formats** — auto-format on edit would stale hashline anchors
  ([D3](../DECISIONS.md)). `ruff format` stays an explicit `bash` action.
- First edit on a cold server (esp. vtsls' project load) may return partial diagnostics; later edits are complete.
- Live seams need the servers installed; the pure parts (`format.ts`, `findRoot`, `loadServers`) test offline.

**See:** [DECISIONS D10](../DECISIONS.md) · [tools](tools.md) · [modes](modes.md) · [config](config.md)
