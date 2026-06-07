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
(**34-col**) **`sidebar`** beside it with stacked bordered panels — **session** (title · model · mode
badge · cost · ctx · balance, mirroring the status bar), **skills** (the skills *loaded into context now*:
the always-on defaults + active language packs, `activeSkillNames`), **tools** (the main agent's tool
calls this session + status — `●` running · `✓` ok · `✗` error, fed by the loop's `onToolStart`/
`onToolResult`), **subagents** (this session's `task` runs + status `●`/`✓`/`✗`, [D6](#d6--subagents-a-read-only-task-tool-over-the-re-entrant-loop)), and **files**
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
  `let` (reassigned via `pickTheme()`), the markdown `SyntaxStyle` is rebuilt, chrome props (`borderColor`/
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

---

## Standing micro-defaults (low-risk, stated so they're not guessed)
- **Interrupt:** `ESC` aborts the current streaming turn (via the provider `AbortSignal`);
  `Ctrl+C` exits the app.
- **Mode switch:** `Shift+Tab` cycles PLAN ↔ EDIT (human-only, [D4](#d4--permissions-two-human-switched-modes-enforced-at-dispatch));
  plain `Tab` also toggles it **when no autosuggest popup is open** (popup-`Tab` accepts the suggestion).
  **Startup default is PLAN** (read-only — safer first contact); `--mode edit` opts into EDIT from launch.
- **Sidebar:** `Ctrl+B` toggles the session/files sidebar; it auto-hides below 100 cols. The bottom status
  bar shows only while the sidebar is hidden (the session panel carries the same model/mode/cost/ctx/bal).
- **Shell:** the model's `bash` tool and the `!`-shell escape run via the user's shell — `Bun.env.SHELL`
  (zsh on this setup), falling back to `zsh` — not hardcoded `bash`. Non-interactive (`-c`); no rc sourcing.
- **Startup preflight:** `index.ts` checks required external deps on PATH (the shell + `git`) and exits
  with a clear error if any is missing — nerve shells out to them, so fail fast over failing mid-task.
- **Sessions:** `/resume [id]` switches to an existing session (default = most recent that isn't the
  current one); `/sessions` lists them; `/sessions delete <id>` removes one (not the current — that's `/drop`).
- **Hot reload (built, Phase 1.5):** `/reload` + `Ctrl+R` re-import `src/tools/` (via `reloadTools()`,
  cache-busted per `TOOL_MODULES`) and `src/interceptors.ts` ([D7](#d7--self-hacking-runtime-hot-swap-of-seams));
  conversation preserved, engine untouched. **Rollback implemented** — a failed import keeps the running
  set ([D11](#d11--bootstrapping-claude-code-builds-a-trustworthy-kernel-then-nerve-self-hosts)). Verified live (a disk edit to a tool is picked up).
- **System prompt:** `prompts/system.md`, read fresh per turn (hot-swappable, agent-editable).
- **Tool shape:** `{ name, description, parameters (JSON Schema), readonly: boolean, run(args, ctx) }`.
  JSON Schema maps cleanly to Gemini `functionDeclarations` and DeepSeek `tools`.
- **Working dir:** wherever nerve is launched (self-hacks when launched in the nerve repo, [D1](#d1--primary-purpose-personal-coding-agent)).
- **Turn cap:** a configurable max tool-iteration bound per turn as a runaway safety net.
