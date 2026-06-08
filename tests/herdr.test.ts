import { test, expect, afterEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { herdrPaneId, herdrSocketPath, herdrMessage } from "../src/herdr.ts";

const saved = { pane: Bun.env.HERDR_PANE_ID, sock: Bun.env.HERDR_SOCKET_PATH };
afterEach(() => {
  // restore whatever the env had so tests don't leak into each other
  if (saved.pane === undefined) delete Bun.env.HERDR_PANE_ID;
  else Bun.env.HERDR_PANE_ID = saved.pane;
  if (saved.sock === undefined) delete Bun.env.HERDR_SOCKET_PATH;
  else Bun.env.HERDR_SOCKET_PATH = saved.sock;
});

test("herdrPaneId: null off a herdr pane, the id when set", () => {
  delete Bun.env.HERDR_PANE_ID;
  expect(herdrPaneId()).toBeNull();
  Bun.env.HERDR_PANE_ID = "pane-7";
  expect(herdrPaneId()).toBe("pane-7");
});

test("herdrSocketPath: defaults under ~/.config, env overrides, ~/ expands", () => {
  delete Bun.env.HERDR_SOCKET_PATH;
  expect(herdrSocketPath()).toBe(join(homedir(), ".config", "herdr", "herdr.sock"));
  Bun.env.HERDR_SOCKET_PATH = "/run/herdr.sock";
  expect(herdrSocketPath()).toBe("/run/herdr.sock");
  Bun.env.HERDR_SOCKET_PATH = "~/custom/herdr.sock";
  expect(herdrSocketPath()).toBe(join(homedir(), "custom", "herdr.sock"));
});

test("herdrMessage: a valid pane.report_agent JSON-RPC line with unique ids", () => {
  const m = JSON.parse(herdrMessage("pane-3", "working"));
  expect(m.method).toBe("pane.report_agent");
  expect(m.params).toEqual({ pane_id: "pane-3", source: "nerve:tui", agent: "nerve", state: "working" });
  expect(m.id).toMatch(/^nerve-\d+$/);
  // ids increment so herdr can correlate replies
  const a = JSON.parse(herdrMessage("p", "idle")).id;
  const b = JSON.parse(herdrMessage("p", "idle")).id;
  expect(a).not.toBe(b);
});
