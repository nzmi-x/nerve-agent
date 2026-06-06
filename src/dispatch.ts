// The permission gate (D4). PLAN is read-only; EDIT runs everything. The mode is passed in from the
// human-controlled TUI — there is deliberately NO way for the model to change it (no set_mode tool,
// no model-writable flag). This is a hand-built safety seam (D11) and stays that way.
import { toolByName } from "./tools/registry.ts";
import type { Tool, ToolContext } from "./tools/types.ts";

export type Mode = "plan" | "edit";
export type Decision = { ok: true } | { ok: false; reason: string };

// Metacharacters that enable chaining / redirection / substitution / subshells — never in PLAN bash.
// (Glob chars * ? [ ] are allowed; they only expand paths for read commands.)
const METACHAR = /[<>|;&$`(){}\n\r]/;

// Obviously read-only programs. A program whose name alone can't mutate (no in-arg write flags).
// Deliberately conservative: anything not here is refused in PLAN — build a tool or switch to EDIT.
const SAFE_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "nl", "tac", "find", "tree", "pwd", "echo", "printf",
  "rg", "grep", "egrep", "fgrep", "fd", "stat", "file", "du", "df", "realpath", "readlink",
  "basename", "dirname", "which", "type", "whoami", "id", "hostname", "uname", "date",
  "env", "printenv", "sort", "uniq", "cut", "column", "comm", "diff", "cmp", "jq", "bat",
]);

// git is read-only only for these subcommands (no commit/add/push/checkout/branch/tag/config/stash).
const SAFE_GIT = new Set([
  "log", "diff", "status", "show", "blame", "ls-files", "ls-tree", "rev-parse", "rev-list",
  "describe", "shortlog", "reflog", "cat-file", "show-ref", "for-each-ref", "whatchanged", "name-rev", "grep",
]);

/** Is this a `bash` command obviously safe to run in PLAN mode? */
export function planBashAllowed(command: string): Decision {
  const cmd = command.trim();
  if (cmd === "") return { ok: false, reason: "empty command" };
  if (METACHAR.test(cmd)) return { ok: false, reason: "shell metacharacters aren't allowed in PLAN mode" };
  const tokens = cmd.split(/\s+/);
  const prog = tokens[0]!;
  if (prog === "git") {
    const sub = tokens[1] ?? "";
    return SAFE_GIT.has(sub)
      ? { ok: true }
      : { ok: false, reason: `'git ${sub}' isn't a read-only git subcommand allowed in PLAN mode` };
  }
  return SAFE_PROGRAMS.has(prog)
    ? { ok: true }
    : { ok: false, reason: `'${prog}' isn't an obviously-safe read-only command — build a tool, or switch to EDIT` };
}

/** The policy: may this tool call run in this mode? Pure — the unit-tested heart of the gate. */
export function allowed(tool: Tool, args: Record<string, unknown>, mode: Mode): Decision {
  if (mode === "edit") return { ok: true };
  if (tool.readonly) return { ok: true };
  if (tool.name === "bash") return planBashAllowed(typeof args.command === "string" ? args.command : "");
  return { ok: false, reason: `${tool.name} mutates — blocked in PLAN mode (switch to EDIT to run it)` };
}

/** Resolve a tool by name, gate it by mode, run it. Returns the result or a refusal/error string. */
export async function dispatch(
  name: string,
  args: Record<string, unknown>,
  mode: Mode,
  ctx: ToolContext,
): Promise<string> {
  const tool = toolByName(name);
  if (!tool) return `Error: unknown tool '${name}'`;
  const decision = allowed(tool, args, mode);
  if (!decision.ok) return `Refused (${mode.toUpperCase()} mode): ${decision.reason}`;
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    return `Error running ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
