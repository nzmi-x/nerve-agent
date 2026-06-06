# ARCHITECTURE_BRIEF.md

A minimalist architecture for `nerve` — a single-developer **coding agent** for **Gemini** and
**DeepSeek** only. The whole system is one Bun process: an event loop pulls a token stream from a
provider, runs every chunk through a synchronous interceptor pipeline (the "nerve"), dispatches
tool calls locally under a human-controlled permission mode, and paints the result with OpenTUI.
Decisions and their rationale live in [DECISIONS.md](DECISIONS.md); rules in [AGENT_RULES.md](AGENT_RULES.md).

```
 user input ──▶ ┌─────────┐  ProviderRequest  ┌──────────┐  raw SSE  ┌──────────────┐
                │  loop   │ ─────────────────▶ │ provider │ ────────▶ │ stream.ts    │
   ESC aborts ─▶│ (turn)  │                    │ gemini   │           │ SSE parse +  │
                │         │ ◀───────────────── │ deepseek │ ◀──────── │ interceptors │  ◀ the "nerve"
                └────┬────┘    StreamEvent     └──────────┘ StreamEvent└──────┬───────┘
          tool_call  │                                                        │ text / reasoning / done
                     ▼                                                        ▼
              ┌─────────────┐  result (→ session)                      ┌──────────┐
              │  dispatcher │◀── mode gate (PLAN/EDIT, human-only) ────│   tui    │ OpenTUI render
              │  → tools    │ ───────────────────────────────────────▶ └──────────┘ (status: mode+model)
              └─────────────┘                                                │
                     │ msg lines (resume) + delta lines (token-tap telemetry) ─▶ ~/.nerve/projects/<slug>/sessions/<id>.jsonl
```

## 1. The normalized event contract (the one abstraction worth having)

Gemini and DeepSeek have **different wire formats** (§4). We refuse to leak that past the provider
boundary. Each client maps its native stream onto one tiny discriminated union — the only shared
contract in the codebase.

```ts
// src/providers/types.ts  (target shape — Phase 1)
export type StreamEvent =
  | { type: "text";      delta: string }                                  // visible answer tokens
  | { type: "reasoning"; delta: string }                                  // DeepSeek reasoning_content / Gemini "thought" parts
  | { type: "tool_call"; index: number; id?: string; name?: string; args: string; signature?: string } // partial, accumulated by index; signature = Gemini thoughtSignature (replay-or-400, §6)
  | { type: "usage";     input: number; output: number }
  | { type: "done";      reason: "stop" | "length" | "tool_calls" | "safety" | "error" }
  | { type: "error";     error: unknown };
```

The **`signature`** on `tool_call` carries Gemini's opaque `thoughtSignature` so the session can
replay it (omitting it is a hard 400 — [providers.md §2.6](providers.md)); DeepSeek leaves it
undefined and instead replays its `reasoning_content`, which the session reconstructs by
accumulating `reasoning` deltas. (A Gemini *text*-final signature is "recommended, not enforced" —
deferred until it earns its place.)

```ts

export interface Provider {
  readonly name: "gemini" | "deepseek";
  stream(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent>; // raw fetch+SSE inside
}
```

`ProviderRequest` is our neutral shape (system text, message history, declared tools, model,
temperature, thinking flag). Each client translates it *into* the provider's native body — there is
**no** generic OpenAI-style request object pretending to be universal. A union is `switch`-able,
`console.log`-able, exhaustively checked by `noFallthroughCasesInSwitch`, and an LLM editing the
loop sees every possible event at a glance. That is the self-hackability tax we pay; nothing else
gets abstracted.

## 2. Streaming + **mid-token interception** (the "nerve")

`src/stream.ts` owns two jobs, kept separate from the providers:

**a) SSE parsing.** Both providers stream Server-Sent Events over `fetch`. One small reader turns
`response.body` into lines, splits on `\n\n`, strips `data: ` prefixes, yields parsed JSON frames.
No `eventsource` dependency — `fetch` + a `TextDecoder` loop is ~30 lines.

