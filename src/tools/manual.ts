import { join, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import type { Tool } from "./types.ts";

// nerve's own install root — the manual serves nerve's docs regardless of the user's working dir.
const ROOT = resolve(import.meta.dir, "../..");
const DOCS = join(ROOT, "docs");
const MANUAL = join(DOCS, "manual");
const OPENTUI = join(ROOT, ".claude/skills/opentui");

async function mdTopics(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

/** All topics, auto-discovered from the filesystem (manual pages + top-level docs + opentui). */
async function listTopics(): Promise<string[]> {
  const set = new Set<string>([...(await mdTopics(MANUAL)), ...(await mdTopics(DOCS)), "opentui"]);
  return [...set].sort();
}

/** The vendored OpenTUI skill path for `opentui` and `opentui/<slug>` topics. */
function opentuiPath(topic: string): string {
  if (topic === "opentui") return join(OPENTUI, "SKILL.md");
  const slug = topic.slice("opentui/".length);
  return join(OPENTUI, "docs", slug.endsWith(".mdx") ? slug : `${slug}.mdx`);
}

export const manual: Tool = {
  name: "manual",
  description:
    "Read nerve's own operator manual — how a subsystem works and how to change it. Call with no " +
    "topic for the index. Topic 'opentui' (and 'opentui/<slug>') serves the OpenTUI API on demand.",
  parameters: {
    type: "object",
    properties: { topic: { type: "string", description: "A topic name, or omit for the index." } },
  },
  readonly: true,
  async run(args) {
    const topics = await listTopics();
    const index = `nerve manual — topics:\n${topics.map((t) => `  ${t}`).join("\n")}\n\nCall manual({"topic":"<name>"}). OpenTUI sub-pages: manual({"topic":"opentui/<slug>"}).`;

    const topic = typeof args.topic === "string" ? args.topic.trim() : "";
    if (!topic || topic === "index") return index;
    if (topic.includes("..")) return "Error: invalid topic";

    // manual pages take precedence over same-named top-level docs (e.g. "providers")
    const candidates =
      topic === "opentui" || topic.startsWith("opentui/")
        ? [opentuiPath(topic)]
        : [join(MANUAL, `${topic}.md`), join(DOCS, `${topic}.md`)];
    for (const p of candidates) {
      if (await Bun.file(p).exists()) return await Bun.file(p).text();
    }
    return `Error: no manual topic "${topic}".\n\n${index}`;
  },
};
