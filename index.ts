#!/usr/bin/env bun
// nerve — kernel runner (headless). The interactive OpenTUI front-end lands next; for now this runs
// one-shot prompts (`-p "…"`) or a simple stdin REPL, streaming to stdout. See docs/manual/loop.md.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadModels, providerFor, selectModel, fallbacksFor, entryEffort } from "./src/config.ts";
import type { Effort } from "./src/effort.ts";
import { Session } from "./src/session.ts";
import { lastSessionId } from "./src/sessions.ts";
import { ensureLayout, skillRoots, commandRoots, nerveSourceRoot } from "./src/paths.ts";
import { optionalHints } from "./src/toolchain.ts";
import { loadProjectMemory, nestedMemory } from "./src/context.ts";
import { activePacks, defaultSkills, langForFile, langSkills, runHooks, triagePrompt } from "./src/langpack.ts";
import { loop, type Candidate } from "./src/loop.ts";
import { reasoningRouter, secretRedaction, tokenTap } from "./src/interceptors.ts";
import { toolSpecs, loadTools } from "./src/tools/registry.ts";
import { Lsp } from "./src/lsp/manager.ts";
import { PLAN_NOTE, type Mode } from "./src/dispatch.ts";
import type { Provider } from "./src/providers/types.ts";
import type { AskRequest } from "./src/tools/types.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const mode: Mode = arg("--mode") === "edit" ? "edit" : "plan"; // default PLAN (read-only) — safer; --mode edit opts in
const prompt = arg("-p") ?? arg("--print");
const resume = arg("--resume");
const noLsp = argv.includes("--no-lsp");

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const out = (s: string): void => void process.stdout.write(s);

function systemPrompt(): string {
  const p = resolve(import.meta.dir, "prompts/system.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "You are nerve, a terminal coding agent.";
}

/** The host OS pretty name (e.g. "Fedora Linux 44 …"), or the bare platform if `/etc/os-release` is absent. */
function osPretty(): string {
  try {
    const m = /PRETTY_NAME="?([^"\n]+)"?/.exec(readFileSync("/etc/os-release", "utf8"));
    if (m) return m[1]!;
  } catch {
    /* not linux / no os-release */
  }
  return process.platform;
}

/** Ground the model in WHERE it's running (D55) — DeepSeek otherwise assumes Windows and invents Windows
 *  paths to nerve. States the OS, the project cwd, and nerve's real source dir (reachable via `self:`). */
function environmentContext(cwd: string): string {
  return [
    "<environment>",
    `Operating system: ${osPretty()} — a ${process.platform} machine. Paths are POSIX (forward slashes). Never assume Windows or invent Windows-style paths (no \`C:\\…\`).`,
    `Working directory (the user's project): ${cwd}`,
    `nerve's own source lives at: ${nerveSourceRoot()} — to read or edit nerve itself use the \`self:\` path prefix (e.g. \`self:src/loop.ts\`), never a guessed path.`,
    `Shell: ${Bun.env.SHELL || "sh"}`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    "</environment>",
  ].join("\n");
}

/** The base system prompt = nerve's own `system.md` + a live `<environment>` block (D55) + the project/user
 *  memory files (CLAUDE.md/AGENTS.md, D42 delivering D12), layered in. Read fresh so an edit hot-swaps. */
function baseSystem(cwd: string): string {
  return [systemPrompt(), environmentContext(cwd), loadProjectMemory(cwd)].filter(Boolean).join("\n\n");
}

