#!/usr/bin/env bun
// nerve — kernel runner (headless). The interactive OpenTUI front-end lands next; for now this runs
// one-shot prompts (`-p "…"`) or a simple stdin REPL, streaming to stdout. See docs/manual/loop.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadModels, providerFor, selectModel } from "./src/config.ts";
import { Session } from "./src/session.ts";
import { loop } from "./src/loop.ts";
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

// Non-interactive ask_user: auto-pick the recommended option (the TUI provides the real picker).
function headlessAsk(req: AskRequest): Promise<string> {
  const rec = req.options.find((o) => o.recommended) ?? req.options[0]!;
  out(`\n${DIM}? ${req.question} → auto: ${rec.label}${RESET}\n`);
  return Promise.resolve(rec.label);
}

function lastSessionId(): string {
  const dir = join(".nerve", "sessions");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
  const last = files.at(-1);
  if (!last) {
    console.error("nerve: no sessions to resume");
    process.exit(1);
  }
  return last.replace(/\.jsonl$/, "");
}

async function runTurn(session: Session, entryId: string, thinking: boolean, temperature: number | undefined, provider: Provider): Promise<void> {
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
    onEvent: (ev) => {
      if (ev.type === "text") out(ev.delta);
    },
    onToolResult: (name, result) => out(`\n${DIM}→ ${name}: ${result.split("\n")[0]?.slice(0, 120) ?? ""}${RESET}\n`),
  });
  process.removeListener("SIGINT", onSigint);
  out("\n");
}

// --- boot -------------------------------------------------------------------
const models = loadModels();
const entry = selectModel(models, arg("--model"));
let provider: Provider;
try {
  provider = providerFor(entry);
} catch (e) {
  console.error(`nerve: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const session = new Session(resume ? { id: resume === "last" ? lastSessionId() : resume, resume: true } : {});
const thinking = entry.thinking ?? false; // D11 kernel default: thinking off
out(`${DIM}nerve · ${entry.id} (${entry.provider}) · ${mode.toUpperCase()} · session ${session.id}${RESET}\n`);

if (prompt) {
  // one-shot
  session.addUser(prompt);
  await runTurn(session, entry.id, thinking, entry.temperature, provider);
  await session.close();
} else if (process.stdin.isTTY) {
  // interactive: the OpenTUI front-end (loaded lazily so headless runs don't pull in the renderer)
  const { runTui } = await import("./src/tui/app.ts");
  const { discoverSkills } = await import("./src/tui/affordances.ts");
  const skills = await discoverSkills([join(homedir(), ".claude/skills"), join(process.cwd(), ".claude/skills")]);
  await runTui({ models, entry, provider, session, mode, cwd: process.cwd(), system: systemPrompt(), tools: toolSpecs(), skills });
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
    await runTurn(session, entry.id, thinking, entry.temperature, provider);
    out("> ");
  }
  await session.close();
}