**b) The interceptor pipeline — the headline feature.** Every `StreamEvent`, *before* it reaches
the session accumulator or the TUI, passes through an ordered list of **synchronous** interceptors.
An interceptor can **observe**, **rewrite**, **drop**, or **abort** mid-stream — splice into the
model's output between tokens. Synchronous on purpose: the per-delta path must stay fast and
predictable; side-effects fire-and-forget or go through `ctl.emit`.

```ts
export type Interceptor = (ev: StreamEvent, ctl: StreamCtl) => StreamEvent | null | void;
// return event → forward (possibly mutated) │ return null → drop │ ctl.abort() → kill the turn

export interface StreamCtl {
  abort(reason?: string): void;   // cancel the in-flight fetch via its AbortSignal (also what ESC calls)
  emit(ev: StreamEvent): void;    // inject a synthetic event downstream
  readonly text: string;          // text accumulated so far this turn (for guard / stop-sequence logic)
}
```

**v1 interceptors shipped in Phase 1** (each exercises a different capability):

| Interceptor          | Capability   | What it does                                                                 |
| -------------------- | ------------ | ---------------------------------------------------------------------------- |
| **token-tap**        | observe      | Tees every `text`/`reasoning` delta + `usage` to the `~/.nerve/projects/<slug>/sessions` JSONL sink (§6). |
| **stop-guard**       | abort        | Watches `ctl.text`; `ctl.abort()`s the fetch the instant a configured banned/terminal pattern appears — kills wasted tokens. |
| **reasoning-router** | route        | Sends `reasoning` deltas to a dimmed/foldable TUI region, distinct from answer text. |
| **secret-redaction** | rewrite      | Scrubs secret/token patterns from deltas *before* UI or log, so an echoed key never persists. |

Interceptors are just functions in an array. Reorder, add, or **hot-swap** them at runtime (§5) —
the loop reads the array fresh each turn. No registration ceremony, no event bus.
**Order is load-bearing:** secret-redaction must run *before* token-tap and the TUI, or a secret
hits the log/screen before it's scrubbed. Default order:
`secret-redaction → reasoning-router → stop-guard → token-tap` (tap last, so it records the final
post-transform event).

## 3. The event loop (`src/loop.ts`) — pure & re-entrant

One turn as a flat sequence — no state-machine framework. **`loop` is a pure function over a
session** so a subagent later is just "call it with a fresh session + a cheaper profile"
(see [DECISIONS.md D6](DECISIONS.md)):

```
loop(session, profile, mode):
  while true:
    req   = buildRequest(session, profile)          # neutral ProviderRequest
    gen   = provider.stream(req, signal)            # async generator of StreamEvent (signal ← ESC/stop-guard)
    for ev in gen:
      ev = runInterceptors(ev, ctl)                 # the nerve; may drop / rewrite / abort
      if ev == null: continue
      session.apply(ev)                             # accumulate (token-tap logs the raw delta, §6)
      tui.render(session)                           # repaint (cheap; OpenTUI diffs)
    persist(session.assistantMessage)               # canonical "msg" line — what resume replays (§6)
    if session.pendingToolCalls:
      results = await dispatch(session.pendingToolCalls, mode)  # mode-gated local execution (§4–5)
      session.append(results); persist(results)     # tool-result "msg" lines
      continue                                       # next turn, same loop (cap iterations as a runaway guard)
    break                                            # done: hand control back to input
```

The loop is provider-agnostic (it sees only `StreamEvent`s and a `Provider`) and mode-agnostic
beyond passing `mode` to the dispatcher. Swapping Gemini↔DeepSeek or a model is a profile change;
the loop never learns which it spoke to.

## 4. Providers (raw, native, no shared body)

