// Language packs (D24): per-language **skills** (how-to-use guidance, injected into the system prompt
// when the language is in play) + **post-edit hooks** (auto-run fixers/checkers after an editing turn,
// so the agent doesn't call them by hand). Loaded when a file of the language is touched — i.e. the
// same trigger as the LSP servers, but independent of them. Python ships first. See docs/manual/langpack.md.
import { join, resolve } from "node:path";

export interface LangPack {
  id: string;
  extensions: string[];
  /** SKILL.md files (under `skills/`) injected into the system prompt while this language is active. */
  skillFiles: string[];
  /** Commands run on edited files at turn end — these EDIT in place (file paths are appended). */
  fixers: string[][];
  /** Commands run after the fixers — report-only (file paths appended). */
  checkers: string[][];
}

export const LANGPACKS: LangPack[] = [
  {
    id: "python",
    extensions: [".py", ".pyi"],
    skillFiles: ["pyrefly/SKILL.md", "ruff/SKILL.md"],
    fixers: [
      ["pyrefly", "infer"], // add basic type annotations (in place)
      ["ruff", "check", "--select", "I", "--fix"], // sort imports
      ["ruff", "check", "--fix"], // autofix lint
      ["ruff", "format"], // format
    ],
    checkers: [
      ["pyrefly", "check"], // type errors
      ["ruff", "check"], // remaining lint
    ],
  },
];

const SKILLS_DIR = resolve(import.meta.dir, "../skills");
const HOOK_TIMEOUT_MS = 120_000;

/**
 * Fed back to the agent when post-edit checks fail (D24). The agent **triages** — there's no hardcoded
 * retry cap; its own decision ends the loop: fixing edits the files (checks re-run), while deferring
 * means it doesn't edit, so the loop stops naturally (no edits → no hooks → no continuation).
 */
export function triagePrompt(summaries: string[]): string {
  return [
    "The automatic post-edit checks (pyrefly/ruff) flagged the following in files you just edited. Triage each:",
    "- critical / must-fix, or quick / easy → fix it now (edit the file).",
    "- not critical / can wait → leave it: briefly note which and why, and do NOT edit it.",
    "Fixing re-runs the checks. If you're leaving the rest, just say so with no further edits and we stop.",
    "",
    summaries.join("\n\n"),
  ].join("\n");
}

const extOf = (path: string): string => {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i);
};
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function langForFile(path: string): LangPack | undefined {
  const e = extOf(path);
  return LANGPACKS.find((p) => p.extensions.includes(e));
}

/** The distinct packs covering any of the given files. */
export function activePacks(files: Iterable<string>): LangPack[] {
  const out: LangPack[] = [];
  for (const f of files) {
    const p = langForFile(f);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function stripFrontmatter(md: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(md);
  return (m ? md.slice(m[0].length) : md).trim();
}

/** The concatenated skill guidance for the given packs (frontmatter stripped) — for the system prompt. */
export async function langSkills(packs: LangPack[]): Promise<string> {
  const parts: string[] = [];
  for (const p of packs) {
    for (const f of p.skillFiles) {
      const file = Bun.file(join(SKILLS_DIR, f));
      if (await file.exists()) parts.push(stripFrontmatter(await file.text()));
    }
  }
  return parts.join("\n\n");
}

async function sh(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), HOOK_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  return `${stdout}\n${stderr}`;
}

const NOISE = /pyrefly\.toml|pyrefly init|pyrefly\.org|getting-started|^\s*INFO\s+\d+ errors?\s*$/i;

/** Pure: condense a checker's output to `clean` or its real findings. */
export function checkSummary(tool: string, out: string): string {
  if (/All checks passed|^\s*INFO\s+0 errors\b/im.test(out)) return `${tool}: clean`;
  const body = out
    .split("\n")
    .filter((l) => l.trim() && !NOISE.test(l))
    .join("\n")
    .trim();
  return body ? `${tool}:\n${clip(body, 2500).replace(/^/gm, "    ")}` : `${tool}: clean`;
}

/** Run a pack's post-edit hooks on `files`: fixers edit in place, then checkers report. `issues` is
 *  true when a checker found something — the surface uses it to auto-continue the agent (D24). */
export async function runHooks(pack: LangPack, files: string[], cwd: string): Promise<{ summary: string; issues: boolean }> {
  if (!files.length) return { summary: "", issues: false };
  const missing = new Set<string>();
  for (const cmd of pack.fixers) {
    if (!Bun.which(cmd[0]!)) missing.add(cmd[0]!);
    else await sh([...cmd, ...files], cwd);
  }
  const reports: string[] = [];
  let issues = false;
  for (const cmd of pack.checkers) {
    if (!Bun.which(cmd[0]!)) {
      missing.add(cmd[0]!);
      continue;
    }
    const r = checkSummary(cmd[0]!, await sh([...cmd, ...files], cwd));
    reports.push(r);
    if (!r.endsWith(": clean")) issues = true;
  }
  const n = files.length;
  const head = `⚙ post-edit hooks (${pack.id}) · ${n} file${n === 1 ? "" : "s"}`;
  const lines = [head, ...(missing.size ? [`  not installed (skipped): ${[...missing].join(", ")}`] : []), ...reports.map((r) => `  ${r}`)];
  return { summary: lines.join("\n"), issues };
}
