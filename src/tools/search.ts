// Web search via DuckDuckGo's "lite" endpoint — a thin sibling of `fetch` (D28) for when the agent has
// NO url to go on. It GETs https://lite.duckduckgo.com/lite/?q=… (minimal HTML, no JS) and parses the
// result rows into a clean {title, url, snippet} list; the agent then `fetch`es a result to read it.
// Reuses fetch's entity `decode`; readonly (a GET) → usable in PLAN.
import type { Tool } from "./types.ts";
import { decode } from "./fetch.ts";

const TIMEOUT_MS = 15_000;
const DEFAULT_MAX = 8;
const HARD_MAX = 20;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Strip tags → decode entities → collapse whitespace (same order as fetch's `inline`, but decoded). */
const inlineText = (html: string): string => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** DDG wraps result links in a `/l/?uddg=<encoded real url>` redirect — unwrap it back to the real URL. */
function realUrl(href: string): string {
  const u = /[?&]uddg=([^&]+)/.exec(href);
  if (u)
    try {
      return decodeURIComponent(u[1]!);
    } catch {
      /* fall through to the raw href */
    }
  return href.startsWith("//") ? `https:${href}` : href;
}

/** Pure parser for a lite.duckduckgo.com results page → ranked results. Exported for tests (offline). */
export function parseResults(html: string, max: number): SearchResult[] {
  // Record each result's document position so snippets pair with their OWN link (the snippet that follows
  // a link, before the next link) — a positional zip would desync every later result if one link is dropped.
  const links: { title: string; url: string; pos: number }[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    if (!/result-link/.test(m[1]!)) continue; // only the result anchors, not nav/pagination
    const href = /\bhref=['"]([^'"]+)['"]/.exec(m[1]!)?.[1];
    const title = inlineText(m[2]!);
    if (href && title) links.push({ title, url: realUrl(href), pos: m.index });
  }
  const snippets: { text: string; pos: number }[] = [];
  const snipRe = /<td\b[^>]*\bclass=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = snipRe.exec(html))) snippets.push({ text: inlineText(m[1]!), pos: m.index });
  return links.slice(0, max).map((l, i) => {
    const end = links[i + 1]?.pos ?? Infinity;
    return { title: l.title, url: l.url, snippet: snippets.find((s) => s.pos > l.pos && s.pos < end)?.text ?? "" };
  });
}

export const search: Tool = {
  name: "search",
  description:
    "Search the web (DuckDuckGo) when you DON'T have a URL — to find pages, docs, or current information. " +
    "Returns a ranked list of results (title · url · snippet); then `fetch` a result's URL to read the page. " +
    "Supports query operators (quotes, site:, OR, -term).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query — plain words, or operators like \"exact\", site:host, -exclude." },
      max: { type: "number", description: `Max results to return (default ${DEFAULT_MAX}, capped at ${HARD_MAX}).` },
    },
    required: ["query"],
  },
  readonly: true, // a GET for info-gathering → usable in PLAN
  async run(args) {
    if (typeof args.query !== "string" || !args.query.trim()) return "Error: 'query' must be a non-empty string";
    const query = args.query.trim();
    // A positive request clamps to [1, HARD_MAX]; anything invalid (missing / NaN / 0 / negative) → default.
    const requested = Math.trunc(Number(args.max));
    const max = requested > 0 ? Math.min(requested, HARD_MAX) : DEFAULT_MAX;
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (nerve)", Accept: "text/html" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error searching "${query}": ${/timed out|aborted/i.test(msg) ? `timed out after ${TIMEOUT_MS / 1000}s` : msg}`;
    }
    if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText} from DuckDuckGo`;

    const results = parseResults(await res.text(), max);
    if (!results.length) return `No results for "${query}".`;
    const body = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
    return `Search: ${query}\n\n${body}\n\n(Use \`fetch\` on a URL above to read the full page.)`;
  },
};