function compactionPrompt(): string {
  const p = resolve(import.meta.dir, "prompts/compaction.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "Summarize the conversation so it can continue in less context.";
}

function titlePrompt(): string {
  const p = resolve(import.meta.dir, "prompts/title.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "Give a concise 3-6 word Title Case title for this conversation. Output only the title.";
}

// Is an external command available? Absolute paths (e.g. $SHELL=/usr/bin/zsh) are checked directly.
function onPath(cmd: string): boolean {
  return cmd.includes("/") ? existsSync(cmd) : Bun.which(cmd) !== null;
}

/** Fail fast if a required external dependency is missing — nerve shells out to these. */
function preflight(): void {
  const required: { cmd: string; why: string }[] = [
    { cmd: Bun.env.SHELL || "zsh", why: "the bash tool + ! shell escape run through your shell" },
    { cmd: "git", why: "version control / self-edit safety net (and PLAN-mode git commands)" },
  ];
  const missing = required.filter((d) => !onPath(d.cmd));
  if (missing.length) {
    for (const d of missing) console.error(`nerve: missing required dependency '${d.cmd}' — ${d.why}`);
    console.error("install the dependencies above and re-run.");
    process.exit(1);
  }
}

// Non-interactive ask_user: auto-pick the recommended option (the TUI provides the real picker).
function headlessAsk(req: AskRequest): Promise<string> {
  const rec = req.options.find((o) => o.recommended) ?? req.options[0]!;
  out(`\n${DIM}? ${req.question} → auto: ${rec.label}${RESET}\n`);
  return Promise.resolve(rec.label);
}

const langTouched = new Set<string>(); // D24: sticky across turns (skill injection)
let langSkillText = "";
let langSkillKey = "";

async function runTurn(session: Session, entryId: string, effort: Effort, temperature: number | undefined, provider: Provider, fallbacks: Candidate[], prevIssues?: string): Promise<void> {
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.once("SIGINT", onSigint);
  const edited = new Set<string>();
  const packs = activePacks(langTouched);
  const key = packs.map((p) => p.id).join(",");
  if (packs.length && key !== langSkillKey) {
    langSkillText = await langSkills(packs);
    langSkillKey = key;
  }
  const sys = [baseSystem(process.cwd()), nestedMemory(process.cwd(), langTouched), await defaultSkills(), mode === "plan" ? PLAN_NOTE : "", packs.length ? langSkillText : ""].filter(Boolean).join("\n\n");
  await loop({
    provider,
    session,
    model: entryId,
    mode,
    ctx: {
      cwd: process.cwd(),
      ask: headlessAsk,
      lsp,
      touched: langTouched,
      edited,
      signal: ac.signal,
      onSubagent: (ev) => ev.phase === "start" && out(`\n${DIM}⊂ subagent: ${ev.prompt.split("\n")[0]?.slice(0, 80) ?? ""}…${RESET}\n`),
    },
    interceptors: [secretRedaction(), reasoningRouter((d) => out(DIM + d + RESET)), tokenTap(session)],
    signal: ac.signal,
    system: sys,
    tools: toolSpecs(mode === "plan"),
    effort,
    temperature,
    fallbacks, // D15: transient errors fall down the model ladder, then back off
    onEvent: (ev) => {
      if (ev.type === "text") out(ev.delta);
    },
    onToolResult: (name, result) => {
      if (name === "todo") return void out(`\n${DIM}${result}${RESET}\n`); // print the full checklist
      out(`\n${DIM}→ ${name}: ${result.split("\n")[0]?.slice(0, 120) ?? ""}${RESET}\n`);
    },
    onRetry: ({ delayMs, model }) => out(`\n${DIM}↻ retrying on ${model}${delayMs ? ` in ${Math.round(delayMs / 1000)}s` : ""}…${RESET}\n`),
    onError: (e) => process.stderr.write(`\nnerve: ${e instanceof Error ? e.message : String(e)}\n`),
  });
  process.removeListener("SIGINT", onSigint);
  out("\n");
  if (ac.signal.aborted) return; // Ctrl+C — skip hooks + auto-fix
  // D24 post-edit hooks: fix + check the Python files edited this turn (EDIT mode only).
  if (mode !== "edit" || edited.size === 0) return;
  const summaries: string[] = [];
  let issues = false;
  for (const pack of activePacks(edited)) {
    const res = await runHooks(pack, [...edited].filter((f) => langForFile(f) === pack), process.cwd());
    if (res.summary) {
      out(`${DIM}${res.summary}${RESET}\n`);
      summaries.push(res.summary);
    }
    issues ||= res.issues;
  }
  if (!issues) return;
  const issueSummary = summaries.join("\n\n");
  if (issueSummary === prevIssues) {
    out(`${DIM}⚠ post-edit issues unchanged after a fix attempt — leaving them${RESET}\n`);
    return;
  }
  session.addUser(triagePrompt(summaries)); // agent triages: fix critical/quick, defer non-critical
  out(`${DIM}↪ post-edit checks failed — agent triaging…${RESET}\n`);
  await runTurn(session, entryId, effort, temperature, provider, fallbacks, issueSummary);
}

// --- boot -------------------------------------------------------------------
preflight();
ensureLayout(); // create ~/.nerve/{skills,commands} + this workspace's dirs (D22)
const toolsReady = loadTools(); // D45: kick off tool discovery now so its import I/O overlaps the sync boot below
const models = loadModels();
const entry = selectModel(models, arg("--model"));
let provider: Provider;
try {
  provider = providerFor(entry);
} catch (e) {
  console.error(`nerve: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

let resumeId: string | undefined;
if (resume) {
  resumeId = resume === "last" ? lastSessionId() : resume;
  if (!resumeId) {
    console.error("nerve: no sessions to resume");
    process.exit(1);
  }
}
const session = new Session(resumeId ? { id: resumeId, resume: true } : {});
const effort = entryEffort(entry); // D52: the model's default effort (kernel default "off", D11)
const fallbacks = fallbacksFor(models, entry); // D15 model ladder
const lsp = noLsp ? undefined : new Lsp(process.cwd()); // D10: diagnostics-on-edit + the `lsp` tool
await toolsReady; // D38: tools must be discovered before any toolSpecs()/dispatch read the registry

// Optional-dep hints (D55) for headless runs — the TUI surfaces its own (preflight stderr is wiped by it).
if (prompt || !process.stdin.isTTY) for (const h of optionalHints()) console.error(`nerve: optional — ${h}`);

if (prompt) {
  // one-shot
  session.addUser(prompt);
  await runTurn(session, entry.id, effort, entry.temperature, provider, fallbacks);
  await session.close();
  await lsp?.stop();
} else if (process.stdin.isTTY) {
  // interactive: the OpenTUI front-end (loaded lazily so headless runs don't pull in the renderer)
  const { runTui } = await import("./src/tui/app.ts");
  const { discoverSkills } = await import("./src/tui/affordances.ts");
  const { discoverCommands } = await import("./src/commands.ts");
  const cwd = process.cwd();
  const skills = await discoverSkills(skillRoots(cwd));
  const commands = await discoverCommands(commandRoots(cwd));
  await runTui({ models, entry, provider, session, mode, cwd, system: baseSystem(cwd), skills, commands, compactionPrompt: compactionPrompt(), titlePrompt: titlePrompt(), lsp });
} else {
  // piped stdin: a simple line REPL
  out(`${DIM}Type a message, Enter to send. Ctrl+D to exit.${RESET}\n> `);
  for await (const line of console) {
    const text = line.trim();
    if (!text) {
      out("> ");
      continue;
    }
    session.addUser(text);
    await runTurn(session, entry.id, effort, entry.temperature, provider, fallbacks);
    out("> ");
  }
  await session.close();
  await lsp?.stop();
}
