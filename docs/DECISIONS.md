# DECISIONS.md

Standing record of the design decisions behind `nerve`, captured from a deliberate
grilling session. Each entry states the decision, why it won, and what was rejected — so the
reasoning survives and isn't re-litigated. New decisions append here; reversals edit the
relevant entry and say so. ADR-lite, no ceremony.

---

## D1 — Primary purpose: personal coding agent
**Decision.** nerve is a single-developer **coding agent**. It operates on a working directory
(the dir it's launched in): reads, edits, runs shell, iterates on code. This gives it a
working-dir concept, filesystem + shell tools, and diff/code-centric rendering.
**Why.** It's the 90% use case; the references (claude-code, opencode) are coding agents.
**Rejected.** General chat-first agent; narrow single-workflow runner.
**Implication.** When launched *inside the nerve repo*, the same tools let it edit its own
harness — the substrate for self-hacking (see [D7](#d7--self-hacking-runtime-hot-swap-of-seams)).

## D2 — Tools earn their place by a rent heuristic, not a fixed count
**Decision.** No fixed tool count. A capability becomes a dedicated tool when
**frequency × reusability × token-savings** beats its maintenance cost — i.e. you (or the agent)
do it often, it's reusable, and a tool saves real tokens vs. ad-hoc bash. Phase 1 seeds the
obvious winners: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `ls`.
**Why.** The user's framing: "I don't care how many tools, as long as it has high reusability…
if the agent often spends a lot of tokens running custom commands for it, make the tool."
**Rejected.** Fixed "lean 4" or "standard 7" tiers as a hard cap.
**Implication.** grep/glob/ls ship despite bash covering them, because structured results are
high-frequency and save tokens vs. parsing stdout. Adding more later is a judgement call against
the heuristic, recorded here.

## D3 — Edit mechanism: hashline only (content-anchored)
**Decision.** The **sole** edit path is **hashline editing** (pi-hashline-edit format).
- `read` emits every line as `LINE#HASH:content`, line-number left-padded for alignment.
- `HASH` = 2 chars from the 16-char alphabet `ZPMQVRWSNKTXJBYH` (excludes hex digits, vowels,
  and ambiguous D/G/I/L/O), derived from the (normalized) line content via **`Bun.hash`**
  (no `xxhashjs` dependency). Lines with no alphanumerics seed the hash from the line number.
- Edits reference anchors: `{ path, edits: [{ op: "replace"|"append"|"prepend", pos: "11#KT",
  end?: "14#BH", lines: [...] }] }`. The model points at anchors instead of retyping old lines.
- **Stale handling: hard reject + re-anchor.** On any hash mismatch the whole patch is rejected
  and the error returns fresh `LINE#HASH` anchors for the affected region for immediate retry.
  **No** silent relocation, **no** snapshot cache.
**Why.** Fewer output tokens (no retyping), kills whitespace/string-not-found loops, and a stale
read can't corrupt a file (anchors diverge → reject). Leanest robust option; fail-loud.
**Rejected.** Exact `oldString`/`newString` replace (string-not-found loops); fuzzy replacer
ladder (opencode's 9 strategies — more code, still retypes lines); unified-diff apply (brittle);
omp-style snapshot recovery (a snapshot store + merge logic = bloat); keeping string-replace as a
fallback (two edit mechanisms violates the leanness mandate).
**Implication.** `read` and `edit` are intentionally coupled through the anchor format. Edit is
the only place hashes are validated.

## D4 — Permissions: two human-switched modes, enforced at dispatch
**Decision.** Two modes:
- **PLAN** (read-only): structured read tools (`read`/`grep`/`glob`/`ls`) **plus** an allowlist of
  *obviously-safe, single-program* bash commands (e.g. `git diff/log/status/show`, `ls`, `cat`,
  `rg`, `find`, `head`, `tail`, `wc`) with **no shell metacharacters** (`>`, `>>`, `|`, `;`,
  `&&`, `$(...)`, backticks, `tee`). Anything fancier is rejected. Mutations are hard-blocked.
- **EDIT**: everything auto-runs, no confirmation.

The mode switch is **human-only** (TUI keybind, Shift+Tab), enforced in the **tool dispatcher**.
The model has **no `set_mode` tool** and cannot escalate PLAN → EDIT. Tools carry a `readonly`
flag; the dispatcher gates on it (+ the bash allowlist) per mode.
**Why.** The user wants a strict planning/Q&A mode and a fast mode, with the safety boundary
under human control: "No self toggle, only I can switch modes." Classifying arbitrary shell as
read-only is unsafe, so PLAN only permits *obviously* safe commands.
**Rejected.** Per-call y/n confirmation (blocks the loop, needs a confirm UI + allowlist state);
per-tool policy map (a policy layer to maintain); a model-settable `readOnly` bash flag (trusts
the model's self-classification — weaker boundary); allowing arbitrary bash in PLAN via a parser.
**Implication.** Need a read-only capability in PLAN that bash can't safely express? **Build a
dedicated tool for it** (ties back to [D2](#d2--tools-earn-their-place-by-a-rent-heuristic-not-a-fixed-count)) — don't loosen the bash filter. The loop never blocks
mid-turn for input; the TUI needs no confirm dialog.

## D5 — Model selection: keys in `.env`, models in a committed catalog
**Decision.** API keys live in **`.env`** (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`), auto-loaded by
Bun, already gitignored. Usable models live in a committed **`config/models.json`** catalog (Bun imports
JSON natively), validated by **`config/models.schema.json`** referenced via an inline `"$schema"` key so
editors give **IntelliSense + validation** while editing. Each entry
`{ id, provider, label?, default?, temperature?, thinking? }`. Default profile: **`deepseek-v4-flash`**.
**Why.** Best secret hygiene (keys never in git or in an agent-editable file); the model list is
plain data the agent can safely edit; schema-backed JSON catches typos (e.g. a bad `provider`) at
edit time; models aren't hardcoded, so new releases are a config edit.
**Format note (revised).** Originally specified as `models.toml`; changed to **JSON + `$schema`**
at the user's request specifically for editor IntelliSense. Keep `models.schema.json` in sync when
config fields change.
**Complexity ladder (user's own):** `deepseek-v4-flash` (simple edits, context-gathering,
subagents) → `deepseek-v4-pro` (slightly complex) → `gemini-3.5-flash` → `gemini-3.5-pro`
(careful planning / complex features; unreleased as of 2026-06, expected this month).
**Rejected.** Keys inside a `nerve.config.toml`/`.ts` (secrets in a file the agent edits);
runtime profile-cycling UI (the user rarely switches — picks per known task); mode-coupled model
mapping (couples two orthogonal concerns); hardcoding/listing every Gemini & DeepSeek model.

## D6 — Subagents: deferred, but the loop must be re-entrant
**Decision.** Subagents are **deferred** past Phase 1. The hard constraint: **`loop.ts` is a pure,
re-entrant function over a session**, so a subagent later is simply "run the loop with a fresh
isolated session + a cheaper model profile, return only the final summary."
**Why.** Keeps Phase 1 single-agent and lean; the re-entrancy constraint makes delegation nearly
free to add later (cheap model = `deepseek-v4-flash`).
**Rejected.** Building a `task` tool now; predefined named-role subagents (more structure up front).

## D7 — Self-hacking: runtime hot-swap of seams
**Decision.** The **tool registry** and the **interceptor pipeline** are hot-reloadable at runtime.
A `/reload` command (and a keybind) re-imports those modules from disk using **Bun cache-busted
dynamic import** (`import(path + "?t=" + Date.now())`) and swaps them into the **running** loop
**without dropping the conversation**. The engine (loop, providers, session) stays put — only the
*leaf seams* swap. The loop reads tools/interceptors fresh each turn, so the swap is seamless.
**Why.** Delivers the literal "hot-swap parts on the fly" mandate while keeping a safe boundary:
swap the leaves, never the engine mid-stream.
**Rejected.** Edit + restart-to-apply only (loses session state; not "on the fly"); a live `eval`
hatch against the running session (a REPL — too dangerous/broad for a harness feature).
**Implication.** Tools/interceptors must be defined in modules that re-import cleanly (no
top-level side effects that can't run twice). The system prompt is likewise a file read fresh per
turn, so it's hot-swappable too.

## D8 — Persistence: append-only JSONL per session, resume by replay
**Decision.** Each session is a file **`.nerve/sessions/<id>.jsonl`** with **typed lines**, appended
as it happens: `{"t":"msg",...}` canonical messages (user/assistant/tool — including the stored
reasoning artifact, see [§0 cross-cutting rule](providers.md)) and optional `{"t":"delta",...}` raw
deltas from the token-tap interceptor. **Resume (`--resume` / last) replays only the `msg` lines**;
`delta` lines are telemetry/debug, ignored on replay. One file, two purposes. No DB.
**Why.** Lean, greppable, crash-recoverable, and the agent can read its own past sessions. Typed
lines keep resume sane (rebuild from messages, not from thousands of deltas) while still letting the
log double as raw telemetry.
**Rejected.** In-memory only (no resume/history); `bun:sqlite` store (heavier than a solo tool
needs, a schema to own).

## D9 — Interceptors v1: the four that ship
**Decision.** The interceptor pipeline is **synchronous, per-delta**; each interceptor can
**observe / rewrite / drop** an event or call `ctl.abort()` / `ctl.emit()`. Phase 1 ships **four**
concrete interceptors so the seam has real users:
1. **Token-tap → JSONL** — tees every `text`/`reasoning` delta + `usage` to the `.nerve/sessions`
   sink as `delta` lines (telemetry/replay-debug; the canonical `msg` lines come from the session
   itself — [D8](#d8--persistence-append-only-jsonl-per-session-resume-by-replay)).
2. **Stop-guard** — watches `ctl.text`; `ctl.abort()`s the in-flight fetch the instant a
   configurable banned/terminal pattern appears (the canonical token-saving demo of interception).
3. **Reasoning router** — routes `reasoning` deltas (DeepSeek reasoner / Gemini thinking) to a
   dimmed/foldable TUI region, distinct from answer text.
4. **Secret redaction** — scrubs secret/token patterns from deltas *before* they reach the UI or
   the JSONL log, so an echoed key never persists.
**Why.** A mechanism with no users is vaporware; these four exercise observe, abort, route, and
rewrite respectively — the full capability surface.
**Order is load-bearing.** Default array order `secret-redaction → reasoning-router → stop-guard →
token-tap`: redaction must precede the tap and the TUI (or a secret is logged/shown before it's
scrubbed), and the tap runs last so it records the final post-transform event.
**Rejected (deferred).** Early-tool-dispatch (recognizing a completed tool_call before `done`);
async interceptors (would block the hot per-delta path — sync stays fast and predictable).

## D10 — LSP support: both seams, raw zero-dep client, schema-backed config
**Decision.** nerve integrates the **Language Server Protocol** at **two seams**:
1. **Automatic diagnostics.** After `edit`/`write` (and on `read`), nerve queries the matching
   language server and **appends a formatted diagnostics block** (errors/warnings with line refs)
   to the tool result — so the agent sees immediately whether it broke the file and self-corrects.
2. **An `lsp` query tool** — one tool with an `operation` enum: `goToDefinition`, `findReferences`,
   `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, and call-hierarchy
   (`prepareCallHierarchy`/`incomingCalls`/`outgoingCalls`). Args: `filePath`, `line`, `character`
   (1-based, editor coords), plus `query` for `workspaceSymbol`. It is `readonly: true`, so it
   works in **PLAN mode** too — navigation/context-gathering and diagnosis are read-only.

**Client.** A **raw JSON-RPC-over-stdio** client, **zero dependencies** (~200 lines): `Bun.spawn`
the server, Content-Length framing, request↔response id correlation, `textDocument/didOpen` +
`didChange` document sync, cache `publishDiagnostics` by URI, and the `initialize`/`shutdown`
lifecycle. Lives in `src/lsp/` (`client.ts` = transport+lifecycle, `index.ts` = manager: extension
routing, lazy spawn, diagnostics formatting, query ops).

**Config.** A committed **`config/lsp.json`** (+ **`config/lsp.schema.json`** via inline `$schema`,
IntelliSense like `models.json`) maps `extensions → { id, command, args, rootMarkers? }`. Servers spawn
**lazily** on the first file of a matching type, are kept warm, and are killed on exit. nerve does
**not** install servers — `command` must be on PATH. Seeded with **TypeScript**
(`typescript-language-server --stdio`), since nerve itself is TS, so post-edit diagnostics directly
serve the self-hacking mandate ([D7](#d7--self-hacking-runtime-hot-swap-of-seams)).

**Why.** Diagnostics-on-edit is the single highest-frequency win for a coding agent (catch breakage
without a round-trip through `bash tsc`); the query tool is high-reuse for context-gathering
([D2](#d2--tools-earn-their-place-by-a-rent-heuristic-not-a-fixed-count)). Raw client keeps it
dependency-free and fully hackable, matching the raw-fetch provider ethos. Schema-backed JSON config
stays consistent with [D5](#d5--model-selection-keys-in-env-models-in-a-committed-catalog).
**Rejected.** A `vscode-jsonrpc`/full LSP client library (deps + less hackable); auto-detecting
servers from PATH (implicit/magic); diagnostics-only or query-only (the user wants both seams).
**Phase.** Built in **Phase 2**, after the Phase 1 core loop + tools work end to end (LSP depends on
`read`/`edit`/`write` and the registry existing). Designed now so the tool surface accounts for it.

## D11 — Bootstrapping: Claude Code builds a trustworthy kernel, then nerve self-hosts
**Decision.** nerve is built by **self-hosting**, but not from zero. **Claude Code (Phase 1)
hand-builds the minimum *trustworthy* coding agent plus all safety/guardrail machinery.** The
moment nerve can do a reliable **edit → run → verify** cycle, **nerve builds, extends, and
"perfects" itself**, with Claude Code as reviewer + rescue. Self-hosting is a gradient that starts
as early as the kernel allows, not a switch thrown at a phase boundary.

**Hand-built (Phase 1 kernel):** re-entrant `loop`; **DeepSeek** streaming client; `StreamEvent`
contract + `stream.ts` (SSE + interceptor mechanism + the token-tap interceptor); tools
`read`/`write`/`edit` (hashline)/`bash`/`manual` (self-docs, [D13](#d13--self-documentation-a-manual-tool-over-docsmanual-the-operators-manual)) + seed
`docs/manual/` pages for the kernel subsystems; dispatcher + **PLAN/EDIT modes**; `session` + JSONL
persistence; a usable TUI; and the **guardrails — `git init`, a `bun test` + `bun run typecheck`
gate, and safe hot-reload (roll back to the old module on a failed import).**
**Kernel simplification:** start the kernel with DeepSeek `thinking:{type:"disabled"}` — V4 defaults
thinking **on**, which would force `reasoning_content` replay on the very first tool turn
([providers.md §1.6](providers.md)). Defer thinking (and its replay machinery) until the kernel
works; turn it on per-profile afterwards.

**nerve self-hosts (Claude reviews/rescues):** the **Gemini provider — the first self-hosted task**
(mirror the `Provider` contract; obvious done-condition, near-zero blast radius); then
`grep`/`glob`/`ls`, the remaining interceptors (stop-guard, reasoning-router, secret-redaction),
TUI polish, **LSP (Phase 2)**, subagents, and ongoing hardening/refactors.

**Why.** (1) **Bootstrap paradox** — you can't self-build the kernel that enables self-building;
the Phase-1 kernel must be hand-built. (2) **Never let the agent author its own guardrails** — the permission
boundary (esp. [D4](#d4--permissions-two-human-switched-modes-enforced-at-dispatch): the model
can't switch its own mode) and safe-reload are the containment for nerve's mistakes. (3)
**Contained, attributable failures** — a bug in a nerve-authored feature on a trusted core is easy
to localize; a bug in a nerve-authored kernel is not (debugging the tool with the tool on a
foundation neither trusts). (4) **The proof is self-refactor, not self-birth** — "perfection" =
reshaping a loop that already runs (nerve's differentiating claim), not greenfielding it. The first
task (Gemini) exercises exactly that on a small, verifiable scope, and surfaces any
*nerve-legibility* problems in the core at the earliest, cheapest moment.

**Metric.** Track **% of commits authored by nerve vs. Claude Code**. The crossover, and the first
non-trivial feature nerve lands on itself (the **LSP client** is the natural trophy), are the
milestones that validate the self-hackability thesis.

**Update (2026-06-07).** The **Gemini provider was hand-built by Claude Code at the user's request**
(`src/providers/gemini.ts`) and **live-verified** end-to-end — streaming, function calling, and the
strict `thoughtSignature` replay (no 400). So the *designated* "first self-hosted task" was instead
Claude-authored; the self-hack thesis now rides on nerve landing the next non-trivial feature on
itself (LSP stays the trophy). Both providers are wired in `config.ts`; the [D15](#d15--resilience-transient-error-auto-retry-with-model-ladder-fallback) fallback ladder is now genuinely cross-provider.

**Rejected.** nerve building its own Phase 1 kernel (bootstrap paradox + agent-authored guardrails +
uncontained failures); Claude Code building everything through Phase 2 (defeats the purpose; misses
early discovery of nerve-legibility problems).

**Hard prerequisites this creates.** `git init` **before any self-hosting** (version control is the
undo button for self-surgery; hashline hard-reject only guards *stale* corruption, not *logic*
corruption). And `/reload` MUST `try/catch` the dynamic import and keep the old module on failure
(typecheck-before-swap preferred) — promoted from micro-default to requirement once nerve self-edits.

## D12 — Claude compatibility: load CLAUDE.md + skills from `~/.claude` and `./.claude`
**Decision.** nerve **reuses the Claude Code ecosystem** rather than inventing a parallel one. On
startup (`src/context.ts`) it discovers and layers two things:
1. **Instructions / memory (`CLAUDE.md`).** Loaded and concatenated into the system context in
   precedence order *(user → project; project augments/overrides)*:
   `~/.claude/CLAUDE.md` (user-global) → `./.claude/CLAUDE.md` and/or `./CLAUDE.md` (project),
   resolving `@path` includes the way Claude Code does. The effective system prompt =
   `prompts/system.md` (nerve's own base) **+** the layered `CLAUDE.md`s.
2. **Skills.** Discover skill folders at `~/.claude/skills/*/` and `./.claude/skills/*/`, each a
   `SKILL.md` with YAML frontmatter (`name`, `description`). Only **name + description** sit in
   context (cheap, progressive disclosure); invoking a skill injects its full `SKILL.md` body (and
   referenced files) for that turn — the same model Claude Code uses.

**Why.** Zero-cost reuse of assets the user already has (the `.claude/skills/opentui` skill is
immediately available; so is any `~/.claude` setup), it's genuinely lean (file discovery + concat +
lazy body-load, no framework), and it keeps nerve's own config in the conventional place — which is
why [the operating guide moved to `.claude/CLAUDE.md`](#) and nerve dogfoods its own loader on it.
**Scope (minimal subset).** Parse `name`/`description` frontmatter + inject the body on invoke.
**Ignore** advanced Claude skill frontmatter (`allowed-tools`, model pins, etc.) for now — add only
if a real need appears. No marketplace, no remote fetch, no auto-install.
**Rejected.** A bespoke nerve-only prompt/skill format (throws away the user's existing ecosystem);
loading every CLAUDE.md up the whole tree eagerly (load project + user; nested/subdir on demand later).
**Phase.** `CLAUDE.md` layering is cheap and lands with the **Phase 1** system-prompt assembly;
**skills** discovery + invocation is **Phase 2** (alongside LSP). Keep the loader a pure function of
the filesystem so it hot-swaps with `/reload` like the other seams ([D7](#d7--self-hacking-runtime-hot-swap-of-seams)).

## D13 — Self-documentation: a `manual` tool over `docs/manual/` (the operator's manual)
**Decision.** nerve ships an **operator's manual it reads before modifying itself** — the
self-hackability prime directive ([D7](#d7--self-hacking-runtime-hot-swap-of-seams)) made operational.
- **`manual` tool** (`readonly: true`, so it works in PLAN). `manual()` → an auto-discovered **topic
  index**; `manual("<topic>")` → that page. The index is a **pure function of the filesystem** —
  topics = `docs/manual/*.md` (per-subsystem "how to change X" pages) **+** the existing `docs/*.md`
  (architecture, decisions, agent-rules, providers) **+** `opentui` (and sub-paths) sourced from the
  vendored `.claude/skills/opentui` tree. Drop a `.md` in `docs/manual/`, it's discoverable — no registration.
- **`docs/manual/` pages are thin and pointer-style:** *what it is · which file · how it works
  (briefly) · how to change it · gotchas · see DECISIONS Dn / ARCHITECTURE_BRIEF §n.* Thin so they
  point at the authoritative code + decisions instead of duplicating them (what makes self-docs rot).
- **OpenTUI is lazy, pulled *through* the manual.** It is **not** always-loaded (it'd waste context
  when irrelevant). `manual("opentui")` (or the `tui` page, which points there) surfaces the skill's
  `SKILL.md` routing table + `docs/**/*.mdx` on demand, so the agent reads the API exactly when it's
  about to touch the UI. (The vendored skill stays read-only upstream reference; nerve's *own* `tui`
  manual page is the editable part.)
- **Self-maintaining (anti-drift).** Pages are plain markdown edited with the normal hashline `edit`
  tool. The rule ([AGENT_RULES §2](AGENT_RULES.md)): **a change to a subsystem updates its
  `docs/manual/` page in the same commit.** Reading is PLAN-safe; editing a page is a mutation (EDIT),
  consistent with everything else.
**Why.** For nerve to self-host ([D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts))
the agent (often a *weaker* model) must be able to look up "how does X work / how do I change it"
before editing X — code legibility alone isn't enough. A dedicated tool (vs. plain `read`) carries
the topic index in its description, returns curated pages, and saves tokens — it earns its rent ([D2](#d2--tools-earn-their-place-by-a-rent-heuristic-not-a-fixed-count)).
**Rejected.** Always-loading opentui (context waste); reusing only `docs/` without task-oriented
pages (it's "how it fits/why", not "how to change X"); co-locating `.md` beside each `src/` module
(scatters docs, two homes); a separate write-mode on the tool (the `edit` tool already edits markdown).
**Phase.** The `manual` tool + opentui federation ship in **Phase 1** (the kernel needs them to
self-host). Per-subsystem pages are authored **alongside their code** (manual page ships in the same
commit as the subsystem), so the manual grows with — and never ahead of — the implementation.

## D14 — TUI input affordances: `@` files, `!` shell, `/` commands, with autosuggest
**Decision.** The input recognizes three prefixes, each with an autosuggestion popup. Parsing,
suggestion, and command/skill logic are **pure/fs-only** (`src/tui/affordances.ts`, unit-tested); the
popup rendering + key handling live in `app.ts`.
- **`@path` — file reference, reference-only (lazy).** Autocompletes file/dir paths (dirs get `/`,
  drill in by accepting). On submit the `@path` stays as **plain text** — the model `read`s it when
  it needs the content. No inline expansion (leanest; the `read` tool already exists).
- **`!command` — direct shell, full authority, private.** Runs with **full authority, bypassing the
  PLAN/EDIT gate** (that gate governs the *model*; the human is trusted), shows the output, and does
  **not** add it to the conversation (a side-glance that doesn't spend context). No suggestions (freeform).
- **`/command` — commands + skills.** Autosuggests built-ins (`help`, `model`, `mode`, `clear`,
  `compact`, `sessions`, `resume`, `drop`, `quit`) **+** discovered skills (name/description from `~/.claude` +
  `./.claude` `SKILL.md` frontmatter — a partial [D12](#d12--claude-compatibility-load-claudemd--skills-from-claude-and-claude))
  **+** markdown command files ([D16](#d16--markdown-slash-commands-arguments-templates-claudenerve-compatible)).
  Skill *invocation* is deferred to Phase 2; file-command expansion and listing work now.
- **`/drop`** deletes the current session file and starts a fresh one — for throwaway sessions that
  shouldn't clutter history (distinct from `/clear`, which only clears the transcript view).
**Why.** Matches the affordances every terminal agent has; keeping the logic pure makes the part I
can't runtime-test small. Reference-only `@` and private `!` are the lean, least-surprising defaults.
**Rejected.** `@` inline-expansion (up-front tokens; `read` covers it); `!` respecting the mode gate
(the gate is for the model, not the human); eager skill loading.
**Phase.** Affordance logic + `/drop` + built-in commands: **Phase 1**. Skill invocation, and richer
suggestions: Phase 2. Interactive rendering needs a real-terminal verification pass.

---

> **D15–D20 provenance.** Added after surveying the three reference harnesses (claude-code,
> opencode, **oh-my-pi**) for features worth borrowing. The filter was nerve's charter: lean,
> two-provider, self-hackable, *no framework bloat*. D15–D18 are adopted (Phase-1.5, building now);
> D19 is a blessed-but-deferred signature capability; D20 records what was surveyed and deliberately
> left out so it isn't re-litigated.

## D15 — Resilience: transient-error auto-retry with model-ladder fallback
**Decision.** A failed turn caused by a **transient** provider error (HTTP 429/500/502/503/504,
"overloaded", rate/usage limit, socket/timeout/connection-reset/`fetch failed`) is **retried
automatically** instead of surfacing as a dead turn. Mechanism, all in the re-entrant `loop`
([D6](#d6--subagents-deferred-but-the-loop-must-be-re-entrant)):
- Classification is a **pure regex function** (`src/retry.ts` `isTransient(error)`) over the error
  message — string-pattern, not typed provider codes (we have two providers; patterns are enough).
- On a transient error the partial assistant turn is **discarded** (`Session.discardAssistant()`,
  never committed) and the turn is re-attempted. Backoff is exponential
  (`baseDelayMs · 2^n`, default 1s→2s, capped at `maxDelayMs`), abortable by ESC.
- **Model-ladder fallback (the on-brand twist).** nerve already has a complexity ladder
  ([D5](#d5--model-selection-keys-in-env-models-in-a-committed-catalog)). On a transient error nerve
  first tries the **next implemented, keyed model down the catalog** (delay 0) before sleeping on the
  same one — a rate-limited `deepseek-v4-flash` falls to `v4-pro`, etc. The loop takes a
  `fallbacks: Candidate[]` ladder; the caller builds it from the catalog (`fallbacksFor` in
  `config.ts`), skipping unimplemented (`gemini`) / unkeyed entries.
- **Context overflow is explicitly NOT retried here** — that's compaction's job
  ([D17](#d17--context-maintenance-lean-compaction--tool-output-pruning)). `isTransient` excludes it.
- Surfaced via new loop callbacks `onRetry(info)` / `onError(error)` (the loop stops forwarding raw
  `error` StreamEvents to `onEvent`); the TUI shows a dim "↻ retrying" and a red final error.
**Why.** A self-hosting agent left to run unattended must survive a provider hiccup without a human
re-poking it; both DeepSeek and Gemini rate-limit. Fallback reuses the ladder we already maintain, so
resilience costs almost no new concept. ~40 lines + a pure classifier; this is one of the two things
worth landing *before* handing the wheel to nerve.
**Rejected.** Throwing/dead-turn on any error (the status quo — unattended runs die on a 429);
typed provider-error codes (over-built for two providers); retrying context-overflow here (wrong
remedy — loops forever on the same too-big input); unbounded retries (a `maxRetries` + `maxDelayMs`
cap fails loud instead).
**Phase.** **Now (Phase 1.5).** Auto-threshold/idle variants and cross-provider fallback land when
the Gemini provider exists.

## D16 — Markdown slash commands (`$ARGUMENTS` templates), Claude/nerve compatible
**Decision.** `/<name>` resolves a **markdown command file** the same way skills are discovered
([D12](#d12--claude-compatibility-load-claudemd--skills-from-claude-and-claude)): scan
`~/.claude/commands/*.md` + `./.claude/commands/*.md` (and nerve's own `.nerve/commands/`), parse
optional `name`/`description` frontmatter, and on invocation **expand the body into a prompt** with
substitution: `$1 $2 …` positional, `$@`/`$ARGUMENTS` for all args, the rest verbatim. The expanded
text is submitted as if the user typed it. Discovery + expansion are **pure** (`src/commands.ts`,
unit-tested); the TUI only routes. A built-in `/command` name always wins over a file of the same name.
**Why.** nerve already discovers skills and is Claude-compatible — file commands are the natural
sibling and pure leverage on work already done (`affordances.ts` already lists `/` suggestions). Lets
the user (and nerve) capture repeatable prompts as plain files, shareable with their Claude Code setup.
~30 lines of pure code + one wiring point.
**Rejected.** A bespoke command DSL (throws away Claude-compat); executing commands as code/hooks
(that's a heavier extensibility surface — see [D20](#d20--surveyed-and-deliberately-deferred-or-rejected));
inline backslash-escape grammar (kept the arg splitter simple/quote-aware like oh-my-pi's).
**Phase.** **Now (Phase 1.5).** Listing already works; this adds the expand-on-submit path.

## D17 — Context maintenance: lean compaction + tool-output pruning
**Decision.** Long sessions stay usable via **one** mechanism kept deliberately small (oh-my-pi has a
full tree/branch/handoff machine; we take the 20% that gives 80%):
- **Compaction.** `/compact [focus]` summarizes everything older than the most recent
  `keepRecentTokens` worth of messages into a **single summary**, then rebuilds live context as
  `[system, summaryAsUser, …recentMessages]`. The summary is produced by a one-shot drain of the
  provider stream (`summarize()` in `src/compaction.ts`, system prompt `prompts/compaction.md`).
- **Persistence ([D8](#d8--persistence-append-only-jsonl-per-session-resume-by-replay)).** A new
  typed line `{"t":"compaction","summary","firstKept":<ordinal>}` where `firstKept` is the ordinal
  (position among all `msg` lines ever written) of the first kept message. Resume uses the **latest**
  compaction marker: `messages = [summaryUser] + allMsgs.slice(firstKept)`. The append-only log is
  never rewritten; live `session.messages` and the global ordinal are tracked independently.
- **Cut point.** Never cut in the middle of a tool exchange — the boundary is snapped back to a
  `user`/`assistant` message so a `tool` result is never orphaned from its call.
- **Tool-output pruning (cheap companion).** `pruneToolOutputs()` replaces stale large `tool`
  results with `[output truncated — N tokens]`, protecting the newest ~40k tokens and **never**
  pruning `read` results (their `LINE#HASH` anchors must stay valid for `edit`, [D3](#d3--edit-mechanism-hashline-only-content-anchored)).
**Why.** Even at 1M context, unattended self-hosting sessions will overflow; nerve had **resume but
no compaction at all** — the one genuine capability gap the survey surfaced. Manual `/compact` first
(observable, safe); a token-threshold auto-trigger is a later flip of the same switch.
**Rejected.** oh-my-pi's full machine — session **tree**, **branch summaries**, split-turn handling,
**handoff**-to-new-session, remote/native compaction endpoints (all real, all bloat for a solo linear
session; revisit tree/handoff only if a concrete need appears, [D20](#d20--surveyed-and-deliberately-deferred-or-rejected));
rewriting the JSONL on compaction (breaks append-only/greppable); pruning `read` outputs (would
invalidate hashline anchors).
**Phase.** **Now (Phase 1.5)** for `/compact` + pruning + resume; **auto-threshold** trigger deferred.
The summary call needs a live-model verification pass (the pure cut/prune/rebuild are unit-tested).

## D18 — Destructive-command guard: a mode-independent safety floor on `bash`
**Decision.** A small **pure** blocklist (`dangerousCommand(cmd)` in `dispatch.ts`) hard-refuses a
handful of catastrophic shell patterns — `rm -rf /` / `~` / `*`, fork bombs, `mkfs`, whole-disk `dd`,
`> /dev/sda`, writes to `/etc/passwd`, `:(){ :|:& };:`, `curl|sh` / `wget|sh` pipe-to-shell — **in
both PLAN and EDIT modes**, for the **model's `bash` tool only**. It runs inside `dispatch` before
execution and returns a `Refused (guard): …`.
**Why.** EDIT mode auto-runs **everything** ([D4](#d4--permissions-two-human-switched-modes-enforced-at-dispatch));
a self-hosting agent that fat-fingers `rm -rf` shouldn't be able to wipe the machine while you're
away. This is an **orthogonal safety floor**, not a permission tier — it does **not** touch the
human-only mode switch (D4 stays intact) and does **not** gate the human's `!`-shell escape
([D14](#d14--tui-input-affordances--files--shell--commands-with-autosuggest): the human is trusted).
It is a hand-built guardrail and stays that way ([D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts)).
**Rejected.** oh-my-pi's full per-tool approval tiers (`read`/`write`/`exec` + per-tool prompt policy)
— that's a y/n confirm UI + policy layer nerve deliberately rejected in [D4](#d4--permissions-two-human-switched-modes-enforced-at-dispatch);
a guard that prompts (nerve's loop never blocks mid-turn — it hard-refuses instead); making it
model- or config-editable (it's a guardrail; agent-authored guardrails are forbidden).
**Phase.** **Now (Phase 1.5).** The pattern list grows by judgement, recorded here.

## D19 — TTSR ("stream rules"): blessed, deferred — nerve's signature interception capability
**Decision.** **Deferred, but recorded as the intended headline feature**, because it's the purest
expression of what nerve *is*. TTSR = user-defined **regex rules that watch the live token stream**;
on a match the turn is **aborted mid-generation** and a `<system-interrupt>` correction is injected
before the model continues. This is exactly nerve's "splice into the wire mid-thought" thesis and a
direct generalization of the existing **stop-guard** interceptor ([D9](#d9--interceptors-v1-the-four-that-ship)):
stop-guard already aborts on a banned pattern — TTSR adds a **rules file** + a **re-inject + continue**.
**Why deferred.** It earns a DECISIONS slot now so the design space is claimed and the stop-guard isn't
"finished" in a way that blocks it, but it depends on the reasoning-artifact replay being solid across
both providers (re-injecting mid-turn must not corrupt DeepSeek `reasoning_content` / Gemini
`thoughtSignature` replay), which wants the Gemini provider to exist first.
**Rejected.** Building it before the second provider (replay-safety unproven); folding it into
stop-guard as a config flag (it deserves its own rules format + interrupt template).
**Phase.** After the Gemini provider lands and replay is proven on both. Likely nerve-authored, since
it's an interceptor seam ([D7](#d7--self-hacking-runtime-hot-swap-of-seams)) — a strong self-hack trophy.

## D20 — Surveyed and deliberately deferred or rejected
**Decision.** From the same survey, the following were considered and **left out**, with the reason,
so they aren't re-proposed without new information:
- **Todo-list tool + reminder** (claude-code `TodoWrite`, oh-my-pi `todo_reminder`) — *defer, likely
  adopt.* A structured checklist the model maintains over long multi-step work; just one more tool
  ([D2](#d2--tools-earn-their-place-by-a-rent-heuristic-not-a-fixed-count)). Cheap; not load-bearing
  for the kernel, so it waits until self-hosting exercises long tasks.
- **Queued / steering input** (type the next instruction while streaming; `followUp`/`steer`) —
  *defer.* Nice TUI UX, pure front-end (a pending-message buffer), no engine change. Add during a
  TUI-polish pass.
- **Handoff** (summarize → brand-new session) — *defer in favour of [D17](#d17--context-maintenance-lean-compaction--tool-output-pruning).*
  Overlaps compaction; pick one first. Revisit if "fresh session, carried context" becomes a real need.
- **Session tree / `/branch` / `/tree`** — *defer (heavy).* Turns the linear append-only JSONL
  ([D8](#d8--persistence-append-only-jsonl-per-session-resume-by-replay)) into a tree model. Real
  power, large complexity; only if branch-exploration becomes a felt need.
- **Autonomous cross-session memory** (oh-my-pi `memory://`, background extraction → `MEMORY.md`) —
  *defer.* Two model passes + a SQLite job queue; nerve already gets project memory from Claude-compat
  `CLAUDE.md` ([D12](#d12--claude-compatibility-load-claudemd--skills-from-claude-and-claude)). Too
  much machinery for the value right now.
- **Claude-compatible external hooks** (`.claude/hooks/pre|post`) — *defer.* nerve's hot-swappable
  interceptors ([D7](#d7--self-hacking-runtime-hot-swap-of-seams), [D9](#d9--interceptors-v1-the-four-that-ship))
  are the in-house equivalent; only add external-script discovery to *share* hooks with Claude Code.
- **opencode "Context Epochs"** (inject mid-conversation system messages when effective state — date,
  model — changes, preserving the provider cache prefix) — *note only.* Elegant and relevant to our
  replay concerns, but a sophisticated abstraction; not worth its weight yet.
- **Hard-rejected (charter violations):** MCP, plugin marketplaces, multi-agent coordinators/teams,
  voice, remote agents, IDE bridge, x402 payments, auto-dream. These are exactly the "provider
  zoo / generic framework" bloat the [README](../README.md) and [AGENT_RULES](AGENT_RULES.md) reject.
  Not deferred — **out of scope by design.**
**Why.** Recording the *no*s (with reasons) is as load-bearing as the *yes*es — it stops a future
session (human or nerve) from re-litigating settled scope.

## D21 — Default communication style: caveman, in the system prompt (not a skill)
**Decision.** nerve's **default output style is "caveman"** — terse, fragments, drop
articles/filler/pleasantries, full technical substance kept exact (code/errors/paths verbatim). It
lives **in the shipped system prompt** (`prompts/system.md`), on by default, no opt-in. The prompt
also tells the model to **drop caveman for one response** when the user asks to explain *in detail /
comprehensively / thoroughly*, for safety-critical confirmations, for misread-prone multi-step
sequences, or when asked to clarify — then resume.
**Why.** The user wants it always-on and shipped with the harness, droppable on request. A **system
message** is the leanest home: it needs no skill-injection mechanism, no always-apply flag, no per-turn
body loading — just text in the prompt that already feeds every turn ([D12 note](#)) and hot-swaps via
the file. Saves output tokens by default; the drop-rule keeps detailed explanations readable.
**Rejected.** A **skill** marked `alwaysApply`/`default` (the user's first idea, then reversed): that
needs a real always-on skill-injection seam (discover body → inject into system prompt → toggle) — more
machinery than a default style warrants, and skill *invocation* is otherwise deferred to Phase 2 ([D12](#d12--claude-compatibility-load-claudemd--skills-from-claude-and-claude)).
A separate "output styles" subsystem (claude-code has one) — overkill for one default.
**Note.** It reads oddly at a glance (terse caveman prose) — **intentional, not a bug**; don't "fix"
it. The system prompt is agent-editable/hot-swappable, so the style can be tuned by editing the file.

---

## Standing micro-defaults (low-risk, stated so they're not guessed)
- **Interrupt:** `ESC` aborts the current streaming turn (via the provider `AbortSignal`);
  `Ctrl+C` exits the app.
- **Mode switch:** `Shift+Tab` cycles PLAN ↔ EDIT (human-only, [D4](#d4--permissions-two-human-switched-modes-enforced-at-dispatch));
  plain `Tab` also toggles it **when no autosuggest popup is open** (popup-`Tab` accepts the suggestion).
- **Shell:** the model's `bash` tool and the `!`-shell escape run via the user's shell — `Bun.env.SHELL`
  (zsh on this setup), falling back to `zsh` — not hardcoded `bash`. Non-interactive (`-c`); no rc sourcing.
- **Startup preflight:** `index.ts` checks required external deps on PATH (the shell + `git`) and exits
  with a clear error if any is missing — nerve shells out to them, so fail fast over failing mid-task.
- **Sessions:** `/resume [id]` switches to an existing session (default = most recent that isn't the
  current one); `/sessions` lists them; `/sessions delete <id>` removes one (not the current — that's `/drop`).
- **Hot reload:** `/reload` command + keybind (`Ctrl+R`) ([D7](#d7--self-hacking-runtime-hot-swap-of-seams)).
  Must roll back to the old module on a failed import once nerve self-edits ([D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts)).
- **System prompt:** `prompts/system.md`, read fresh per turn (hot-swappable, agent-editable).
- **Tool shape:** `{ name, description, parameters (JSON Schema), readonly: boolean, run(args, ctx) }`.
  JSON Schema maps cleanly to Gemini `functionDeclarations` and DeepSeek `tools`.
- **Working dir:** wherever nerve is launched (self-hacks when launched in the nerve repo, [D1](#d1--primary-purpose-personal-coding-agent)).
- **Turn cap:** a configurable max tool-iteration bound per turn as a runaway safety net.
