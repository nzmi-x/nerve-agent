// Session discovery + admin for `--resume`, `/resume`, `/sessions` — SQLite queries (D31) over the
// per-project DB (src/db.ts), replacing the old directory scans of `.jsonl` files.
import { openDb } from "./db.ts";

export interface SessionInfo {
  id: string;
  mtimeMs: number; // updated_at
  msgs: number; // count of canonical messages
  preview: string; // first user message, whitespace-collapsed
  title: string; // agent-generated session title (D26), or "" if none
}

/** Full listing — newest first. For the interactive `/sessions` command. */
export function listSessions(cwd: string = process.cwd()): SessionInfo[] {
  const db = openDb(cwd);
  const rows = db.query("SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC").all() as { id: string; title: string; updated_at: number }[];
  return rows.map((r) => {
    const n = (db.query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(r.id) as { n: number }).n;
    const first = db.query("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY seq LIMIT 1").get(r.id) as { content: string } | null;
    return { id: r.id, mtimeMs: r.updated_at, msgs: n, preview: (first?.content ?? "").replace(/\s+/g, " ").trim(), title: r.title };
  });
}

/** The most recent session id, optionally excluding one (the current session). */
export function lastSessionId(cwd: string = process.cwd(), exclude?: string): string | undefined {
  const row = openDb(cwd).query("SELECT id FROM sessions WHERE id != ? ORDER BY updated_at DESC LIMIT 1").get(exclude ?? "") as { id: string } | null;
  return row?.id;
}

export function sessionExists(cwd: string, id: string): boolean {
  return !!openDb(cwd).query("SELECT 1 FROM sessions WHERE id = ?").get(id);
}

/** Delete a session and its messages/compactions (FK cascade). Idempotent. */
export function deleteSession(cwd: string, id: string): void {
  openDb(cwd).query("DELETE FROM sessions WHERE id = ?").run(id);
}
