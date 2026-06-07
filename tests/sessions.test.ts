import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, lastSessionId } from "../src/sessions.ts";
import { Session } from "../src/session.ts";
import { openDb } from "../src/db.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nerve-sessions-"));
  process.env.NERVE_HOME = home; // a fresh per-project DB per test
});
afterEach(async () => {
  delete process.env.NERVE_HOME;
  await rm(home, { recursive: true, force: true });
});

/** Create a session with messages, then pin its updated_at so ordering is deterministic. */
function makeSession(id: string, msgs: [role: string, content: string][], updatedAt: number): void {
  const s = new Session({ id });
  for (const [role, content] of msgs) {
    if (role === "user") s.addUser(content);
    else if (role === "assistant") {
      s.apply({ type: "text", delta: content });
      s.commitAssistant();
    } else s.addToolResult("x", content);
  }
  openDb(process.cwd()).query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(updatedAt, id);
}

test("listSessions: newest first, counts messages, previews first user message", () => {
  makeSession("old", [["user", "old task here"], ["assistant", "ok"]], 1000);
  makeSession("new", [["user", "new task"], ["assistant", "done"], ["tool", "r"]], 2000);

  const list = listSessions();
  expect(list.map((s) => s.id)).toEqual(["new", "old"]);
  expect(list[0]!.msgs).toBe(3);
  expect(list[0]!.preview).toBe("new task");
  expect(list[1]!.preview).toBe("old task here");
});

test("lastSessionId: newest by updated_at, honors exclude", () => {
  makeSession("a", [["user", "a"]], 1000);
  makeSession("b", [["user", "b"]], 2000);
  expect(lastSessionId()).toBe("b");
  expect(lastSessionId(undefined, "b")).toBe("a"); // skip the current session → previous one
});

test("empty project → empty / undefined", () => {
  expect(listSessions()).toEqual([]);
  expect(lastSessionId()).toBeUndefined();
});
