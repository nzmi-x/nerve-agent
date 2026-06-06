# tui

**Status:** built (Phase 1) — minimal. Markdown/diff rendering is a future refinement.
**What:** the interactive terminal UI — a streaming transcript, a status line, and an input.
**Code:** `src/tui/app.ts` (`runTui`), launched by `index.ts` when stdin is a TTY.

**How it works:**
- OpenTUI **imperative core** (`@opentui/core`): a root column `BoxRenderable` holding a
  `ScrollBoxRenderable` transcript (`stickyScroll: bottom` — auto-pins to newest), a status
  `TextRenderable`, and an `InputRenderable`.
- Each transcript line is a `TextRenderable` appended to the scrollbox. A turn's **streaming answer**
  lands in one live `TextRenderable` whose `.content` grows per `text` delta (via `loop`'s `onEvent`);
  **reasoning** renders dim/italic (via the `reasoningRouter` interceptor); **tool results** dim.
- Interceptors wired: `secretRedaction → reasoningRouter → tokenTap` (same order as the engine, D9).
- Keys (`renderer.keyInput`): **Enter** submit, **Shift+Tab** toggle PLAN/YOLO (updates the status
  line), **ESC** abort the in-flight turn (`turnAbort.abort()`), **Ctrl+C** clean shutdown (flush the
  session, `renderer.destroy()`, exit). `exitOnCtrlC:false` so shutdown flushes first.

**How to change it:**
- **For the OpenTUI API, call `manual("opentui")`** — it lazy-loads the vendored skill's routing
  table + `docs/**/*.mdx` (e.g. `manual("opentui/components/scrollbox")`). It is *not* always in context.
- Keep the loop pure — the TUI only observes via `onEvent`/`onToolResult` and owns rendering.
- Rich rendering (markdown/code/diff) → swap the answer `TextRenderable` for OpenTUI's `markdown`/
  `code`/`diff` components; mind streaming (`ScrollbackSurface` for token-by-token highlight).

**Gotchas:**
- Interactive rendering can't be unit-tested headlessly — verify by running `bun index.ts` /
  `bun run dev` in a real terminal. `--watch` (full restart) is the dev loop, not `--hot`.
- Input keystrokes and the global `keyInput` handler both fire; the handler owns ESC/Shift+Tab/Ctrl+C.
- ESC latency differs by terminal (Kitty keyboard protocol) — crisp in Ghostty, timing-based in the
  VS Code terminal. Both work.

**See:** [ARCHITECTURE_BRIEF §8](../ARCHITECTURE_BRIEF.md) · [loop](loop.md) · OpenTUI: `manual("opentui")`
