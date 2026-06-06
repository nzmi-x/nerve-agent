// Session-file discovery for `--resume`, `/resume`, and `/sessions`. The transcript files are the
// source of truth (D8), so "list/last" is just reading `.nerve/sessions/*.jsonl`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SESSIONS_DIR = join(".nerve", "sessions");

export interface SessionInfo {
  id: string;
  mtimeMs: number;
  size: number;
  msgs: number; // count of canonical `msg` lines
  preview: string; // first user message, whitespace-collapsed
}

/** Full listing (reads each file) — newest first. For the interactive `/sessions` command. */
export function listSessions(dir: string = SESSIONS_DIR): SessionInfo[] {
  if (!existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join(dir, f);
    const st = statSync(path);
    let msgs = 0;
    let preview = "";
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        const o = JSON.parse(line) as { t?: string; role?: string; content?: unknown };
        if (o.t !== "msg") continue;
        msgs++;
        if (!preview && o.role === "user" && typeof o.content === "string") preview = o.content.replace(/\s+/g, " ").trim();
      }
    } catch {
      // a half-written tail shouldn't hide the session
    }
    out.push({ id: f.replace(/\.jsonl$/, ""), mtimeMs: st.mtimeMs, size: st.size, msgs, preview });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The most recent session id by mtime (stat-only, no content read), optionally excluding one id. */
export function lastSessionId(dir: string = SESSIONS_DIR, exclude?: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  let best: { id: string; mtimeMs: number } | undefined;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const id = f.replace(/\.jsonl$/, "");
    if (id === exclude) continue;
    const mtimeMs = statSync(join(dir, f)).mtimeMs;
    if (!best || mtimeMs > best.mtimeMs) best = { id, mtimeMs };
  }
  return best?.id;
}