Two files, each owning one provider's quirks end to end — **not** unified beyond the `Provider`
interface. Models come from `config/models.json` (schema-validated); keys from `Bun.env` (see [DECISIONS.md D5](DECISIONS.md)).
**The verified wire spec — endpoints, request bodies, streaming chunk shapes, tool-call
accumulation, thinking config, and `StreamEvent` mappings — lives in [providers.md](providers.md)**
(the ground truth both these clients, and nerve when it self-hosts the Gemini one, code against).

### `src/providers/gemini.ts`
- **Endpoint:** `POST .../v1beta/models/{model}:streamGenerateContent?alt=sse`, header `x-goog-api-key: $GEMINI_API_KEY`.
- **Wire:** SSE → `candidates[0].content.parts[]`. A part is `{ text }` (→ `text`, or `reasoning`
  when `thought: true`) or `{ functionCall: { name, args } }` (→ `tool_call`, complete in one frame).
  `usageMetadata` → `usage`; `finishReason` → `done`.
- **Request:** history → `contents[]` (`role: user|model`); system → `systemInstruction`; tools →
  `tools[].functionDeclarations[]`.

### `src/providers/deepseek.ts`
- **Endpoint:** `POST https://api.deepseek.com/chat/completions`, body `{ stream: true }`, header
  `Authorization: Bearer $DEEPSEEK_API_KEY`. OpenAI-shaped, treated as DeepSeek-specific, not a reusable base.
- **Wire:** SSE → `choices[0].delta`. `delta.content` → `text`; `delta.reasoning_content`
  (reasoner) → `reasoning`; `delta.tool_calls[]` → `tool_call` (**accumulate `args` by `index`**).
  `[DONE]` / `finish_reason` → `done`; trailing `usage` → `usage`.
- **Request:** history → `messages[]` (`system`/`user`/`assistant`/`tool`); tools → `tools[]`
  (`type: "function"`).

Adding a model = an entry in `config/models.json` (schema-backed IntelliSense), never a code path.

## 5. Local execution: tools, hashline edit, modes, hot-swap, LSP

### Tool registry (`src/tools/`)
A flat registry; each tool: `{ name, description, parameters (JSON Schema), readonly: boolean,
run(args, ctx) }`. JSON Schema maps cleanly to both Gemini `functionDeclarations` and DeepSeek
`tools`. Tools are **direct Bun calls** — `Bun.file`/`Bun.write`, `Bun.$`, `fetch`. No sandbox
daemon, no RPC, no worker pool. Seed set (rent heuristic, [DECISIONS.md D2](DECISIONS.md)):
`read`, `write`, `edit`, `bash`, `grep`, `glob`, `ls`, `manual` (self-docs, below), plus `lsp`
(LSP, Phase 2). Provider tool-call shapes normalize to `{ name, args }` at the `StreamEvent`
boundary, so tools never know which model invoked them.

### `edit` = hashline only (`src/tools/edit.ts` + `src/hashline.ts`)
The **sole** edit mechanism (see [DECISIONS.md D3](DECISIONS.md)):
- `read` renders each line `LINE#HASH:content`, line-number left-padded. `HASH` = 2 chars from
  `ZPMQVRWSNKTXJBYH` via **`Bun.hash`** over the normalized line (no `xxhashjs`); alphanumeric-free
  lines seed from the line number.
- Edit payload: `{ path, edits: [{ op: "replace"|"append"|"prepend", pos: "11#KT", end?, lines }] }`.
  The model anchors at hashes instead of retyping lines — fewer output tokens.
- **Stale → hard reject + re-anchor:** any hash mismatch rejects the whole patch and returns fresh
  anchors for the affected region. No snapshot cache, no silent relocation. A stale read can't
  corrupt a file. `read` and `edit` are intentionally coupled by the anchor format.

