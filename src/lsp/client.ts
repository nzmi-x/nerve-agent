// One LSP server connection: raw JSON-RPC over stdio, zero deps (D10). Spawns the server, frames
// messages with Content-Length, correlates request↔response by id, answers the few server→client
// requests so the server doesn't hang, and caches publishDiagnostics by URI. See docs/manual/lsp.md.
import type { Subprocess } from "bun";

type Json = Record<string, unknown>;
export interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number; // 1 error · 2 warning · 3 info · 4 hint
  message: string;
  source?: string;
  code?: string | number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

type Bytes = Uint8Array<ArrayBufferLike>;
function concat(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function findHeaderEnd(buf: Bytes): number {
  for (let i = 3; i < buf.length; i++) {
    if (buf[i - 3] === 13 && buf[i - 2] === 10 && buf[i - 1] === 13 && buf[i] === 10) return i - 3; // \r\n\r\n
  }
  return -1;
}

export class LspClient {
  readonly id: string;
  capabilities: Json = {};
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private readonly diagnostics = new Map<string, Diagnostic[]>(); // by document URI
  private readonly opened = new Map<string, number>(); // uri → version
  private alive = true;

  constructor(id: string, command: string, args: string[], cwd: string, env?: Record<string, string>) {
    this.id = id;
    this.proc = Bun.spawn([command, ...args], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: env ? { ...process.env, ...env } : process.env,
    });
    void this.readLoop();
    void this.proc.exited.then(() => {
      this.alive = false;
      for (const p of this.pending.values()) p.reject(new Error(`${id} server exited`));
      this.pending.clear();
    });
  }

  /** Drains the framed stdout stream, dispatching responses / notifications / server requests. */
  private async readLoop(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    let buf: Bytes = new Uint8Array(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = concat(buf, value);
        for (;;) {
          const headEnd = findHeaderEnd(buf);
          if (headEnd < 0) break;
          const header = dec.decode(buf.subarray(0, headEnd));
          const m = /content-length:\s*(\d+)/i.exec(header);
          const bodyStart = headEnd + 4;
          if (!m) {
            buf = buf.subarray(bodyStart);
            continue;
          }
          const len = Number(m[1]);
          if (buf.length < bodyStart + len) break; // wait for the rest of the body
          const body = dec.decode(buf.subarray(bodyStart, bodyStart + len));
          buf = buf.subarray(bodyStart + len);
          try {
            this.dispatch(JSON.parse(body) as Json);
          } catch {
            /* ignore a malformed frame */
          }
        }
      }
    } catch {
      /* stream closed */
    }
  }

  private dispatch(msg: Json): void {
    const id = msg.id as number | undefined;
    if (id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (msg.error) p.reject(new Error((msg.error as Json).message as string));
      else p.resolve(msg.result);
      return;
    }
    if (id !== undefined && msg.method) {
      // server → client request: answer so it doesn't block. Defaults satisfy the common ones.
      const method = msg.method as string;
      const result = method === "workspace/configuration" ? ((msg.params as Json)?.items as unknown[] ?? []).map(() => ({})) : null;
      this.send({ jsonrpc: "2.0", id, result });
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const p = msg.params as { uri: string; diagnostics: Diagnostic[] };
      this.diagnostics.set(p.uri, p.diagnostics ?? []);
    }
    // window/logMessage, $/progress, etc. are ignored
  }

  private send(msg: Json): void {
    if (!this.alive) return;
    const body = enc.encode(JSON.stringify(msg));
    this.proc.stdin.write(enc.encode(`Content-Length: ${body.length}\r\n\r\n`));
    this.proc.stdin.write(body);
    this.proc.stdin.flush();
  }

  request(method: string, params: Json): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: Json): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(rootUri: string): Promise<void> {
    const result = (await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "nerve" }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {}, references: {}, implementation: {}, typeDefinition: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: false },
          callHierarchy: { dynamicRegistration: false },
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
    })) as Json;
    this.capabilities = (result?.capabilities as Json) ?? {};
    this.notify("initialized", {});
  }

  /** Open a doc (first time) or push its new content (full-text sync). */
  sync(uri: string, languageId: string, text: string): void {
    const version = (this.opened.get(uri) ?? 0) + 1;
    this.opened.set(uri, version);
    if (version === 1) this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    else this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  diagnosticsFor(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  /** Does the server advertise a capability (e.g. "hoverProvider", "definitionProvider")? */
  supports(capability: string): boolean {
    return !!this.capabilities[capability];
  }

  async stop(): Promise<void> {
    if (!this.alive) return;
    try {
      await Promise.race([this.request("shutdown", {}), Bun.sleep(500)]);
      this.notify("exit", {});
    } catch {
      /* ignore */
    }
    this.proc.kill();
  }
}
