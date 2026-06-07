// Fetch a URL with Bun's native `fetch` (no deps) and return readable content (D28). HTML is converted
// to Markdown to cut tokens and ease reading; JSON is pretty-printed; other text is returned as-is.
// The export is `fetchTool` (not `fetch`) so it doesn't shadow the global `fetch` we call inside.
import type { Tool } from "./types.ts";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 60_000;
const MAX_BYTES = 5_000_000; // skip huge bodies

const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', copy: "©", reg: "®", trade: "™", deg: "°",
};
export function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const stripTags = (s: string): string => s.replace(/<[^>]+>/g, "");
// Strip tags + collapse whitespace, but DON'T decode entities yet — decoding happens once at the very
// end (after the final stripTags), so a `&lt;b&gt;` in text/code can't be re-stripped as a fake tag.
const inline = (s: string): string => stripTags(s).replace(/\s+/g, " ").trim();

/** Lean HTML → Markdown (D28): keeps headings/links/lists/code, drops chrome. Refine later (e.g. HTMLRewriter). */
export function htmlToMarkdown(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|nav|footer|aside|form|svg|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(s);
  if (body) s = body[1]!;
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c: string) => `\n\n\`\`\`\n${stripTags(c).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(+n)} ${inline(t)}\n\n`);
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
    const text = inline(t);
    return text ? `[${text}](${href})` : "";
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __: string, t: string) => `**${inline(t)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __: string, t: string) => `*${inline(t)}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => `\`${inline(t)}\``);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t: string) => `\n- ${inline(t)}`);
  s = s.replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|header|main)>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = decode(stripTags(s));
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

export const fetchTool: Tool = {
  name: "fetch",
  description:
    "Fetch a URL over HTTP(S) GET and return its content for reading — HTML is converted to Markdown " +
    "(smaller + readable), JSON is pretty-printed, other text is returned as-is. Use for docs, web pages, or JSON APIs.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "The http(s) URL to fetch." } },
    required: ["url"],
  },
  readonly: true, // a GET for info-gathering → usable in PLAN
  async run(args) {
    if (typeof args.url !== "string") return "Error: 'url' must be a string";
    const url = /^https?:\/\//i.test(args.url.trim()) ? args.url.trim() : `https://${args.url.trim()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (nerve)", Accept: "text/html,application/json,text/plain,*/*" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error fetching ${url}: ${/timed out|aborted/i.test(msg) ? `timed out after ${TIMEOUT_MS / 1000}s` : msg}`;
    }
    if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText} for ${url}`;

    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const isText = type.includes("json") || type.includes("html") || type.includes("xml") || type.startsWith("text/") || type === "";
    if (!isText) return `(${type || "binary"} content at ${url} — not shown)`;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return `(${url} is too large to fetch — ${res.headers.get("content-length")} bytes)`;

    const raw = await res.text();
    let out: string;
    if (type.includes("json")) {
      try {
        out = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        out = raw;
      }
    } else if (type.includes("html")) {
      out = htmlToMarkdown(raw);
    } else {
      out = raw;
    }
    out = out.trim();
    if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}\n… (truncated; ${out.length} chars)`;
    return `${url}\n\n${out || "(empty response)"}`;
  },
};
