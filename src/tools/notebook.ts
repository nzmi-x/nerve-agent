// Run a marimo notebook headlessly and report each cell's output + errors (D23). marimo notebooks are
// pure `.py`, so read/edit/append cells with the normal `read`/`edit`/`write` tools (+ pyrefly/ruff
// diagnostics for free); this is the one new capability — execution. No server: `marimo export ipynb
// --include-outputs` runs the notebook and embeds outputs, which we parse. uv provisions marimo (and
// the notebook's own deps come from the project env). See manual("marimo").
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Tool } from "./types.ts";

const MAX_CELL_CHARS = 1500;
const MAX_TOTAL_CHARS = 12_000;
const RUN_TIMEOUT_MS = 300_000; // first run provisions marimo via uv; later runs hit uv's cache

interface NbOutput {
  output_type: string;
  text?: string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
}
interface NbCell {
  cell_type: string;
  source?: string[];
  outputs?: NbOutput[];
}

const textOf = (v: unknown): string => (Array.isArray(v) ? v.join("") : String(v ?? ""));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Pure: render an executed `.ipynb` (from `marimo export … --include-outputs`) into a terse report. */
export function formatRun(nb: { cells?: NbCell[] }): string {
  const cells = (nb.cells ?? []).filter((c) => c.cell_type === "code");
  let errors = 0;
  const blocks: string[] = [];
  cells.forEach((c, i) => {
    const head = clip((c.source ?? []).join("").trim().split("\n")[0] ?? "", 60);
    const parts: string[] = [];
    for (const o of c.outputs ?? []) {
      if (o.output_type === "stream") parts.push(textOf(o.text).trimEnd());
      else if (o.output_type === "execute_result" || o.output_type === "display_data") parts.push(textOf(o.data?.["text/plain"]).trimEnd());
      else if (o.output_type === "error") {
        errors++;
        parts.push(`✗ ${o.ename}: ${o.evalue}`);
      }
    }
    const body = clip(parts.filter(Boolean).join("\n").trim(), MAX_CELL_CHARS);
    blocks.push(`[cell ${i}] ${head}${body ? `\n${body.replace(/^/gm, "  ")}` : "  → (no output)"}`);
  });
  const header = cells.length === 0 ? "marimo run — no code cells" : errors ? `marimo run — ${errors} cell(s) errored` : `marimo run — ${cells.length} cell(s) ok`;
  return clip(`${header}\n${blocks.join("\n")}`, MAX_TOTAL_CHARS);
}

export const notebook: Tool = {
  name: "notebook",
  description:
    "Run a marimo notebook (a `.py` file) headlessly and report each cell's output + errors. marimo " +
    "notebooks are plain Python — read/edit/append cells with read/edit/write; call manual(\"marimo\") " +
    "for the cell format. Executes code (EDIT mode only). Needs `uv` on PATH (provisions marimo).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the marimo notebook (.py)." },
    },
    required: ["path"],
  },
  readonly: false,
  async run(args, ctx) {
    if (typeof args.path !== "string") return "Error: 'path' must be a string";
    if (!Bun.which("uv")) return "uv not installed — `curl -LsSf https://astral.sh/uv/install.sh | sh` (nerve runs marimo via uv).";
    const nb = resolve(ctx.cwd, args.path);
    if (!(await Bun.file(nb).exists())) return `Error: no such file: ${args.path}`;

    const out = join(tmpdir(), `nerve-nb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ipynb`);
    const proc = Bun.spawn(
      ["uv", "run", "--with", "marimo", "--with", "nbformat", "marimo", "export", "ipynb", nb, "-o", out, "--include-outputs"],
      { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
    const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);

    const exported = Bun.file(out);
    if (!(await exported.exists())) {
      // export failed outright (syntax error, bad notebook, uv resolution) — surface stderr
      return `marimo run failed:\n${clip(stderr.trim() || "(no error output)", 2000)}`;
    }
    try {
      return formatRun(JSON.parse(await exported.text()) as { cells?: NbCell[] });
    } catch (e) {
      return `marimo run: couldn't parse output — ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await unlink(out).catch(() => {});
    }
  },
};
