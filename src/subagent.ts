// Subagents (D6): "run the loop with a fresh, isolated session + a cheaper profile, return only the
// final summary." The loop is pure + re-entrant precisely so this is thin. A subagent runs **read-only**
// (PLAN mode) on an **ephemeral** session (no DB persistence), with a curated read-only toolset that
// **excludes `task`** (no recursion). The `task` tool (src/tools/task.ts) resolves the model/provider/
// tools and calls this; keeping the run here makes it unit-testable with a fake provider.
import { loop } from "./loop.ts";
import { secretRedaction } from "./interceptors.ts";
import { Session } from "./session.ts";
import type { Provider, ToolSpec } from "./providers/types.ts";
import type { Lsp } from "./lsp/manager.ts";

export interface SubagentOptions {
  prompt: string;
  provider: Provider;
  model: string;
  tools: ToolSpec[];
  cwd: string;
  signal: AbortSignal;
  lsp?: Lsp;
  maxTurns?: number;
}

const SUBAGENT_SYSTEM = `You are a focused sub-agent, spawned to complete ONE self-contained task and report back.
- The task text is your COMPLETE brief — you share no other context with the caller.
- Your tools are READ-ONLY (read, ls, grep, glob, lsp, fetch, manual). You cannot edit files, run shell,
  ask the user anything, or spawn further sub-agents — so don't try; just gather what you need and answer.
- Work autonomously, then reply with a CONCISE final summary that directly answers the task: the findings,
  concrete file:line references where relevant, and a short conclusion. Don't narrate your steps.`;

const MAX_RESULT = 8000;

/** Run a read-only subagent to completion and return its final summary (or an error/empty note). */
export async function runSubagent(o: SubagentOptions): Promise<string> {
  const session = new Session({ ephemeral: true });
  session.addUser(o.prompt);
  let failure = "";
  await loop({
    provider: o.provider,
    session,
    model: o.model,
    mode: "plan", // read-only sandbox — enforced at dispatch (D4)
    ctx: { cwd: o.cwd, lsp: o.lsp, signal: o.signal },
    interceptors: [secretRedaction()], // scrub secrets from the subagent's output too
    signal: o.signal,
    system: SUBAGENT_SYSTEM,
    tools: o.tools,
    maxTurns: o.maxTurns ?? 12, // bound the cost
    onError: (e) => {
      failure = e instanceof Error ? e.message : String(e);
    },
  });
  const last = [...session.messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
  if (last) return last.content.trim().slice(0, MAX_RESULT);
  return failure ? `subagent failed: ${failure}` : "(subagent produced no output)";
}
