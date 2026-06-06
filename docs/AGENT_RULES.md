# AGENT_RULES.md

The constitution of `nerve`. These rules bind both the human author and any LLM operating
inside the harness. When a change conflicts with a rule here, the rule wins — or the rule
gets edited first, deliberately, in its own commit. Nothing here is incidental.

Concrete design decisions (and the alternatives they beat) live in [DECISIONS.md](DECISIONS.md).
This file is the *why*; that file is the *what*. Keep them in sync.

---

## 1. Strict provider scope: Gemini + DeepSeek, nothing else

- The **only** supported providers are **Google Gemini** and **DeepSeek**. This is hardcoded
  on purpose and assumed everywhere.
- **Do not** add Anthropic, OpenAI, Mistral, Cohere, Ollama, OpenRouter, LiteLLM, LangChain,
  Vercel AI SDK, or any aggregator/router/abstraction-over-providers. Not "just in case."
- **No generic `Provider` plugin system beyond the two.** The `Provider` interface exists to
  share a *contract*, not to invite a third implementation. Two concrete clients, full stop.
- Talk to each API **raw**, over `fetch` + SSE. No vendor SDK unless it earns its weight by
  removing more code than it adds — and even then, prove it in the commit message.
- The payoff: zero translation layers, zero lowest-common-denominator feature loss. Each
  client speaks its provider's native wire format and maps to one small internal event type.

## 2. Anti-redundancy: if it doesn't pay rent today, it isn't here

- **No speculative abstraction.** Build for the case in front of you, not an imagined future.
  The Rule of Three: don't extract a shared abstraction until the *third* real duplication.
- **No boilerplate.** No empty interfaces, no pass-through wrappers, no `BaseFoo` you extend
  once, no getters/setters around plain fields, no `index.ts` barrels re-exporting neighbors.
- **No dead config.** Every option must change observable behavior. Delete unused flags.
- **No defensive cruft** for inputs that cannot occur given the two known providers.
- **Delete fearlessly.** Removing code is the highest-value contribution. Leave nothing
  "in case we need it" — version control already kept it.
- Prefer a Bun built-in, then ~30 lines of local code, then (last resort) a dependency.
- **Tools must earn rent.** A capability becomes a dedicated tool only when
  **frequency × reusability × token-savings** beats its upkeep — you/the agent do it often, it's
  reusable, and a tool saves real tokens vs. ad-hoc bash. Otherwise it's a bash call, not a tool.
  Corollary: when PLAN mode needs a read-only capability bash can't safely express, **build the
  tool** — never loosen the safety filter to fit a one-off.
- **One mechanism per job.** `edit` is hashline-only; there is no second edit path. Don't add a
  parallel "simpler"/"fallback" version of something that already exists — fix the one that's there.
- **The manual ships with the code it documents.** Every subsystem has a thin `docs/manual/<x>.md`
  ("what · which file · how it works · how to change it · gotchas · see Dn"). When you change a
  subsystem, **update its manual page in the same commit** — a stale manual is worse than none,
  because the agent reads it before self-editing ([DECISIONS.md D13](DECISIONS.md)). Keep pages thin
  pointers to code + decisions; don't duplicate code into prose (that's what rots).

## 3. Self-hackability is the prime directive

The single metric this project optimizes: **how safely can the human — or the agent in the
loop — change the harness while it runs?**

- **Flat and legible.** A newcomer (human or model) should locate any behavior in one or two
  hops. No deep inheritance, no hidden control flow, no metaprogramming, no DI containers.
- **Small, single-purpose files.** One concern per file. If you can't summarize a file in one
  sentence, split it.
- **Explicit data, explicit flow.** Discriminated unions and plain functions over classes and
  events-at-a-distance. State you can `console.log` beats state you have to debug.
- **Stable seams, hot-swappable.** The hot seams are the **tool registry** and the **interceptor
  pipeline** — they reload at runtime (`/reload`, Bun cache-busted import) without dropping the
  conversation. Keep their shapes tiny, and keep their modules **re-import-safe**: no top-level
  side effects that can't run twice. The *engine* (loop, providers, session) never swaps
  mid-stream — only the leaf seams do. Don't blur that boundary.
- **The agent may edit its own harness.** Code so the model in the loop can read a file, grok
  it, and patch it safely. Obvious beats clever, every time.

## 4. Lean local execution

- Local-first: tools run as direct Bun calls (`Bun.file`, `Bun.$`, `fetch`). No daemon, no
  IPC, no microservice, no container for the core loop.
- One process — plus lazily-spawned **language servers** (the only long-lived subprocesses; killed
  on exit, not a daemon the loop depends on). The LSP client is **raw JSON-RPC over stdio, zero
  deps** — same ethos as the raw-fetch providers; don't pull in `vscode-jsonrpc` or an LSP library.
- One process. The event loop, the providers, the tools, and the TUI share a runtime.
- Fail loud and early. Surface the raw error; do not bury it under retries or fallbacks.
- **Diagnostics ride along, code intelligence is read-only.** `edit`/`write`/`read` append LSP
  diagnostics to their results; the `lsp` query tool is `readonly: true` and works in PLAN mode.
  Keep `lsp.schema.json` in sync with `lsp.json`, exactly like `models.schema.json`/`models.json`.
- `loop` is a **pure, re-entrant function over a session** — keep it that way. Subagents (deferred)
  depend on it: "run the loop with a fresh session + a cheaper profile." No turn state in module
  globals.

## 5. Safety boundaries the model cannot cross

- **The model never changes the permission mode.** PLAN ↔ YOLO is a *human-only* switch
  (`Shift+Tab`), enforced in the dispatcher. Do **not** add a `set_mode` tool, a config the model
  can write to flip it, or any path that lets the agent escalate PLAN → YOLO. The boundary is the
  point.
- **PLAN mode is read-only, conservatively.** Mutations are hard-blocked. Bash in PLAN runs only
  for *obviously-safe, single-program* commands with no shell metacharacters — never widen this by
  parsing arbitrary shell for "safety."
- **Edits can't corrupt silently.** Hashline edits hard-reject on a stale anchor and re-anchor;
  never add silent relocation or auto-fixup that could write to the wrong place.
- **Secrets stay out of git and out of agent-editable files.** Keys live in `.env`. Don't move
  them into `config/models.json`, a `.ts` config, or anything committed.

## 6. When in doubt

Choose the version with **less code, fewer concepts, and a shorter path from input to effect.**
If two designs tie, pick the one that's easier to delete later.
