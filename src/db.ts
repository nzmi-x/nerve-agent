// SQLite persistence substrate (D31): one DB per project at ~/.nerve/projects/<slug>/nerve.db, via
// Bun's built-in `bun:sqlite` (zero external dep). **Runtime state** (sessions) lives here, replacing the
// old append-only JSONL. Config stays as files (.env keys, committed models.json/lsp.json) and **skills
// stay on the filesystem** for Claude-compat (D12) — neither belongs in the DB. Connections are cached
// per project so the schema migrates once; `$NERVE_HOME` (tests) repoints the whole tree.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./paths.ts";

const conns = new Map<string, Database>();

/** Open (and migrate) the project's DB, cached per project dir. */
export function openDb(cwd: string = process.cwd()): Database {
  const dir = projectDir(cwd);
  const cached = conns.get(dir);
  if (cached) return cached;
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "nerve.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq          INTEGER NOT NULL,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      reasoning    TEXT,
      tool_calls   TEXT,
      tool_call_id TEXT,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS compactions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      at         INTEGER NOT NULL,
      summary    TEXT NOT NULL,
      first_kept INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  `);
  conns.set(dir, db);
  return db;
}
