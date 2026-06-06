#!/usr/bin/env bun
// nerve — kernel runner (headless). The interactive OpenTUI front-end lands next; for now this runs
// one-shot prompts (`-p "…"`) or a simple stdin REPL, streaming to stdout. See docs/manual/loop.md.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadModels, providerFor, selectModel, fallbacksFor } from "./src/config.ts";
import { Session } from "./src/session.ts";
import { lastSessionId } from "./src/sessions.ts";
import { loop, type Candidate } from "./src/loop.ts";
import { reasoningRouter, secretRedaction, tokenTap } from "./src/interceptors.ts";
import { toolSpecs } from "./src/tools/registry.ts";
import type { Mode } from "./src/dispatch.ts";
import type { Provider } from "./src/providers/types.ts";
import type { AskRequest } from "./src/tools/types.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const mode: Mode = arg("--mode") === "plan" ? "plan" : "edit";
const prompt = arg("-p") ?? arg("--print");
const resume = arg("--resume");

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const out = (s: string): void => void process.stdout.write(s);

function systemPrompt(): string {
  const p = resolve(import.meta.dir, "prompts/system.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "You are nerve, a terminal coding agent.";
}

function compactionPrompt(): string {
  const p = resolve(import.meta.dir, "prompts/compaction.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "Summarize the conversation so it can continue in less context.";
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

async function runTurn(session: Session, entryId: string, thinking: boolean, temperature: number | undefined, provider: Provider, fallbacks: Candidate[]): Promise<void> {
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.once("SIGINT", onSigint);
  await loop({
    provider,
    session,
    model: entryId,
    mode,
    ctx: { cwd: process.cwd(), ask: headlessAsk },
    interceptors: [secretRedaction(), reasoningRouter((d) => out(DIM + d + RESET)), tokenTap(session)],
    signal: ac.signal,
    system: systemPrompt(),
    tools: toolSpecs(),
    thinking,
    temperature,
    fallbacks, // D15: transient errors fall down the model ladder, then back off
    onEvent: (ev) => {
      if (ev.type === "text") out(ev.delta);
    },
    onToolResult: (name, result) => out(`\n${DIM}→ ${name}: ${result.split("\n")[0]?.slice(0, 120) ?? ""}${RESET}\n`),
    onRetry: ({ delayMs, model }) => out(`\n${DIM}↻ retrying on ${model}${delayMs ? ` in ${Math.round(delayMs / 1000)}s` : ""}…${RESET}\n`),
    onError: (e) => process.stderr.write(`\nnerve: ${e instanceof Error ? e.message : String(e)}\n`),
  });
  process.removeListener("SIGINT", onSigint);
  out("\n");
}

// --- boot -------------------------------------------------------------------
preflight();
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
const thinking = entry.thinking ?? false; // D11 kernel default: thinking off
const fallbacks = fallbacksFor(models, entry); // D15 model ladder
out(`${DIM}nerve · ${entry.id} (${entry.provider}) · ${mode.toUpperCase()} · session ${session.id}${RESET}\n`);

if (prompt) {
  // one-shot
  session.addUser(prompt);
  await runTurn(session, entry.id, thinking, entry.temperature, provider, fallbacks);
  await session.close();
} else if (process.stdin.isTTY) {
  // interactive: the OpenTUI front-end (loaded lazily so headless runs don't pull in the renderer)
  const { runTui } = await import("./src/tui/app.ts");
  const { discoverSkills } = await import("./src/tui/affordances.ts");
  const { discoverCommands } = await import("./src/commands.ts");
  const cwd = process.cwd();
  const skills = await discoverSkills([join(homedir(), ".claude/skills"), join(cwd, ".claude/skills")]);
  const commands = await discoverCommands([join(homedir(), ".claude/commands"), join(cwd, ".claude/commands"), join(cwd, ".nerve/commands")]);
  await runTui({ models, entry, provider, session, mode, cwd, system: systemPrompt(), tools: toolSpecs(), skills, commands, compactionPrompt: compactionPrompt() });
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
    await runTurn(session, entry.id, thinking, entry.temperature, provider, fallbacks);
    out("> ");
  }
  await session.close();
}
