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

## D6 — Subagents: a read-only `task` tool over the re-entrant loop
**Decision.** **Built** (Phase 1.5). Because `loop.ts` is a pure, re-entrant function over a session, a
subagent is just "run the loop with a fresh **ephemeral** session + a cheaper profile, return only the
final summary" — `src/subagent.ts` (`runSubagent`) + the `task` tool (`src/tools/task.ts`). Guardrails baked
in: the subagent runs in **PLAN mode** (read-only, enforced at dispatch — no edits/shell), on an **ephemeral
session** ([D31](#d31--persistence-on-bunsqlite-sessions-in-a-per-project-db-not-jsonl-skillsconfig-stay-files): accumulates in memory, **writes no DB rows**, never shows in `/sessions`), with a curated
toolset = the registry's **`readonly` tools minus `task`/`askUser`/`todo`** (so **no recursion**, no human
prompts), bounded by `maxTurns` (12), abortable via `ctx.signal` (ESC). The model is config-driven — the
**`subagent`-flagged** catalog entry (`deepseek-v4-flash`), falling back to the default (no hardcoded id).
`task` is itself `readonly:true` (it only spawns a read-only subagent → PLAN-safe). Returns the subagent's
final assistant message (capped 8 k).
**Why.** Offload context-heavy, isolable lookups (search across many files, trace callers, digest docs)
to a clean cheap context so the main thread stays lean — the standard delegation win, made nearly free by
the re-entrancy constraint we held to in Phase 1. Read-only by default sidesteps subagent/main edit races
and recursion fork-bombs; editing subagents can come later if a real need appears.
**Rejected.** Predefined named-role subagents (more structure up front than warranted); editing/EDIT-mode
subagents (race + recursion risk for v1 — read-only research is the 80% case); persisting subagent sessions
(ephemeral keeps `/sessions` clean); a hardcoded subagent model id (a catalog flag instead).
**Phase.** Built (Phase 1.5), live-verified: headless run → main agent called `task` → subagent grepped/read
and reported `pickTheme` at `src/tui/theme.ts:81` + its return type. Tests: `tests/subagent.test.ts` (fake provider).

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
**Decision.** Each session is a file **`<sessions-dir>/<id>.jsonl`** (the dir is per-project under
`~/.nerve`, see [D22](#d22--all-state-lives-under-nerve-namespaced-per-project-not-in-the-repo); originally `./.nerve/sessions`) with **typed lines**, appended
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
1. **Token-tap → JSONL** — tees every `text`/`reasoning` delta + `usage` to the session's JSONL
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
2. **An `lsp` query tool** — one tool with an `op` enum: `definition`, `references`, `implementation`,
   `typeDefinition`, `hover`, `documentSymbol`, `workspaceSymbol`. Args: `path`, `line`, `character`
   (1-based, editor coords), plus `query` for `workspaceSymbol`. It is `readonly: true`, so it
   works in **PLAN mode** too — navigation/context-gathering and diagnosis are read-only.

**Client.** A **raw JSON-RPC-over-stdio** client, **zero dependencies**: `Bun.spawn` the server,
Content-Length byte-framing, request↔response id correlation, answering the few server→client requests
(`workspace/configuration` etc.) so it can't hang, `textDocument/didOpen`+`didChange` sync, cache
`publishDiagnostics` by URI, capture server `capabilities`, and the `initialize`/`shutdown` lifecycle.
`src/lsp/`: `client.ts` (one connection), `manager.ts` (catalog, lazy spawn, root detection,
diagnostics aggregation, capability-routed queries), `format.ts` (pure result mappers).

**Config.** A committed **`config/lsp.json`** (+ schema, IntelliSense like `models.json`; a
`~/.nerve/lsp.json` overrides it, [D22](#d22--all-state-lives-under-nerve-namespaced-per-project-not-in-the-repo)).
Each entry is `{ id, extensions, command, args?, rootMarkers?, install? }`. **MULTIPLE servers may share
an extension** — Python runs **pyrefly** (`pyrefly lsp`: types/hover/defs) **+ ruff** (`ruff server`:
lint) at once; diagnostics aggregate (tagged by server), queries route to whichever **advertises the
capability** (ruff has no `definitionProvider`, so it's auto-skipped for queries). Servers spawn
**lazily** per file's language, kept warm, killed on exit. Seeded: **vtsls** (`vtsls --stdio`) for TS/JS,
**pyrefly + ruff** for Python.

**Ship vs. require → require, error clearly.** nerve does **not** bundle/install servers; `command`
must be on PATH. A missing server **degrades gracefully** with an actionable hint from the entry's
`install` field (e.g. `uv tool install pyrefly`, `bun install -g @vtsls/language-server`) — never a
hard crash. Diagnostics are best-effort (a fixed settle window after sync); `--no-lsp` disables it.
**Ruff is diagnostics-only, never auto-format** — auto-formatting after an `edit` would instantly
stale the hashline anchors ([D3](#d3--edit-mechanism-hashline-only-content-anchored)).

**Why.** Diagnostics-on-edit is the highest-frequency win for a coding agent (catch breakage without a
`bash tsc` round-trip); the query tool is high-reuse context-gathering
([D2](#d2--tools-earn-their-place-by-a-rent-heuristic-not-a-fixed-count)). Raw client keeps it
dependency-free and hackable, matching the raw-fetch provider ethos. Requiring pre-installed servers
matches the user's `uv`/bun toolchain and keeps nerve lean (no cross-platform binary bundling/rot).
**Rejected.** A `vscode-jsonrpc`/full LSP library (deps + less hackable); **shipping** the servers
(bloat, platform-specific, version drift — the user installs them); one-server-per-extension (Python
needs pyrefly **and** ruff); ruff auto-format on edit (breaks hashline); auto-detecting servers from PATH.
**Phase.** **Built (Phase 1.5)** and live-verified against pyrefly + ruff (aggregated diagnostics,
hover, documentSymbol, missing-server hint). vtsls path verified for the missing-server case (install
to exercise live). Rust/Zig servers deferred (just add catalog entries when wanted).

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
**Phase.** `CLAUDE.md` layering is cheap and lands with the **Phase 1** system-prompt assembly; skill
**discovery + listing** lands Phase 1.5; skill **invocation is built** (Phase 1.5): `/<skill> [args]`
loads the SKILL.md body lazily (progressive disclosure — `loadSkillBody`), expands args like a command
([D16](#d16--markdown-slash-commands-claude-compatible)), and runs it as a turn (a compact `/<skill>` echo, not the whole body). The model also gets
relevant skills **automatically** via the language packs ([D24](#d24--language-packs-conditional-skills--native-post-edit-hooks)). Keep the loader a pure function of
the filesystem so it hot-swaps with `/reload` like the other seams ([D7](#d7--self-hacking-runtime-hot-swap-of-seams)).

**Correction (D37) → resolved (D42, 2026-06-08).** The `CLAUDE.md` *layering* described above shipped late:
for a long time there was no `src/context.ts` and the system-prompt assembly was only `system.md` + skills +
`PLAN_NOTE` + language packs (the **skills** half was built via `skillRoots`/`src/paths.ts`; the
instruction-file half was not). It is **now built as D42** — `src/context.ts` `loadProjectMemory` +
`baseSystem` in `index.ts`, resolving `@imports`, **expanded to `AGENTS.md`** alongside `CLAUDE.md`.

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
**Phase.** Affordance logic + `/drop` + built-in commands: **Phase 1**. Skill invocation: **built**
(Phase 1.5, [D12](#d12--claude-compatibility-load-claudemd--skills-from-claude-and-claude)). Richer suggestions: later. Interactive rendering needs a real-terminal verification pass.

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
the `commandRoots` dirs (`~/.nerve` + `.claude` project/user, [D22](#d22--all-state-lives-under-nerve-namespaced-per-project-not-in-the-repo)) for `*.md`, parse
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

## D22 — All state lives under `~/.nerve`, namespaced per project (not in the repo)
**Decision.** nerve writes **nothing** into the working directory. Everything lives under a global
**`~/.nerve`** (override `$NERVE_HOME`), namespaced by project — mirroring `~/.claude/projects`:
```
~/.nerve
├── skills/ · commands/ · models.json     # global (models.json overrides the bundled catalog if present)
└── projects/<slug>/
    ├── sessions/   # this project's transcripts (was ./.nerve/sessions)
    ├── skills/     # project-level skills
    └── commands/   # project-level slash commands
```
- **Project `<slug>` = the absolute cwd with `/` → `-`** (e.g. `/home/naz/Documents/nerve` →
  `-home-naz-Documents-nerve`) — **collision-free** and the **same encoding `~/.claude/projects` uses**.
  (We also use Claude's term **`projects/`**, not `workspaces/`, for consistency.)
- **Sessions** moved out of `./.nerve/sessions` to `~/.nerve/projects/<slug>/sessions`
  ([D8](#d8--persistence-append-only-jsonl-per-session-resume-by-replay) unchanged otherwise).
- **Skill/command discovery** roots (most-specific first, dedup first-wins): project nerve →
  project `.claude` → global nerve → user `.claude` ([D12](#d12--claude-compatibility-load-claudemd--skills-from-claude-and-claude)/[D16](#d16--markdown-slash-commands-arguments-templates-claudenerve-compatible)).
- **Config:** the committed `config/models.json` stays the default (D5), but a `~/.nerve/models.json`
  **overrides** it when present, so config can live with the user instead of nerve's install dir.
- Centralized in **`src/paths.ts`** (`nerveHome`/`projectSlug`/`projectDir`/`sessionsDir`/`skillRoots`/
  `commandRoots`/`ensureLayout`); `ensureLayout()` runs at boot to create the dirs.
**Why.** The user does **contribution work** across many repos and doesn't want a `.nerve/` folder
nobody else uses showing up in each one. A global home keeps repos clean; the encoded-path slug keeps
two same-named repos (`cli`, `docs`, …) from silently sharing one session history, and matches the
Claude ecosystem nerve already mirrors ([D12](#d12--claude-compatibility-load-claudemd--skills-from-claude-and-claude)) — including its `projects/` naming.
**Rejected.** In-repo `./.nerve` (the pollution being fixed); a **plain-basename** slug (collides
across same-named repos → merged histories); **basename+hash** (readable + unique, but the user chose
encoded-path for Claude-compat); `workspaces/` as the dir name (renamed to `projects/` to match Claude);
moving the *committed* model catalog out of the repo (loses the schema-backed IntelliSense of
[D5](#d5--model-selection-keys-in-env-models-in-a-committed-catalog) — kept as default, global only overrides).
**Phase.** Built now (Phase 1.5). Old `./.nerve/sessions` transcripts are **not** auto-migrated (copy
them under `~/.nerve/projects/<slug>/sessions` if you want them resumable).

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

## D23 — Notebooks: marimo (pure-`.py`, reactive), no server — not Jupyter `.ipynb`/jupyterlite
**Decision.** nerve's notebook format is **marimo**, whose notebooks are **pure `.py`** (reactive — a
cell DAG, no hidden kernel state). Consequences:
- **Read/edit/append cells = the existing file tools.** It's `.py`, so `read`/`edit` (hashline) work
  unchanged and **pyrefly + ruff diagnostics fire on every cell edit for free** ([D10](#d10--lsp-support-both-seams-raw-zero-dep-client-schema-backed-config)) — and marimo itself
  *federates pyrefly* as its LSP, so this is the same intelligence marimo's own editor uses. No new editing machinery.
- **Run/check = the `notebook` tool** (`src/tools/notebook.ts`, `readonly:false` → EDIT-only): op `run`
  executes the notebook **headlessly** via `marimo export ipynb … --include-outputs` and parses the
  per-cell outputs/errors; op `check` runs marimo's static lint (the **single-definition rule**, cycles —
  marimo-specific issues pyrefly/ruff can't see, which marimo itself recommends agents run after edits).
  No server.
- **uv provisions marimo** (`uv run --with marimo --with nbformat …`); the notebook's own imports come
  from the **project's uv env**. Missing `uv` → an install hint (same require-not-ship pattern as LSP).
- **Persistence without a server:** `mo.persistent_cache` stores results on disk (`__marimo__/cache/`),
  reused across runs — covers the "don't recompute the expensive cell" need.
**Why.** For a **terminal-only, solo, AI-agent** workflow, marimo's `.py` format means nerve's best
tools (hashline edit + pyrefly/ruff LSP) apply with **zero new code**, and reactivity **eliminates the
hidden-kernel-state bug class** — the failure mode an agent is *worst* at (it can't see kernel state).
It's ~10× leaner than an `.ipynb`+kernel subsystem and fits nerve's ethos. The user was willing to
switch formats, so this beats preserving `.ipynb`.
**Rejected.**
- **jupyterlite** — browser/WASM (Pyodide) only; no headless terminal execution. Unusable by a terminal agent.
- **`.ipynb` + persistent `ipykernel`** (a Python kernel bridge with LSP-style lifecycle) — true Jupyter
  semantics + in-memory persistent state, but a whole new subsystem (kernel bridge + JSON cell-edit tool
  + notebook-aware LSP) and the hidden-state bug surface. In-memory persistence only wins for
  **non-serializable** live handles (DB/socket/GPU) or sub-ms iteration — niche for an agent; disk
  `mo.persistent_cache` covers the common case.
- **A marimo/jupyter server** tied to the harness lifecycle (the user offered) — unnecessary: marimo runs
  headless as a script and persists to disk. Revisit only if non-serializable live state becomes central.
- **Shipping** marimo — uv provisions it on demand.
**Phase.** Built now (Phase 1.5), live-verified (per-cell stdout + error capture). Rust/Zig-style
expansion N/A; an `ipykernel` runner can be added *alongside* later if persistent in-memory state is ever needed.

## D24 — Language packs: conditional skills + native post-edit hooks
**Decision.** A language can ship a **pack** (`src/langpack.ts`) of two things, both **built-in (native)**
and activated when a file of that language is **touched** (read/write/edit) — the same trigger as the
LSP servers ([D10](#d10--lsp-support-both-seams-raw-zero-dep-client-schema-backed-config)), but independent of them (works under `--no-lsp`). **Two packs ship: Python** (pyrefly + ruff)
and **TypeScript/JS** (a `prettier --write` fixer + a prettier skill; no checker — vtsls' LSP already
reports diagnostics on edit). A missing tool surfaces a **chained install hint** (shared `installHint`
in `src/toolchain.ts`: `uv tool install pyrefly`, `bun install -g prettier`, and "install bun/uv first"
if the package manager itself is absent — D10/D24 use the same helper). Python's details:**
- **Skills** — `skills/pyrefly/SKILL.md` + `skills/ruff/SKILL.md` + `skills/marimo/SKILL.md` (how to use
  them; marimo ships here because notebooks are Python). **Hidden** (not in `skillRoots`, so not in the
  `/` popup); their bodies are **injected into the system prompt** only once Python is in play
  (progressive disclosure). So the agent learns the Python toolchain exactly when relevant.
- **Default (always-on) skills** — `defaultSkills()` injects `skills/git-commit/SKILL.md` into **every**
  system prompt regardless of language (cached). It's the skill-equivalent of the caveman system rule
  ([D21](#d21--communication-style-caveman-by-default-system-message-not-skill)): the agent should always
  know nerve's Conventional-Commit conventions, so the guidance is shipped + always loaded, not on-demand.
- **Post-edit hooks** — after an **editing turn** (EDIT mode), nerve auto-runs, on **just the `.py`
  files edited that turn**: `pyrefly infer` → `ruff check --select I --fix` → `ruff check --fix` →
  `ruff format` (the **fixers**, edit in place), then `pyrefly check` + `ruff check` (the **checkers**,
  reported as a `⚙ post-edit` summary). The agent doesn't call these by hand.
- **Triage loop (the agent decides, no hardcoded cap):** if the checkers still report issues, nerve
  hands the summary back (`triagePrompt`) and the **agent triages** — fix *critical/quick* now, *defer
  non-critical*. There's **no retry counter**: the agent's own choice ends the loop — fixing edits the
  files (checks re-run), deferring means it doesn't edit, so the loop stops naturally (no edits → no
  hooks → no continuation). The one safety: if the agent edits but the **issue summary is unchanged**
  (stuck), nerve stops. (Only as strict as the user's pyrefly/ruff config — the default pyrefly "basic"
  preset catches undefined names etc., not every type mismatch.)
- Plumbed by two `ToolContext` sets the tools record into: **`touched`** (sticky → skill injection) and
  **`edited`** (per-turn → which files the hooks run on). Missing `pyrefly`/`ruff` → skipped with a note.
**Why.** The user wants the pyrefly/ruff *guidance* loaded only when working in Python, and the
formatters/fixers/checkers run **automatically** rather than relying on the agent to remember. **Turn
boundary** is the safe time to reformat: anchors from this turn are spent, and the next turn re-reads
(a stale anchor hard-rejects, [D3](#d3--edit-mechanism-hashline-only-content-anchored)) — which is why
auto-format is fine here but *not* mid-edit (the reason ruff-format isn't an LSP-on-edit action, [D10](#d10--lsp-support-both-seams-raw-zero-dep-client-schema-backed-config)). Reuses the existing tools + the LSP-on-`.py` trigger; ~one module.
**Rejected.** Claude-style **`settings.json` external hooks** ([D20](#d20--surveyed-and-deliberately-deferred-or-rejected)) — nerve's are native/built-in, not a
user-config hook framework (this is the concrete need). Shipping the skills in `skillRoots` — they'd
show in the `/` popup always (the user wants them hidden until the language is active). Running fixers
**mid-edit** (stales hashline anchors). **Whole-project** format/lint (only the edited files). A
**hardcoded retry cap** (`MAX_AUTOFIX`) — the user hates magic numbers; the agent **triages** instead,
and a *no-progress* check (unchanged issues after an edit) is the only stop, not an arbitrary count.
**Phase.** Built now (Phase 1.5), live-verified (messy `.py` → annotated/sorted/formatted, checkers
clean; an undefined-name error → `issues:true` → auto-fix loop). Add a language = a `LANGPACK` entry + its `skills/` files.

## D25 — A `todo` tool with a pinned, colored TUI panel
**Decision.** A `todo` tool ([D20](#d20--surveyed-and-deliberately-deferred-or-rejected) promoted) lets the agent keep a task list for multi-step
work: it passes the **full list** each call (replace, not patch), each item `{ content, status:
pending|in_progress|completed }`. It's **`readonly: true`** (touches only ephemeral UI state) so it's
PLAN-safe. The surface displays it via a new `ctx.setTodos` callback: the **TUI renders a pinned,
colored panel** above the input (`☑ todos · done/total`; `✓` green done · `▸` yellow-bold active · `○`
muted pending), updated **in place**; headless prints the checklist. The tool also **returns the
checklist as its result**, so the model re-sees its plan in context each turn.
**Why.** The standard "stay-on-track over a long task" feature (claude-code's `TodoWrite`, which the
models are already primed for); the user missed having it. Lean — one tool + one panel, no new engine.
**Rejected.** Per-item patch ops (replace-the-whole-list is simpler and what the models expect);
**persisting** todos to the session JSONL (it's ephemeral working state — the tool *result* is in
history so the model keeps the plan, but the panel starts fresh on resume); a separate reminder
subsystem (the always-visible panel + the in-context result suffice). `activeForm`/present-tense
labels (kept to `content` + `status` for now).
**Phase.** Built now (Phase 1.5).

## D26 — Session titles, auto-generated from the first exchange
**Decision.** Each session gets a short **title**. After the first assistant turn, nerve fires a cheap
**one-shot** (`summarize()` + `prompts/title.md`) to name it — **async/non-blocking** (the answer isn't
delayed). Persisted as a `{"t":"title"}` line (latest wins on resume). Shown in the **transcript header**
(`◆ <title>`), the **`/sessions`** list (cyan), and restored on resume. Best-effort — errors ignored.
**Why.** The user wanted the session "titled by the agent on the first response." Auto-generating from
the first exchange is more reliable than the alternatives and reads the actual content; it also makes
the `/sessions` list and resume far more legible.
**Rejected.** A `title` tool the agent must call on turn 1 (forces a tool round-trip → latency every
session start); parsing a marker out of the *streamed* first response (fragile stream-stripping).
**Phase.** Built (TUI). Headless doesn't auto-title yet; the persisted title still benefits `/sessions`.

## D27 — Lazy session file (no empty transcripts)
**Decision.** A session's JSONL is created on the **first write**, not at construction — so opening the
TUI and not sending anything leaves **no empty file**. The sink opens lazily in `writeLine`; `close()`
is a no-op when nothing was written.
**Why.** The user noticed every TUI launch littered an empty `<id>.jsonl`. Working state shouldn't
touch disk until there's something to persist.
**Phase.** Built.

## D28 — A `fetch` tool: Bun-native, HTML → Markdown
**Decision.** A `fetch` tool over **Bun's native `fetch`** (no deps): HTTP(S) **GET** a URL → **HTML is
converted to Markdown** (lean regex converter `htmlToMarkdown` — keeps headings/links/lists/code/bold,
drops `<script>`/`<style>`/chrome, decodes entities **once at the end** so code with `&lt;…&gt;` survives),
**JSON** pretty-printed, other text as-is. `readonly:true` (a GET for info-gathering → PLAN-safe). Caps:
30s timeout, browser UA, follows redirects, skips binary/>5 MB, output capped at 60 k chars. The export
is `fetchTool` (not `fetch`) so it doesn't shadow the global.
**Why.** nerve had no web access; the user wants the agent to read pages/docs/JSON APIs. HTML→Markdown
**cuts tokens** and reads better. Bun-native + a small local converter keeps the zero-dep ethos.
**Rejected.** A `turndown`/`html-to-text` **dependency** (~50 lines of local code suffices); a sub-model
summarization of the page (the agent reads the Markdown directly — leaner, no extra call); non-GET
methods (read-only for now). **Refine later:** swap the regex converter for Bun's `HTMLRewriter` if quality demands.
**Phase.** Built, live-verified (example.com → Markdown).

## D29 — Responsive TUI: main column + collapsible sidebar (web-app mindset)
**Decision.** The TUI root is a flex **row**, not a column: a **`mainCol`** (`flexGrow:1`, `minWidth:0`)
holding the existing stack (transcript · todo panel · popup · input · status bar) plus a fixed-width
(**34-col**) **`sidebar`** beside it with stacked bordered panels, each given a **distinct accent border**
(the box title is drawn in the border colour — OpenTUI has no separate title colour — so this is what makes
the titles legible + tells the panels apart: session=cyan, skills=magenta, lsp=accent, tools=green,
subagents=yellow, files=orange; transcript box=accent). **session** (model · mode badge · cost · ctx ·
balance — the *session title* moved to the transcript box header, `nerve` until auto-titled), **skills**
(the skills *loaded into context now*: the always-on defaults + active language packs, `activeSkillNames`),
**lsp** (the spawn-attempted language servers + state — `●` running · `◌` spawning · `✗` failed/missing,
from `Lsp.serverStatus()`, D10), **tools** (the main agent's tool calls this session + status — `●`
running · `✓` ok · `✗` error, fed by the loop's `onToolStart`/`onToolResult`, **plus the post-edit hooks**
— ruff/prettier/pyrefly — surfaced via `runHooks`'s `onStep` callback as they run), **subagents** (this
session's `task` runs + status `●`/`✓`/`✗`, [D6](#d6--subagents-a-read-only-task-tool-over-the-re-entrant-loop)), and **files**
(the session's touched files, most-recent first; `✎` = written/edited, `·` = read-only — `flexGrow` fills
the remainder). Each compact panel keeps a **`(none …)` placeholder row** when empty so it never collapses
to a thin border; the files pool's height cap subtracts the others so nothing overflows. The sidebar **collapses on `Ctrl+B`** and
**auto-hides** when the terminal is narrower than **100 cols** (the main column needs the room) — re-checked
on a guarded `renderer.on("resize")`. Both panels use the proven **fixed-pool-of-`TextRenderable`-rows**
pattern (like the todo panel, [D25](#d25--a-todo-tool-with-a-pinned-colored-tui-panel)); the files pool is
capped to the terminal height so it never overflows. `renderSidebar()` is a **no-op while hidden**, and the
files panel is fed by the same `langTouched`/`sessionEdited` sets the language packs already track —
**zero new bookkeeping in the engine**. State resets with the session (`/drop`, `/resume`). The bottom
**status bar shows only when the sidebar is hidden** (`status.height = visible ? 0 : 1`) — the session
panel already carries model/mode/cost/ctx/balance, so we don't duplicate it; the streaming `●` moves into
the session panel while the sidebar is up.
**Why.** The user wanted a "web-app mindset" — surface what matters (live session economics + what's been
touched) in flexible panels that adapt to full / half / quarter-screen widths, collapsible to a single
column. OpenTUI's flexbox makes this a layout change, not an engine change: the row + `flexGrow`/`minWidth`
do the responsiveness; the engine (loop/providers/session) is untouched.
**Rejected.** A reactive React/Solid binding (the imperative core + a `renderSidebar()` on the existing
update points is enough — no new runtime); one multi-line `TextRenderable` per panel (the fixed-row pool is
the codebase's proven, height-exact pattern); a `ScrollBox` for files (height-capping the pool is simpler
and overflow-safe); persisting touched-file history across `/resume` (we don't replay tool calls — the panel
starts empty and refills as the agent works).
**Phase.** Built (Phase 1.5). **Needs live verification in a real terminal** — typecheck validates the
OpenTUI props but there's no TTY in the build env, so the visual layout (panel sizing, breakpoint, toggle)
must be eyeballed. Add a panel = another bordered box + a pooled-row render in the sidebar block of `app.ts`.

## D30 — TUI theme inherited from ghostty (Adwaita / Adwaita Dark), GNOME light/dark aware + **live-following**
**Decision.** The palette lives in `src/tui/theme.ts` (`pickTheme()`), not hardcoded in `app.ts`. We mirror
the user's ghostty `theme = light:Adwaita,dark:Adwaita Dark` by reading the **GNOME color-scheme** —
`gsettings get org.gnome.desktop.interface color-scheme` (the *same* signal ghostty resolves that line
against) — and applying the matching Adwaita palette. Accent colours are ghostty's own
`/usr/share/ghostty/themes/Adwaita[ Dark]` values; the chrome roles a 16-colour terminal palette doesn't
define (border/panel/selection/dim) are **derived** for legibility on each ground (and, for light, accents
darkened to the libadwaita ramp so coloured text + the inverted EDIT/PLAN badges stay readable on white).
`$NERVE_THEME=light|dark` forces one; off-GNOME falls back to dark.
- **Live-following (zero loss).** `app.ts` runs `gsettings monitor …color-scheme` (a subprocess, killed on
  exit like the LSP servers) and **re-themes in place** when the system flips — no relaunch. The palette is
  one mutable `theme` object (`Object.assign(theme, pickTheme())` in place — so every reader, app.ts and the
  extracted panel modules alike, sees the new colours), the markdown `SyntaxStyle` is rebuilt via
  `buildSyntaxStyle(theme)` (theme.ts owns the colour→style map), chrome props (`borderColor`/
  `bg`/`fg`/`textColor`) are reassigned, and **every transcript line re-renders itself**: each line keeps a
  re-runnable thunk — `text` lines rebuild their `t`…`` content (re-reading the palette), `plain`/streaming
  lines (incl. the accumulating reasoning line) recolour `fg`, `md` blocks swap `syntaxStyle`. So **nothing
  is lost** on a switch (vs. re-rendering only `session.messages`). A change arriving mid-stream is **deferred**
  to turn end (`pendingRetheme` → `drainRetheme`) so we never repaint a live-streaming block.
**Why.** The user runs ghostty with system-following Adwaita and wanted nerve to match *and track* it, not
clash with a fixed Tokyo-Night or need a relaunch. Reading the *same* gsettings key ghostty uses keeps them
in lockstep without parsing ghostty's config.
**Rejected.** **Startup-only** detection (the user explicitly wanted live switching); **re-rendering from
`session.messages`** on switch (drops ephemeral scrollback — tool-result lines, `/help`, `!`shell — so the
per-line thunk model is used instead, full fidelity); **parsing ghostty's config/theme files at runtime**
(path varies by distro/install — the values are stable, so we embed them and read gsettings only for the
light/dark choice); using the terminal's own ANSI colours (nerve needs specific syntax + chrome roles ANSI
16 doesn't pin down); keeping Tokyo Night (clashed with the user's Adwaita ghostty).
**Phase.** Built (Phase 1.5). Verified: auto-detect (this box is `prefer-dark` → Adwaita Dark `#1d1d20`;
`NERVE_THEME=light` → `#ffffff`), `gsettings monitor` is a valid long-running command, app.ts loads clean.
**Still needs a real-terminal eyeball** — the live in-place re-theme (toggle GNOME dark/light while nerve
runs) and colour legibility (esp. light mode) can't be seen without a TTY.

## D31 — Persistence on `bun:sqlite`: sessions in a per-project DB (not JSONL); skills/config stay files
**Decision.** Runtime **state** moves from append-only JSONL to **SQLite via `bun:sqlite`** (built-in —
zero external dep), one DB per project at `~/.nerve/projects/<slug>/nerve.db` (`src/db.ts`, cached
connection, WAL). **Sessions** are the first (and currently only) resident: tables `sessions(id, title,
created_at, updated_at)`, `messages(session_id, seq, role, content, reasoning, tool_calls, tool_call_id)`,
`compactions(session_id, at, summary, first_kept)`. The `Session` **public API is unchanged** (loop.ts +
surfaces untouched): `addUser`/`commitAssistant`/`addToolResult` INSERT a message row at the global ordinal
(`seq`); resume = `SELECT … ORDER BY seq` with the latest compaction applied; lazy row on first write keeps
[D27](#d27--lazy-session-file-no-empty-transcripts); title is a column ([D26](#d26--session-titles-auto-generated-from-the-first-exchange)); compaction inserts a marker and **never deletes** rows
(so `first_kept` rebuilds the same shape, [D17](#d17--context-compaction-summarize-old-turns-on-demand-d17)). `listSessions`/`lastSessionId`/`sessionExists`/`deleteSession`
(`src/sessions.ts`) are now indexed queries; `deleteSession` cascades via FK. **Token-tap telemetry is
dropped** (it was JSONL `delta` lines, never read on resume — a row per token would bloat the DB).
**What stays files (deliberately):** **skills** (filesystem markdown — the whole point of Claude-compat
[D12](#d12--claude-compatibility-load-claudemd--skills-from-claude-and-claude); a DB would break interop + your editing them) and **config** (`.env` keys, committed
schema-validated `models.json`/`lsp.json`). SQLite is for *state*, not documents or config.
**Why.** The user chose one Bun-native substrate for stored state. The wins: indexed session listing/search
(replacing directory scans), a foundation for future text search (**FTS5**, built-in — no extension), and
transactional integrity, all with no external dependency.
**Rejected.** **Skills in SQLite** (breaks Claude-compat + file-editing — files are correct for documents);
**a memory store** (the user maintains CLAUDE.md/DECISIONS.md + has session resume; auto-memory is a
solution without a problem here — revisit only on a concrete cross-session-forgetting need); **sqlite-vec +
codebase RAG** (grep/glob/**LSP** beat semantic retrieval for code — precise, structural, never stale —
and sqlite-vec is a compiled native extension against the zero-dep ethos; if text search over sessions is
ever wanted, use built-in **FTS5**, not embeddings); keeping JSONL (loses queryability + the unified
substrate; the cat-able log is the only thing given up — an `/export` can restore it if wanted).
**Phase.** Built (Phase 1.5), live-verified: fresh `~/.nerve` → headless run created
`projects/<slug>/nerve.db` with the session row + both messages; full suite (155) green against SQLite.

## D32 — Parallel tool dispatch: read-only calls concurrently, mutating ones serially
**Decision.** When a single assistant turn returns multiple tool calls, the loop runs the **read-only**
ones **concurrently** (`Promise.all`) and the **mutating** ones (`write`/`edit`/`bash` — anything
`readonly:false`) **sequentially**. All calls in a turn are independent (the model issued them without
seeing any result), so this is safe; results are written back to the session in the model's **original
call order** so replay/compaction ([D17](#d17--context-compaction-summarize-old-turns-on-demand-d17)) stay deterministic. The split is by the existing `Tool.readonly`
flag via `isReadOnlyTool` (dispatch.ts); `onToolStart`/`onToolResult` carry the call **id** so a surface
can match out-of-order completions (the sidebar tools/subagents panels do). Because the `task` tool is
`readonly:true`, **multiple subagents in one turn run in parallel** for free — and each subagent's own
read-only tools parallelize too (same loop). Concurrency is safe end-to-end: read/grep/glob/fetch are
FS/network-idempotent, and the LSP client matches responses by id (`pending` map), so a shared `ctx.lsp`
handles concurrent queries.
**Why.** Context-gathering — read N files, grep M patterns, fan out research subagents — is the slow,
embarrassingly-parallel part of an agent turn; serializing it wasted wall-clock. Edits are few and want
ordering anyway.
**Rejected.** Parallelizing **everything** (two `edit`/`write` to one file race + stale hashline anchors
[D3](#d3--edit-mechanism-hashline-only-content-anchored); concurrent `bash` tramples cwd/files — `bash` is `readonly:false` so it always serializes, conservative
but correct even for a PLAN-safe read command); OS threads (needless — async concurrency suffices for I/O).
**Phase.** Built (Phase 1.5), live-verified: a turn with two `task` calls ran both subagents concurrently
(`pickTheme`→`theme.ts:81`, `runSubagent`→`subagent.ts:33`); unit test asserts read-only interleave +
mutating serialize + call-order results (`tests/loop.test.ts`).

## D33 — A `search` tool: DuckDuckGo lite, a thin sibling of `fetch`
**Decision.** A `search` tool for when the agent has **no URL to go on**. It GETs
`https://lite.duckduckgo.com/lite/?q=<query>` — DDG's minimal, **JS-free** HTML endpoint — and parses the
result rows into a ranked **`{title, url, snippet}`** list (`parseResults`, pure/tested): it pulls the
`result-link` anchors + `result-snippet` cells, **unwraps DDG's `/l/?uddg=` redirect** to the real URL, and
reuses `fetch`'s entity `decode`. The agent then `fetch`es a chosen URL to read the page — search finds,
fetch reads. `query` required, optional `max` (default 8, cap 20). `readonly:true` (a GET → PLAN-safe) and
it's in the **subagent** toolset, so research subagents can search too. Built on the same Bun-native `fetch`
primitive as [D28](#d28--a-fetch-tool-bun-native-html--markdown) (15s timeout, browser UA, follows redirects).
**Why.** The agent could read a URL ([D28](#d28--a-fetch-tool-bun-native-html--markdown)) but couldn't
**find** one — it had to be handed links. Real coding tasks need to look up current docs/errors/APIs. The
**lite** endpoint is the leanest path: no API key, no JS, tiny HTML that parses with a few regexes — no new
deps, fits the zero-dep ethos.
**Rejected.** The DDG **HTML/JSON Instant-Answer APIs** (heavier markup / sparse coverage); a paid search
API or a key-bearing engine (key management, cost — against the `.env`-only, lean ethos); scraping the full
JS DDG/Google (needs a headless browser). Routing search **through** the `fetch` tool's `htmlToMarkdown`
(loses the result structure — a dedicated parser yields a clean ranked list). **Refine later:** a `region`/
time filter, or a fallback engine if DDG lite blocks.
**Phase.** Built (Phase 1.5), live-verified (`bun javascript runtime` → bun.sh + GitHub + docs, redirects
unwrapped); `parseResults` unit-tested offline (`tests/search.test.ts`).

---

## D34 — Auto-continue: drive an unfinished todo list to completion (bounded)
**Decision.** When a turn ends with the model's `todo` list unfinished, the TUI **re-prompts the model to
keep going** instead of waiting for a human (`autoContinue` in `app.ts`, after each `sendPrompt` turn).
**Bounded** so it can't run away: at most `MAX_AUTO_CONTINUE` (8) rounds per user message, and it stops the
instant a round completes **no new todo** (no progress → the model's stuck), or there's no todo list, or
`ESC` aborts. Each round injects a terse "continue your todos" user message and shows a dim `continuing · N
left`; when it gives up with work left, a dim `stopped · N todos still pending` hint tells the user to nudge
it themselves. Pairs with the [system prompt](../prompts/system.md)'s "finish the task in one turn" rule.
**Why.** [D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts)'s thesis is
a self-hosting agent that **runs unattended** — but cheap/fast models (the default `deepseek-v4-flash`)
reliably end a turn mid-plan (narrate a few steps, hit `task`, stop). The agent loop is correct (it runs
until the model stops calling tools); the gap is the model's stamina. Re-nudging on a *tracked* todo list
closes it without touching the loop, and the no-progress guard + round cap keep token spend bounded (a few
cheap turns). Surfaced by the #2 self-test stalling at step 12/16 three runs straight.
**Rejected.** An unbounded "loop until done" (runaway cost / infinite loop on a stuck model); auto-continuing
**non-todo** turns (no completion signal to bound it — only a todo list defines "done"); driving it from the
engine `loop` (it stays a pure, re-entrant function — continuation is TUI policy, kept in `app.ts`).
**Refine later:** a config knob for the cap / opt-out, and a smarter stuck-signal than "no new todo this
round" (which can stop early on a todo that legitimately spans turns).
**Phase.** Built (Phase 1.5). Cap = 8 rounds; TUI-only (headless `index.ts` is one-shot by design).

---

## D35 — Distribution: a launcher on PATH, never a compiled binary
**Decision.** `bun run build` (= `bun scripts/install.ts`) installs nerve by writing a thin launcher to
`~/.local/bin/nerve` that does `exec bun "<repo>/index.ts" "$@"`. nerve is **never** shipped as a
`bun build --compile` standalone binary.
**Why.** nerve resolves its own assets — `prompts/`, `config/`, `docs/`, `skills/` — fresh from disk via
`import.meta.dir`, and hot-swaps `src/tools/` + `interceptors.ts` through cache-busted dynamic `import()`
([D7](#d7--self-hacking-runtime-hot-swap-of-seams)). `--compile` bakes everything into the read-only
`/$bunfs` virtual FS: runtime reads of `import.meta.dir`-relative paths then resolve to `/$bunfs/...` and
fail (first symptom in the wild: `ENOENT /$bunfs/config/models.json`), and with no on-disk source to
re-import, `/reload` and the system-prompt hot-swap are dead. A launcher keeps the self-hackable design
([D1](#d1--primary-purpose-personal-coding-agent), [D7](#d7--self-hacking-runtime-hot-swap-of-seams),
[D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts)) intact while still
putting nerve on PATH: the **user's** project resolves via `process.cwd()`, **nerve's** assets via the repo,
so it runs from any directory.
**Rejected.** `bun build --compile` (freezes the hot-swap seams — the entire point of nerve); embedding
assets via static `import` to satisfy compile (fixes the crash but still kills `/reload` + prompt hot-swap
and bloats the bundle).
**Phase.** Built (Phase 1.5). The launcher hard-codes the repo path; re-run `bun run build` from the repo
if you move it.

---

## D36 — Self-modification from any project: the `self:` tool-path prefix
**Decision.** The file tools (`read`/`edit`/`write`/`ls`/`grep`/`glob`) resolve paths through
`resolvePath` (`src/tools/resolve.ts`): a path prefixed `self:` targets nerve's **own source tree**
(`nerveSourceRoot()` — the repo it runs from) regardless of cwd, the remainder treated as repo-relative;
every other path stays working-dir-relative as before. So the agent can adapt its own tools/prompts/docs
while launched in **any** project, then apply the change via `/reload` (tools + interceptors,
cwd-independent) or a restart (engine — no rebuild, [D35](#d35--distribution-a-launcher-on-path-never-a-compiled-binary)).
Surfaced in [`prompts/system.md`](../prompts/system.md) and a `manual("self")` page.
**Why.** Self-hackability ([D7](#d7--self-hacking-runtime-hot-swap-of-seams)) only paid off when nerve was
launched *inside* its own repo, because the file tools were cwd-scoped — tuning nerve to a workflow meant
`cd`-ing into the repo first. The plumbing was already half-there (absolute paths were never jailed;
`/reload` and `manual` resolve relative to the install, not cwd); the gap was the agent **knowing** where
its source lives and a **stable, legible** way to address it. `self:` makes a self-edit a first-class,
visible operation without a per-install absolute path.
**Safety.** A self-edit is a write → **EDIT-mode only** (PLAN can read its own source + docs and *plan* a
change, not apply it, [D4](#d4--permissions-two-human-switched-modes-enforced-at-dispatch)); the
destructive-bash floor ([D18](#d18--destructive-command-guard-a-safety-floor-under-both-modes)) and the
reload rollback ([D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts))
are untouched. The model still **cannot** author its own guardrails or change its mode — `self:` is a path
prefix, not a permission. Cost accepted: a self-edit has **global blast radius** (changes nerve for every
project); `/reload` rolls back a tool that fails to *import*, but not a logic bug, and engine edits need a
restart with no rollback.
**Rejected.** Absolute-paths-only (works today but no stable addressing and no visual distinction for these
higher-stakes edits); a dedicated `self` tool/mode (duplicates `read`/`edit`, fails the
[D2](#d2--tools-earn-their-place-by-a-rent-heuristic-not-a-fixed-count) rent test — `self:` is ~15 lines
reusing the existing tools).
**Phase.** Built (Phase 1.5). Resolver in `src/tools/resolve.ts` (`tests/resolve.test.ts`); manual page at
`docs/manual/self.md`.

## D37 — Harness research triage: which `RESEARCH.md` ideas we adopt
**Context.** `docs/RESEARCH.md` surveyed three reference harnesses (claude-code, oh-my-pi, opencode) plus
the Masood "Agent Harness Engineering" blog and proposed 15 improvements. We triaged all 15 against the
actual code — several of the doc's premises were already stale — and recorded a verdict for each (the *no*s
too, so they aren't re-proposed; [D20](#d20--surveyed-and-deliberately-deferred-or-rejected)'s discipline).

**Through-line (the user's design philosophy, binding on future calls).** (1) **No hardcoded limits that
truncate or cap** — collapse redundancy or signal the model instead. (2) **Never cap the agent's potential**
— expose information (cost, context) and let the model decide; reserve hard floors for genuine *safety*
([D18](#d18--destructive-command-guard-a-mode-independent-safety-floor-on-bash) destructive guard, the turn
cap), never for cost/output throttling.

**Adopted (unbuilt — build in this order).**
1. *Output repetition-collapse, replacing the per-tool caps (idea 1).* A pure `collapseRuns()` in `dispatch`
   collapses repeated lines / char-runs to `⟨repeated N×⟩` on every tool result (`read` exempt — hashline
   anchors, [D3](#d3--edit-mechanism-hashline-only-content-anchored)). The hard caps (`bash` 30k / `fetch`
   60k / `grep` 100) are **removed** (built as D41). *(Refined at build: per the user's "rip out the caps"
   choice, no signal/threshold replaces them — the huge-non-repetitive-output overflow residual is left to
   compaction/pruning; see D41.)*
2. *Auto-discover tools from `src/tools/` (idea 3).* A glob + `isTool` filter replaces both the static
   imports and the duplicated `TOOL_MODULES`; `/reload` re-scans, so a new tool file goes live with no edit
   (extends [D7](#d7--self-hacking-runtime-hot-swap-of-seams)/[D36](#d36--self-modification-from-any-project-the-self-tool-path-prefix)).
   Initial load moves to an `await` at boot; specs sorted for deterministic order; rollback-on-failure kept
   ([D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts)).
3. *Mode-based tool-spec filtering (idea 5).* `toolSpecs(mode)` advertises read-only tools + `bash` in PLAN,
   all in EDIT — the model can't spend turns on tools the gate will refuse. Tied to the human mode
   ([D4](#d4--permissions-two-human-switched-modes-enforced-at-dispatch)), not a guessed turn-number "phase"
   (rejected).
4. *`deferrable?` flag on `Tool` (idea 15).* Added now (default false); the filter + threshold land later as
   a filter over idea-3's discovered set.
5. *Project-memory loading — `CLAUDE.md` and `AGENTS.md` (idea 14).* Builds the instruction-file layering
   [D12](#d12--claude-compatibility-load-claudemd--skills-from-claude-and-claude) claimed but never shipped
   (see the D12 correction), expanded to the `agents.md` standard; whole-file injection. The blog's "parse
   structured sections + inject by phase" is rejected (couples to the rejected phase idea).
6. *Model cost/context self-awareness, not a cap (idea 4).* No `--max-cost` stop — the loop already ends when
   the model stops calling tools (that *is* it deciding). An ephemeral `[status] $spend · ctx N% · todos 3/8
   (doing: …)` note is appended at the request **tail only** (never the prefix — would bust the auto-cache
   each turn), via a pure `status?: () => string` `LoopOptions` callback the TUI fills from `UsageMeter`
   (`contextWindow` already on the model entry); a `system.md` line frames it as ambient pacing, not a stop
   signal. The same callback folds in a **compact pending-todos summary when the list has open items**
   (reusing the sidebar summary, [D25](#d25--a-todo-tool-with-a-pinned-colored-tui-panel)) — recency that
   proactively counters the mid-plan drift [D34](#d34--auto-continue-drive-an-unfinished-todo-list-to-completion-bounded)
   catches reactively; omitted when no todos are open. Adopts
   [D20](#d20--surveyed-and-deliberately-deferred-or-rejected)'s "Context Epochs — note only."
7. *Prefix-stabilization hygiene (idea 10).* Keep the cached prefix byte-stable so DeepSeek/Gemini automatic
   prefix caching hits: volatile content stays tail-only (idea 4), discovered specs sorted, `system.md`
   hot-swap re-reads identical bytes. The automatic caching does the rest — the append-only split (idea 11)
   is rejected as redundant.
8. *Self-verification by prompt, not LLM-judge (idea 9).* `system.md` nudges the model to run `typecheck`/
   tests after edit-heavy turns; lean on the deterministic signals already wired (LSP diagnostics on edit +
   post-edit hooks, [D10](#d10--lsp-support-both-seams-raw-zero-dep-client-schema-backed-config)/[D24](#d24--language-packs-conditional-skills--native-post-edit-hooks)).
   The blog's `--verify` judge is rejected — weaker and costlier than the compiler for code.
9. *Between-turn steering (idea 6).* Promotes [D20](#d20--surveyed-and-deliberately-deferred-or-rejected)'s
   deferred "Queued / steering input": a TUI input queue injects a redirect as a user turn *after* the
   current turn's tools finish (true mid-turn injection is racy against the serial mutating phase). Policy in
   `app.ts` ([D34](#d34--auto-continue-drive-an-unfinished-todo-list-to-completion-bounded) pattern); the
   loop stays pure.
10. *Startup sliver (idea 12).* Parallelize the preflight checks with config load. No LSP prefetch — servers
    stay lazy-per-language ([D10](#d10--lsp-support-both-seams-raw-zero-dep-client-schema-backed-config));
    the DB already opens at session construction.

**Rejected / deferred.**
- *`defineTool` helper (idea 2) — defer.* `Tool` has one defaultable field (`deferrable` makes two); a
  builder is indirection for ~zero gain until ≥3 optional fields exist.
- *Tool-dispatch before/after hooks (idea 7) — reject.* A hot-swappable block/mutate chain at the dispatch
  gate is a model-editable guardrail surface, forbidden by
  [D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts)/[D36](#d36--self-modification-from-any-project-the-self-tool-path-prefix).
  The real needs are met hand-built (collapse + mode gate + [D18](#d18--destructive-command-guard-a-mode-independent-safety-floor-on-bash) + secret-redaction); new
  guardrails get hand-added to `dispatch`, which stays non-swappable.
- *Ralph loop (idea 8) — reject (covered).* [D34](#d34--auto-continue-drive-an-unfinished-todo-list-to-completion-bounded)
  already does bounded auto-continue on a todo list and already declined non-todo auto-continue (no
  completion bound). Don't re-litigate.
- *Append-only context split (idea 11) — reject.* A cross-cutting rewrite duplicating what automatic caching
  + idea-10 hygiene already deliver.
- *Feature-gated dead-code elimination (idea 13) — reject (moot).* `bun:bundle`'s `feature()` needs the build
  step [D35](#d35--distribution-a-launcher-on-path-never-a-compiled-binary) deliberately removed; adopting it
  would undo the launcher and kill hot-swap.

**Why.** Recording the verdicts (and the corrections to stale premises) stops the whole survey being
re-triaged. The triage also surfaced real code-vs-doc drift — most importantly D12 (above); also that ideas
1/4/8/13 rested on premises the code had outgrown (existing self-caps, an existing `UsageMeter`/
`contextWindow`, D34, D35).

**Phase.** Decided (triage), 2026-06-08. Adopted items are **unbuilt**; each graduates to its own `D38+`
entry with a `docs/manual/` page + tests ([AGENT_RULES §2](AGENT_RULES.md)) as it lands, in the order above.

## D38 — Tool registry by filesystem discovery (no static list)
**Decision.** The tool registry is **discovered**, not hand-listed. `registry.ts` scans its own directory
(`src/tools/*.ts` via `Bun.Glob` over `import.meta.dir`), imports each module, and collects every
`Tool`-shaped export (a small `isTool` guard; export names need not match the tool name — `fetch.ts`
exports `fetchTool`, `ask.ts` exports `askUser`). The set is **sorted by tool name** (locale-independent
compare) for a deterministic spec order. `loadTools()` populates it once at boot (`index.ts`, an `await`
after `ensureLayout`); `reloadTools()` re-scans **cache-busted** so `/reload` (D7) picks up edited tools
**and brand-new tool files** with no registration edit. This delivers D37's adopted idea 3: the old
triple-registration (a static `import`, the `tools` array, and the `TOOL_MODULES` list) collapses to
"drop a file."
**Why.** Adding a tool meant editing three places in lockstep (the surveyed "own friction"); the `tools`
array and `TOOL_MODULES` were the same 15 entries written twice. Discovery removes the duplication and
**upgrades self-hacking** (D36): nerve can write itself a new tool and `/reload` it live — no restart, no
array edit. Sorting keeps the provider-facing spec order stable across machines/restarts so the providers'
automatic prefix cache hits (D37 idea 10).
**How it stays safe.** Discovery is async (ESM `import()`), so the initial set moves to a boot `await` —
nothing reads `tools` before then (verified: no module-eval consumers). The `task.ts → registry.ts` cycle
is unaffected (task reads `tools` only at runtime, after population). Rollback (D11) is preserved and
slightly stricter: a module that fails to import **or exports no Tool** throws, so a broken edit keeps the
running set instead of silently dropping a tool. A non-tool helper added under `src/tools/` must be named
in `NOT_TOOLS`, or the scan rejects it (loud over silent).
**Rejected.** Keeping the static imports for the initial set + discovery only for reload (still edits
`registry.ts` per tool — half a fix); a top-level `await` inside `registry.ts` to auto-populate on import
(**deadlocks** the `task.ts ↔ registry.ts` cycle — task's static import would block on registry's TLA while
registry awaits the dynamic import of task); a global `bun test` preload to populate the registry (hides
the dependency — instead each test that exercises the real registry calls `loadTools()` in `beforeAll`).
**Phase.** Built. `src/tools/registry.ts` (`loadTools`/`reloadTools`/`scanTools`); boot in `index.ts`;
tests in `tests/reload.test.ts` (discovery + deterministic order) + `beforeAll(loadTools)` in the
registry/dispatch/loop suites; manual at `docs/manual/tools.md`.

## D39 — PLAN advertises only the tools it will run (mode-filtered specs)
**Decision.** `toolSpecs(planOnly)` filters the provider-facing tool list by mode: in **PLAN** it advertises
only the **PLAN-visible** set — read-only tools **+ `bash`** (whose individual commands are still gated
per-command in `dispatch`) — and in EDIT the whole set. The predicate `planVisible(tool) = tool.readonly ||
tool.name === "bash"` lives in `registry.ts` as the **single source of truth**, used by `toolSpecs` to
*advertise* and by `dispatch.allowed` to *enforce*, so the two can't drift. The TUI + headless surfaces
compute `toolSpecs(mode === "plan")` **per turn** (mode can flip via Shift+Tab), which retired the old cached
`opts.tools` spec list.
**Why.** All tools were advertised in every mode, so in PLAN the model would *see* `write`/`edit` and burn a
turn calling one only to hit a dispatch refusal (D4). Hiding the mutators makes PLAN structural, not advisory
— the model can't attempt what it can't run — and trims the PLAN prompt. Tied to the **human-controlled**
mode, never a guessed "phase": the surveyed turn-number heuristic (early turns = planning) was rejected as an
arbitrary threshold that fights how real work interleaves reading and editing.
**Cache.** Within a stable mode `toolSpecs(planOnly)` is byte-identical each turn (sorted set, fixed filter),
so the providers' automatic prefix cache still hits (D37 idea 10); only a mode switch (rare) changes it.
**Rejected.** The turn-number planning/execution phase (arbitrary, fragile); putting `planVisible` in
`dispatch` and importing it into `registry` (would make a `registry → dispatch` runtime cycle — `dispatch`
already imports `registry`, so the predicate lives in `registry` and the dependency stays one-way).
**Phase.** Built. `planVisible` + `toolSpecs(planOnly)` in `src/tools/registry.ts`; `allowed()` routes
through `planVisible` in `src/dispatch.ts`; per-turn specs in `index.ts` + `src/tui/app.ts`; tests in
`tests/tools.test.ts`. Delivers D37 idea 5.

## D40 — A `deferrable` flag on `Tool` (reserved for deferred loading)
**Decision.** `Tool` gains an optional `deferrable?: boolean` (default absent = false). **No behavior yet** —
the field exists so a tool can *declare* intent now; the filtering (hold deferrable tools out of the initial
spec, surface them on demand) lands only when the tool count outgrows the prompt (~20), as a filter over the
discovered set (D38).
**Why.** Adopted from the survey (idea 15) at the user's call, against the usual "no speculative scaffolding"
default — the field is cheap and makes the eventual deferred-loading change a one-liner. It is the `Tool`
contract's first *optional* field; per D37 the `defineTool` helper (idea 2) stays deferred until there are ≥3.
**Rejected.** Building the deferred-loading filter + a count threshold now (the 15-tool set is far from the
pressure that would justify it — YAGNI until it isn't).
**Phase.** Field added (`src/tools/types.ts`); no filter logic. Delivers D37 idea 15.

## D41 — Collapse repeated tool output instead of truncating (no output caps)
**Decision.** A pure `collapseRuns(text)` (`src/collapse.ts`) runs on every tool result in `dispatch`: runs
of identical consecutive lines collapse to one line + `⟨repeated N×⟩`, and a single character repeated 80+
times within a line collapses to `<char>⟨×N⟩`. It removes only *redundancy* (the content and the count both
survive), so the **tail is never lost** — unlike the old per-tool truncation caps, which sliced the end off
(often the useful part). `read` is **exempt** (its `LINE#HASH` anchors must stay byte-exact for `edit`, D3).
The per-tool output caps are **removed**: `bash` (30k), `fetch` (60k), `grep` (100 matches). Resource guards
stay (timeouts, `fetch`'s 5 MB download skip, `grep`'s huge-file skip + 200-char per-line slice).
**Why.** The user's standing preference (memory: *avoid hardcoded limits*): truncation discards information
— usually the tail, where a final error/summary lives — while real output bloat is overwhelmingly
*repetition* (logs, progress bars, stack-trace loops), which collapses losslessly. One pass in `dispatch`
covers every tool (and every future one), so no tool re-implements a cap.
**The overflow residual (accepted).** Genuinely huge *non-repetitive* output (a broad `grep`, a 5 MB minified
blob) that collapse can't shrink is **not** pre-truncated — per the user's explicit choice to "rip out the
caps entirely," it flows through and is left to compaction/pruning (D17). The cost is a known sharp edge: one
such result can overflow a turn's context (a non-retryable failure in `loop`). A context-window-aware
*signal* ("too large — narrow", floated in D37's idea-1 note) was **not** built — it reintroduces a threshold
the user declined; it stays a future option if overflow bites in practice.
**Rejected.** A central char ceiling in `dispatch` (a hardcoded cap by another name); a "too large" signal on
a fixed threshold (declined, as above); collapsing multi-line *block* repetition (beyond consecutive-
identical-line + char-run — deferred until a real case needs it).
**Phase.** Built. `src/collapse.ts` + apply in `src/dispatch.ts`; caps removed from `src/tools/{bash,fetch,grep}.ts`;
tests in `tests/collapse.test.ts` + a `dispatch` read-exemption test. Delivers D37 idea 1.

## D42 — Project-memory loading: CLAUDE.md + AGENTS.md as agent context (builds D12)
**Decision.** `src/context.ts` `loadProjectMemory(cwd)` reads the project/user memory files and folds them
into the **base system prompt** (after nerve's own `system.md`), so nerve-the-agent actually reads the repo's
guidance. Sources, most-general → most-specific (project augments user, D12): `~/.claude/CLAUDE.md` →
`./CLAUDE.md` → `./.claude/CLAUDE.md` → `./AGENTS.md`. A line that is exactly `@<path>` is **inlined**
(recursively, depth + cycle guarded) — the convention nerve's own root `CLAUDE.md` uses (`@.claude/CLAUDE.md`);
each file loads at most once (`seen` dedups an import-then-also-listed file). Whole-file injection — **no**
structured-section parsing or phase-injection (D37 rejected those). `index.ts`'s `baseSystem(cwd)` is the one
seam, used by both surfaces (the TUI gets it via the `system` opt; headless re-reads per turn so an edited
memory file hot-swaps).
**Why.** This is the capability D12 *claimed* since Phase 1 but **never shipped** — there was no
`src/context.ts`, so the agent silently ignored the project's own `CLAUDE.md`. Loading it (and the cross-tool
`AGENTS.md` standard) closes the "environment legibility" gap and makes Claude-compat (D12) real. AGENTS.md
rides the same mechanism — one loader, both conventions.
**Rejected.** Parsing AGENTS.md into structured sections + injecting by task phase (couples to the rejected
phase idea, D39; whole-file is what Claude Code does); a per-file wrapper/marker (kept lean — the files carry
their own headings); hot-swapping memory via `/reload` (it's read in `baseSystem`, not a tool/interceptor
leaf — headless re-reads each turn; a mid-session TUI edit needs a restart, acceptable).
**Phase.** Built (delivers D37 idea 14). `src/context.ts` + `baseSystem` in `index.ts`; tests in
`tests/context.test.ts`; manual at `docs/manual/context.md`. Reconciles the D12 drift (see D12's correction).

## D43 — Model self-awareness: an ambient status note at the request tail (+ prefix hygiene)
**Decision.** Each turn the loop appends an ephemeral `[status]` note — `$spend · ctx used/window (N%) · todos
done/total · doing: <current>` — to the **last message's content** (not a new message: a standalone one would
risk consecutive-`user` roles on Gemini, which collapses tool results into a `user` turn). The TUI fills it via
a pure `status?: () => string` `LoopOptions` callback (`formatModelStatus` over the `UsageMeter` snapshot +
`active.contextWindow` + live todos); headless omits it. `system.md` frames it as **pacing** info, never a stop
signal. This realizes D37 ideas 4 **and** 10: no hard `--max-cost` cap (the loop already ends when the model
stops calling tools — the model decides), and the note is **tail-only** so the cached prefix stays byte-stable.
**Why (idea 4).** Per the user, never cap the agent — expose information and let it pace itself. The todo
segment proactively counters the mid-plan drift D34 catches reactively (recency: the live task list resurfaces
at the most-attended position each turn), reusing the sidebar's summary.
**Why (idea 10).** Both providers auto-cache the longest common prefix (DeepSeek context cache; Gemini implicit
cache), so the cost lever is **prefix stability**, not manual cache management. Invariant: volatile per-turn
content (this status) lives at the **tail only** — never the system prompt or mid-history, which would bust the
cache every turn; the spec order is sorted + stable (D38); the system base (`system.md` + project memory)
carries no per-turn tokens; the message log is already append-only. So the heavy append-only split (idea 11)
stays rejected — automatic caching + this discipline already capture the win.
**Rejected.** A standalone trailing status *message* (consecutive-role hazard on Gemini without a provider-side
merge); injecting the status into the system prompt (busts the prefix cache every turn — the exact anti-pattern
idea 10 warns against); a hard cost cap / hiding cost from the model (D37 idea 4 — the user chose model-decides
over a ceiling).
**Phase.** Built (delivers D37 ideas 4 + 10). `formatModelStatus` in `src/usage.ts`; `status` seam + `withStatus`
tail-append in `src/loop.ts`; wired in `src/tui/app.ts`; framing in `prompts/system.md`. Tests in
`tests/usage.test.ts` + `tests/loop.test.ts`.

## D44 — Verification by prompt, not an LLM judge (idea 9)
**Decision.** Sharpen `prompts/system.md` to make the model **verify after editing code** — run `typecheck` +
relevant tests and read the LSP diagnostics already appended to its edits — rather than add an LLM-judge
verification pass. No new machinery.
**Why.** For a coding agent the verification oracle is **deterministic and already wired**: LSP diagnostics on
every `read`/`edit`/`write` (D10), post-edit hooks (D24), and `bun run typecheck`/`test` one bash call away. An
LLM-judge re-derives — more weakly and at cost — what the compiler states for free. The blog's "reasoning
sandwich" reliability math assumes no ground-truth oracle; a compiler *is* one.
**Rejected.** A `--verify` LLM-judge turn (weaker + costlier than the compiler/tests for code); a structured
PEV phase-gate (couples to the rejected phase idea, D39).
**Phase.** Built — prompt-only (`prompts/system.md`). Delivers D37 idea 9.

---

## Standing micro-defaults (low-risk, stated so they're not guessed)
- **Interrupt:** `ESC` aborts the current streaming turn (via the provider `AbortSignal`);
  `Ctrl+C` exits the app. The TUI shows a live **animated working indicator** (spinner + `working`) while
  a turn runs; `ESC` flips it to red `stopping…` immediately and it vanishes when the turn ends, so the
  user can tell working vs. interrupting vs. stopped (a static indicator couldn't show liveness).
- **Mode switch:** `Shift+Tab` cycles PLAN ↔ EDIT (human-only, [D4](#d4--permissions-two-human-switched-modes-enforced-at-dispatch));
  plain `Tab` also toggles it **when no autosuggest popup is open** (popup-`Tab` accepts the suggestion).
  **Startup default is PLAN** (read-only — safer first contact); `--mode edit` opts into EDIT from launch.
- **Sidebar:** `Ctrl+B` toggles the session/files sidebar; it auto-hides below 100 cols. The bottom status
  bar shows only while the sidebar is hidden (the session panel carries the same model/mode/cost/ctx/bal).
- **Terminal owns the mouse + clipboard:** the TUI runs with `useMouse:false` + `useKittyKeyboard:null`
  (`createCliRenderer`), so the **terminal** does native selection, `Ctrl+Shift+C/V` copy-paste, and the
  right-click menu — nerve doesn't grab them. Cost: no mouse-wheel scroll (use **Ctrl/Alt+↑/↓**), and
  `Shift+Enter` is indistinguishable from `Enter` without the Kitty protocol, so a multi-line newline uses
  **Alt+Enter**. Chosen because the user (ghostty + neovim) wants the terminal's keybinds to keep working,
  not be swallowed by the app. A runtime **`/mouse`** toggle (opt into wheel-scroll) was built and then
  **removed**: once the side panels landed, mouse-capture broke rectangular selection, so the wheel was never
  worth losing native copy — capture stays off for good.
- **Shell:** the model's `bash` tool and the `!`-shell escape run via the user's shell — `Bun.env.SHELL`
  (zsh on this setup), falling back to `zsh` — not hardcoded `bash`. Non-interactive (`-c`); no rc sourcing.
- **Startup preflight:** `index.ts` checks required external deps on PATH (the shell + `git`) and exits
  with a clear error if any is missing — nerve shells out to them, so fail fast over failing mid-task.
- **Sessions:** `/resume [id]` switches to an existing session (default = most recent that isn't the
  current one); `/sessions` lists them; `/sessions delete <id>` removes one (not the current — that's `/drop`).
- **Hot reload (built, Phase 1.5):** `/reload` + `Ctrl+R` re-import `src/tools/` (via `reloadTools()`,
  cache-busted, **discovered** from `src/tools/` — no static list, D38) and `src/interceptors.ts` ([D7](#d7--self-hacking-runtime-hot-swap-of-seams));
  conversation preserved, engine untouched. **Rollback implemented** — a failed import keeps the running
  set ([D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts)). Verified live (a disk edit to a tool is picked up).
- **System prompt:** `prompts/system.md`, read fresh per turn (hot-swappable, agent-editable).
- **Tool shape:** `{ name, description, parameters (JSON Schema), readonly: boolean, deferrable?: boolean, run(args, ctx) }`.
  JSON Schema maps cleanly to Gemini `functionDeclarations` and DeepSeek `tools`.
- **Working dir:** wherever nerve is launched (self-hacks when launched in the nerve repo, [D1](#d1--primary-purpose-personal-coding-agent)).
- **Turn cap:** a configurable max tool-iteration bound per turn as a runaway safety net.