### Permission modes (`src/dispatch.ts`) — human-controlled
Two modes, switched **only** by the human (`Shift+Tab`); the model has **no `set_mode` tool** and
cannot escalate (see [DECISIONS.md D4](DECISIONS.md)). Enforcement lives in the dispatcher:
- **PLAN:** allow `readonly` tools (`read`/`grep`/`glob`/`ls`) + an allowlist of *obviously-safe,
  single-program* bash (`git diff/log/status/show`, `ls`, `cat`, `rg`, `find`, `head`, `tail`,
  `wc`…) with **no shell metacharacters** (`>` `>>` `|` `;` `&&` `$(...)` `` ` `` `tee`). Mutations
  blocked. Need a read-only capability bash can't safely express? **Build a tool**, don't loosen
  the filter.
- **EDIT:** everything auto-runs.

The loop never blocks mid-turn for input; the TUI needs no confirm dialog.

### Hot-swap of seams (`/reload`)
The **tool registry** and **interceptor pipeline** are hot-reloadable (see [DECISIONS.md D7](DECISIONS.md)):
`/reload` (and `Ctrl+R`) re-imports their modules via Bun cache-busted dynamic import
(`import(path + "?t=" + Date.now())`) and swaps them into the **running** loop, conversation
preserved. The engine (loop, providers, session) never swaps mid-stream — only the leaf seams.
The system prompt (`prompts/system.md`) is likewise read fresh per turn, so it's hot-swappable too.
Tool/interceptor modules must therefore re-import cleanly (no top-level side effects that can't run twice).

### LSP integration (`src/lsp/`, Phase 2) — code intelligence at two seams
A raw **JSON-RPC-over-stdio** client, **zero dependencies** (see [DECISIONS.md D10](DECISIONS.md)):
`src/lsp/client.ts` (`Bun.spawn` the server, Content-Length framing, id↔response correlation,
`didOpen`/`didChange` doc sync, `publishDiagnostics` cached by URI, `initialize`/`shutdown`
lifecycle) and `src/lsp/index.ts` (the manager: extension routing, lazy spawn, diagnostics
formatting, query ops). Servers come from a committed, schema-backed **`config/lsp.json`**
(`extensions → { id, command, args, rootMarkers? }`), spawn **lazily** on the first matching file,
stay warm, and are killed on exit. nerve never installs servers — `command` must be on PATH; seeded
with TypeScript (`typescript-language-server --stdio`). Two seams:

- **Automatic diagnostics.** `edit`/`write` append a formatted diagnostics block (errors/warnings
  with line refs) to their tool result; `read` does the same. The agent sees breakage immediately —
  no round-trip through `bash tsc`. Because nerve is itself TS, this directly serves self-hacking
  ([DECISIONS.md D7](DECISIONS.md)).
- **The `lsp` tool.** One tool, `operation` enum (`goToDefinition`, `findReferences`, `hover`,
  `documentSymbol`, `workspaceSymbol`, `goToImplementation`, call-hierarchy), args
  `(filePath, line, character)` 1-based + `query` for `workspaceSymbol`. It is `readonly: true`, so
  it works in **PLAN mode** — diagnosis and context-gathering need no mutation rights.

Language servers are the one long-lived subprocess nerve keeps; they're lazy and cleaned up on exit,
not a daemon the core loop depends on.

### Self-docs — the `manual` tool (`src/tools/manual.ts` + `docs/manual/`)
The operator's manual the agent reads before modifying nerve (see [DECISIONS.md D13](DECISIONS.md)) —
the self-hackability directive made operational. `manual` is `readonly: true` (PLAN-safe):
`manual()` returns an **auto-discovered topic index**, `manual("<topic>")` returns that page. The
index is a pure function of the filesystem: `docs/manual/*.md` (thin per-subsystem "how to change X"
pages) + the existing `docs/*.md` + `opentui` sourced from the vendored `.claude/skills/opentui` tree.
**OpenTUI is lazy** — never always-loaded; `manual("opentui")` (or the `tui` page that points there)
pulls its `SKILL.md` routing table + `docs/**/*.mdx` into context exactly when the agent is about to
touch the UI. Pages are plain markdown edited with `edit`; the discipline ([AGENT_RULES §2](AGENT_RULES.md))
is that a subsystem change updates its `docs/manual/` page **in the same commit**, so the manual
can't rot. Per-subsystem pages are authored alongside their code, so the manual grows with the
implementation, never ahead of it.

## 6. State & persistence (`src/session.ts`)

`session` is the accumulator: messages + in-progress `text`/`reasoning`/`tool_call` buffers.
**Provider reasoning artifacts must be stored on the assistant message and replayed** on tool-calling
turns — DeepSeek's `reasoning_content` and Gemini's `thoughtSignature` (omitting the latter is a hard
400). See [providers.md §0](providers.md). So an assistant message persists not just text + tool
calls but the opaque reasoning blob/signature that produced them.
Persistence is **append-only JSONL** at `~/.nerve/projects/<slug>/sessions/<id>.jsonl` with **typed lines**
(see [DECISIONS.md D8](DECISIONS.md)): `{"t":"msg",...}` canonical messages (user/assistant/tool,
*including* the stored reasoning artifact) and optional `{"t":"delta",...}` raw deltas written by
the token-tap interceptor. **Resume (`--resume` / last) replays only the `msg` lines** to rebuild
state; the `delta` lines are telemetry/debug and are ignored on replay. One file, two purposes, no
ambiguity. No DB, greppable, crash-recoverable, and the agent can read its own past sessions.

## 7. Claude compatibility — context & skills (`src/context.ts`)

nerve reuses the Claude Code ecosystem instead of inventing its own (see [DECISIONS.md D12](DECISIONS.md)).
On startup, `context.ts` is a **pure function of the filesystem** (so it hot-swaps via `/reload`):

- **`CLAUDE.md` layering (Phase 1).** Concatenate, in precedence order, `~/.claude/CLAUDE.md`
  (user) → `./.claude/CLAUDE.md` / `./CLAUDE.md` (project), resolving `@path` includes. The
  effective system prompt = `prompts/system.md` (nerve's base) **+** these layers. nerve dogfoods
  this on its own `.claude/CLAUDE.md`.
- **Skills (Phase 2).** Discover `~/.claude/skills/*/SKILL.md` and `./.claude/skills/*/SKILL.md`;
  keep only each skill's `name` + `description` in context (progressive disclosure), and inject the
  full `SKILL.md` body on invocation. Minimal subset — no advanced frontmatter, no marketplace.
  The bundled **`opentui`** skill is *not* eagerly loaded as a user-skill — it's reached on demand
  through the `manual` tool (§5), so our only dependency's API costs context only when the UI is touched.

## 8. TUI (`src/tui/app.ts`)

OpenTUI imperative core (`@opentui/core`): a scrolling transcript of `Box`/`Text`, a streaming
`markdown`/`code`/`diff` region fed by `text` deltas as they arrive, a `reasoning` region rendered
dimmed/foldable (fed by the reasoning-router), and an `input`/`textarea` prompt. A **status line**
shows the active **mode** (PLAN/EDIT) and **model profile**. Keybinds: `Shift+Tab` (mode),
`Ctrl+R`/`/reload` (hot-swap), `ESC` (abort the current turn via the provider `AbortSignal`),
`Ctrl+C` (exit). Render is a cheap function of `session` state called per applied event; OpenTUI
diffs the frame, so naive repaint-per-delta is fine to start. Imperative by default; a React/Solid
binding only if a screen's state genuinely demands it.

## 9. What is deliberately absent

No provider router/registry beyond the two. No request/response normalization framework. No second
edit mechanism. No plugin loader, no DI container, no message-bus, no agent-graph engine, no
retry/backoff middleware, no caching layer, no snapshot store, no SQLite, no LSP *library* (the
client is raw JSON-RPC). The only long-lived subprocesses are lazily-spawned language servers — not
a daemon the core loop depends on. Subagents are deferred (the loop's re-entrancy is the only
accommodation); LSP is Phase 2. Each absent thing is a translation tax this scope doesn't owe. When
a need is *real*, add the smallest thing that meets it — and record why in [DECISIONS.md](DECISIONS.md).
