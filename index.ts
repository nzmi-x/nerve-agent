#!/usr/bin/env bun
// nerve — kernel runner (headless). The interactive OpenTUI front-end lands next; for now this runs
// one-shot prompts (`-p "…"`) or a simple stdin REPL, streaming to stdout. See docs/manual/loop.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadModels, providerFor, selectModel } from "./src/config.ts";
import { Session } from "./src/session.ts";
import { loop } from "./src/loop.ts";
import { reasoningRouter, secretRedaction, tokenTap } from "./src/interceptors.ts";
import { toolSpecs } from "./src/tools/registry.ts";
import type { Mode } from "./src/dispatch.ts";
import type { Provider } from "./src/providers/types.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const mode: Mode = arg("--mode") === "plan" ? "plan" : "yolo";
const prompt = arg("-p") ?? arg("--print");
const resume = arg("--resume");

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const out = (s: string): void => void process.stdout.write(s);

function systemPrompt(): string {
  const p = resolve(import.meta.dir, "prompts/system.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "You are nerve, a terminal coding agent.";
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
    ctx: { cwd: process.cwd() },
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
const entry = selectModel(loadModels(), arg("--model"));
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
  session.addUser(prompt);
  await runTurn(session, entry.id, thinking, entry.temperature, provider);
} else {
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
}
await session.close();
