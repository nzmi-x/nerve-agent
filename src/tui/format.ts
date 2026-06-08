// Small pure string helpers for the TUI's presentation layer. No renderer/theme coupling, so they live
// apart from app.ts and are unit-testable on their own (and reused by the panel modules).
import { relative } from "node:path";

/** First line of a (possibly multi-line) string, clipped to 120 cols with an ellipsis. */
export function firstLine(s: string): string {
  const l = s.split("\n")[0] ?? "";
  return l.length > 120 ? `${l.slice(0, 117)}…` : l;
}

/** Clip a string to `n` cols, trailing ellipsis when it overflows. */
export function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Human "Ns/m/h/d ago" from an epoch-ms timestamp (never negative). */
export function rel(ms: number): string {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The shortest, clearest way to show an absolute path `p` from `cwd`: the smallest of its cwd-relative,
 *  `~`-relative (when under $HOME), and absolute forms. So an in-workspace file reads `src/x.ts`, a nearby
 *  sibling `../sib/x.ts`, a home file `~/Pictures/x.png`, and `/tmp/x.txt` stays `/tmp/x.txt` instead of
 *  blowing up into `../../../../tmp/x.txt`. Ties favour the relative/`~` form over the bare absolute. */
export function displayPath(p: string, cwd: string, home = process.env.HOME ?? ""): string {
  const candidates = [p]; // absolute — always valid
  const rel = relative(cwd, p);
  if (rel) candidates.push(rel); // cwd-relative ("" ⇒ p === cwd; skip it)
  if (home && (p === home || p.startsWith(`${home}/`))) candidates.push(`~${p.slice(home.length)}`); // ~-relative
  // Prefer the shortest; on a tie the later candidate (relative, then ~) wins — both read better than absolute.
  return candidates.reduce((best, c) => (c.length <= best.length ? c : best));
}

/** Starship-style path for the location panel (D49): `$HOME → "~"`, and when deeper than `keep` segments,
 *  keep only the last `keep` with a leading `…/`. */
export function shortenPath(cwd: string, home = process.env.HOME ?? "", keep = 3): string {
  let p = cwd.replace(/\/+$/, "") || "/";
  if (home && (p === home || p.startsWith(`${home}/`))) p = `~${p.slice(home.length)}`; // → "~" or "~/sub"
  const abs = p.startsWith("/");
  const segs = p.split("/").filter(Boolean);
  if (segs.length <= keep) return (abs ? "/" : "") + segs.join("/") || "/";
  return `…/${segs.slice(-keep).join("/")}`;
}
