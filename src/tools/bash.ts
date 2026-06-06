import { resolve } from "node:path";
import type { Tool } from "./types.ts";

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000;

export const bash: Tool = {
  name: "bash",
  description: "Run a shell command (bash -c) and return its combined stdout + stderr.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run." },
      cwd: { type: "string", description: "Directory to run in (default: working dir)." },
    },
    required: ["command"],
  },
  // PLAN mode independently restricts WHICH commands run (dispatch.ts); the tool itself mutates.
  readonly: false,
  async run(args, ctx) {
    if (typeof args.command !== "string") return "Error: 'command' must be a string";
    const cwd = resolve(ctx.cwd, typeof args.cwd === "string" ? args.cwd : ".");

    const proc = Bun.spawn(["bash", "-c", args.command], { cwd, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, TIMEOUT_MS);

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    let out = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
    if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + `\n… (truncated; ${out.length} chars)`;
    const status = timedOut ? ` (timed out after ${TIMEOUT_MS / 1000}s)` : code !== 0 ? ` (exit ${code})` : "";
    return (out || "(no output)") + status;
  },
};
