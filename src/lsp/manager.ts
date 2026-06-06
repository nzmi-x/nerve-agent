// The LSP manager (D10): loads the committed catalog, lazily spawns the servers for a file's language
// (multiple per language — pyrefly + ruff for Python), aggregates their diagnostics, and routes
// queries to whichever server advertises the capability. nerve does NOT install servers — a missing
// one surfaces an actionable install hint. Raw, zero-dep (see client.ts). See docs/manual/lsp.md.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LspClient } from "./client.ts";
import { OP, formatDiagnostic, formatResult, type LspOp } from "./format.ts";
import { globalLspPath } from "../paths.ts";

export type { LspOp } from "./format.ts";

interface ServerCfg {
  id: string;
  extensions: string[];
  command: string;
  args?: string[];
  rootMarkers?: string[];
  install?: string;
  env?: Record<string, string>;
}

const BUNDLED = resolve(import.meta.dir, "../../config/lsp.json");
const LANGUAGE_ID: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
};
const SETTLE_MS = 800; // servers publish diagnostics async after didChange (pyrefly lints then type-checks)
const MAX_DIAGS = 30;

export function loadServers(path?: string): ServerCfg[] {
  const p = path ?? (existsSync(globalLspPath()) ? globalLspPath() : BUNDLED);
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { servers?: ServerCfg[] }).servers ?? [];
  } catch {
    return [];
  }
}

const ext = (path: string): string => {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i);
};
const uriOf = (path: string): string => `file://${resolve(path)}`;

export function findRoot(start: string, markers: string[]): string {
  let dir = resolve(start);
  for (;;) {
    for (const m of markers) if (existsSync(resolve(dir, m))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export class Lsp {
  private readonly servers: ServerCfg[];
  private readonly init = new Map<string, Promise<LspClient | null>>(); // id → spawn+init (null if missing/failed)
  private readonly clients = new Map<string, LspClient>();
  private readonly reported = new Set<string>(); // ids whose "missing" hint was already shown

  constructor(
    private readonly cwd: string,
    servers?: ServerCfg[],
  ) {
    this.servers = servers ?? loadServers();
  }

  private serversFor(path: string): ServerCfg[] {
    const e = ext(path);
    return this.servers.filter((s) => s.extensions.includes(e));
  }

  /** Spawn + initialize a server once (cached). Returns null if the binary is missing or init fails. */
  private ensure(cfg: ServerCfg): Promise<LspClient | null> {
    let p = this.init.get(cfg.id);
    if (p) return p;
    p = (async () => {
      if (!Bun.which(cfg.command)) return null;
      const client = new LspClient(cfg.id, cfg.command, cfg.args ?? [], this.cwd, cfg.env);
      try {
        await client.initialize(uriOf(findRoot(this.cwd, cfg.rootMarkers ?? [".git"])));
        this.clients.set(cfg.id, client);
        return client;
      } catch {
        await client.stop().catch(() => {});
        return null;
      }
    })();
    this.init.set(cfg.id, p);
    return p;
  }

  /** One-time install hints for a path's missing servers. */
  private hints(path: string): string[] {
    const out: string[] = [];
    for (const s of this.serversFor(path)) {
      if (!Bun.which(s.command) && !this.reported.has(s.id)) {
        this.reported.add(s.id);
        out.push(`${s.id} not installed — \`${s.install ?? s.command}\` to enable ${s.id} diagnostics`);
      }
    }
    return out;
  }

  /**
   * Sync a file to its servers and return a formatted diagnostics block to append to a tool result.
   * `wait` (default true) settles for fresh diagnostics — write/edit want that; `read` passes false to
   * prime the server + report whatever's already cached without paying the latency.
   */
  async diagnostics(path: string, text: string, wait = true): Promise<string> {
    const cfgs = this.serversFor(path);
    if (!cfgs.length) return "";
    const uri = uriOf(path);
    const lang = LANGUAGE_ID[ext(path)] ?? "plaintext";
    const hints = this.hints(path);
    const clients = (await Promise.all(cfgs.map((c) => this.ensure(c)))).filter((c): c is LspClient => !!c);
    for (const c of clients) c.sync(uri, lang, text);
    if (wait && clients.length) await Bun.sleep(SETTLE_MS);

    const lines: string[] = [];
    for (const c of clients) for (const d of c.diagnosticsFor(uri)) lines.push(formatDiagnostic(c.id, d));
    lines.sort();
    const head = hints.map((h) => `  (${h})`);
    if (!lines.length) return head.length ? `\n[lsp]\n${head.join("\n")}` : "";
    const shown = lines.slice(0, MAX_DIAGS);
    const more = lines.length > shown.length ? `\n  … (+${lines.length - shown.length} more)` : "";
    return `\n[lsp diagnostics]\n${head.length ? head.join("\n") + "\n" : ""}${shown.join("\n")}${more}`;
  }

  /** Run a read-only query. `line`/`character` are 1-based (editor coords); converted to 0-based here. */
  async query(op: LspOp, path: string, line = 1, character = 1, symbol?: string): Promise<string> {
    const cfgs = this.serversFor(path);
    if (!cfgs.length) return `No language server configured for ${ext(path) || path}.`;
    const uri = uriOf(path);
    const lang = LANGUAGE_ID[ext(path)] ?? "plaintext";
    let text = "";
    try {
      text = await Bun.file(path).text();
    } catch {
      /* file may not exist (e.g. workspaceSymbol) */
    }
    for (const cfg of cfgs) {
      const client = await this.ensure(cfg);
      if (!client) continue;
      if (op !== "workspaceSymbol" && text) client.sync(uri, lang, text);
      if (!client.supports(OP[op].capability)) continue;
      const params: Record<string, unknown> =
        op === "workspaceSymbol" ? { query: symbol ?? "" }
        : op === "documentSymbol" ? { textDocument: { uri } }
        : {
            textDocument: { uri },
            position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
            ...(op === "references" ? { context: { includeDeclaration: true } } : {}),
          };
      try {
        if (op !== "documentSymbol" && op !== "workspaceSymbol") await Bun.sleep(50); // let the buffer settle
        const out = formatResult(op, await client.request(OP[op].method, params));
        if (out) return out;
      } catch (e) {
        return `lsp ${op} failed (${cfg.id}): ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const hints = this.hints(path);
    return hints.length ? hints.join("\n") : `No ${op} result.`;
  }

  async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop().catch(() => {})));
    this.clients.clear();
    this.init.clear();
  }
}
