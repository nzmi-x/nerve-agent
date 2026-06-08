// The permission gate (D4). PLAN is read-only; EDIT runs everything. The mode is passed in from the
// human-controlled TUI — there is deliberately NO way for the model to change it (no set_mode tool,
// no model-writable flag). This is a hand-built safety seam (D11) and stays that way.
import { toolByName, planVisible } from "./tools/registry.ts";
import type { Tool, ToolContext } from "./tools/types.ts";

export type Mode = "plan" | "edit";
export type Decision = { ok: true } | { ok: false; reason: string };

// Appended to the system prompt in PLAN so the agent KNOWS it's read-only and can bail out early
// instead of flailing against refusals. The mode itself is still enforced in `dispatch` (this is just
// guidance, never authority — the model can't change the mode, D4). EDIT gets no note (default behavior).
export const PLAN_NOTE =
  "## Current mode: PLAN (read-only)\n" +
  "You can read, search, and analyze, but file writes/edits and mutating shell are blocked in this mode. " +
  "If completing the request needs any of those, do NOT attempt them (they'll be refused) and do NOT keep " +
  "retrying — stop, tell the user to switch to EDIT mode (Shift+Tab), and briefly say what you'd do once " +
  "they do. Proceed normally for read-only work (questions, analysis, search, review).";

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

// --- D18: destructive-command guard (a mode-independent safety floor on the model's bash) ---------
// Catastrophic, hard-to-undo shell patterns are refused in BOTH modes — EDIT auto-runs everything, so
// a self-hosting agent shouldn't be able to wipe the machine while you're away. This is a safety
// FLOOR, not a permission tier: it never prompts (the loop can't block — it hard-refuses), never
// touches the human-only mode switch (D4), and does NOT gate the human's `!`-shell escape (D14, the
// human is trusted). Conservative on purpose; the list grows by judgement (recorded in DECISIONS D18).
const DESTRUCTIVE: { re: RegExp; reason: string }[] = [
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { re: /\bmkfs\b/, reason: "filesystem format (mkfs)" },
  { re: /\bdd\b[^|&;]*\bof=\/dev\/(sd|hd|nvme|vd|disk|mmcblk)/, reason: "raw write to a disk device (dd)" },
  { re: />\s*\/dev\/(sd|hd|nvme|vd|disk|mmcblk)/, reason: "redirect over a disk device" },
  { re: /(^|[\s>|])(tee\s+|>>?\s*)\/etc\/(passwd|shadow|sudoers)\b/, reason: "write to a critical system file" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, reason: "pipe a network download straight into a shell" },
];

/** A `rm -rf`-class wipe of root, home, or a root-level glob. Split out because recursive+force flag
 *  detection plus an "everything" target reads more clearly than one dense regex. */
function isRootWipe(cmd: string): boolean {
  if (!/\brm\b/.test(cmd)) return false;
  const recursive = /\brm\b[^|&;]*?\s-[a-zA-Z]*r/i.test(cmd) || /\brm\b[^|&;]*--recursive/.test(cmd);
  const force = /\brm\b[^|&;]*?\s-[a-zA-Z]*f/i.test(cmd) || /\brm\b[^|&;]*--force/.test(cmd);
  if (!recursive || !force) return false;
  // a target that means "everything": /, /*, ~, ~/, ~/*, $HOME, $HOME/*
  return /\s(\/|\/\*|~|~\/\*?|\$HOME(\/\*)?)(\s|$)/.test(cmd);
}

/** Pure: is this shell command catastrophic regardless of mode? `{ok:true}` = safe to consider. (D18) */
export function dangerousCommand(command: string): Decision {
  const cmd = command.trim();
  if (isRootWipe(cmd)) return { ok: false, reason: "recursive force-remove of a root/home path" };
  for (const { re, reason } of DESTRUCTIVE) if (re.test(cmd)) return { ok: false, reason };
  return { ok: true };
}

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

/** Does this tool run read-only (idempotent, no FS mutation)? Drives parallel tool dispatch in the loop —
 *  read-only calls run concurrently, mutating ones (write/edit/bash) serially. bash is read-only:false, so
 *  it always serializes (conservative + correct, even for a PLAN-safe read command). */
export function isReadOnlyTool(name: string): boolean {
  return !!toolByName(name)?.readonly;
}

/** The policy: may this tool call run in this mode? Pure — the unit-tested heart of the gate. */
export function allowed(tool: Tool, args: Record<string, unknown>, mode: Mode): Decision {
  if (mode === "edit") return { ok: true };
  // PLAN: only PLAN-visible tools (read-only + bash) may run — the same predicate the registry advertises
  // (D39), so the model is never offered a tool the gate will refuse. bash is further gated per-command.
  if (!planVisible(tool)) return { ok: false, reason: `${tool.name} mutates — blocked in PLAN mode (switch to EDIT to run it)` };
  return tool.name === "bash" ? planBashAllowed(typeof args.command === "string" ? args.command : "") : { ok: true };
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
  // D18 safety floor: refuse catastrophic bash in BOTH modes, before the mode gate.
  if (tool.name === "bash") {
    const guard = dangerousCommand(typeof args.command === "string" ? args.command : "");
    if (!guard.ok) return `Refused (guard): ${guard.reason} — run it yourself via !shell if you really mean to`;
  }
  const decision = allowed(tool, args, mode);
  if (!decision.ok) return `Refused (${mode.toUpperCase()} mode): ${decision.reason}`;
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    return `Error running ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
