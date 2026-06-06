// Hashline: content-anchored line editing. `read` emits `LINE#HASH:content`; edits anchor at the
// hash, so a stale read diverges and is hard-rejected before it can corrupt a file (no silent
// relocation). The sole edit mechanism. See DECISIONS D3 and docs/manual/hashline.md.

// 16 chars: no hex digits, no vowels, no visually ambiguous D/G/I/L/O.
const ALPHABET = "ZPMQVRWSNKTXJBYH";

/**
 * 2-char content hash for a line (`Bun.hash`, no deps). Lines with no alphanumerics seed from the
 * line number so identical punctuation-only lines (e.g. many `}`) don't collide.
 */
export function hashLine(content: string, lineNo: number): string {
  const norm = content.endsWith("\r") ? content.slice(0, -1) : content;
  const seed = /[a-z0-9]/i.test(norm) ? 0 : lineNo;
  const h = BigInt(Bun.hash(norm, seed)); // wyhash; coerce (types say number | bigint)
  return ALPHABET[Number(h & 15n)]! + ALPHABET[Number((h >> 4n) & 15n)]!;
}

/** Split into real lines, dropping the phantom empty element a trailing newline produces. */
function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** Render content as `LINE#HASH:content` lines (what `read` emits), line numbers left-padded. */
export function encode(content: string): string {
  const lines = splitLines(content);
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}#${hashLine(line, i + 1)}:${line}`).join("\n");
}

export interface Anchor {
  line: number;
  hash: string;
}

/** Parse a `LINE#HASH` anchor (e.g. `11#KT`). */
export function parseAnchor(s: string): Anchor | null {
  const m = /^(\d+)#([A-Z]{2})$/.exec(s);
  return m ? { line: Number(m[1]), hash: m[2]! } : null;
}

export type HashOp = "replace" | "append" | "prepend";
export interface HashEdit {
  op: HashOp;
  pos: string;
  end?: string;
  lines: string[];
}

export type EditResult =
  | { ok: true; content: string }
  | { ok: false; error: string; anchors: string };

/**
 * Apply hash-anchored edits to `content`. Validates every anchor against the *original* file first;
 * any mismatch hard-rejects the whole patch and returns fresh anchors for the affected region.
 * Line numbers refer to the original file and don't shift across hunks (edits apply bottom-up).
 */
export function applyEdits(content: string, edits: HashEdit[]): EditResult {
  const lines = splitLines(content);
  const n = lines.length;

  interface Resolved {
    start: number;
    end: number;
    op: HashOp;
    lines: string[];
  }
  const resolved: Resolved[] = [];
  const stale: number[] = [];

  for (const e of edits) {
    const pos = parseAnchor(e.pos);
    if (!pos) return { ok: false, error: `bad anchor: ${JSON.stringify(e.pos)}`, anchors: "" };
    const end = e.end ? parseAnchor(e.end) : pos;
    if (!end) return { ok: false, error: `bad anchor: ${JSON.stringify(e.end)}`, anchors: "" };

    for (const a of end === pos ? [pos] : [pos, end]) {
      const cur = a.line >= 1 && a.line <= n ? lines[a.line - 1]! : undefined;
      if (cur === undefined || hashLine(cur, a.line) !== a.hash) stale.push(a.line);
    }
    resolved.push({ start: pos.line, end: end.line, op: e.op, lines: e.lines });
  }

  if (stale.length) {
    const where = [...new Set(stale)].sort((a, b) => a - b).join(", ");
    return {
      ok: false,
      error: `stale anchor(s) at line ${where} — file changed since read; re-read and retry`,
      anchors: reanchor(lines, stale),
    };
  }

  // Apply bottom-up so earlier hunks' original line numbers stay valid.
  const out = lines.slice();
  for (const r of [...resolved].sort((a, b) => b.start - a.start)) {
    if (r.op === "replace") out.splice(r.start - 1, r.end - r.start + 1, ...r.lines);
    else if (r.op === "append") out.splice(r.start, 0, ...r.lines);
    else out.splice(r.start - 1, 0, ...r.lines); // prepend
  }
  return { ok: true, content: out.join("\n") + (content.endsWith("\n") ? "\n" : "") };
}

/** Fresh `LINE#HASH:content` for the affected lines (±1 of context) so the model can retry. */
function reanchor(lines: string[], staleLines: number[]): string {
  const set = new Set<number>();
  for (const l of staleLines) for (let d = -1; d <= 1; d++) if (l + d >= 1 && l + d <= lines.length) set.add(l + d);
  const width = String(lines.length).length;
  return [...set]
    .sort((a, b) => a - b)
    .map((n) => `${String(n).padStart(width)}#${hashLine(lines[n - 1]!, n)}:${lines[n - 1]!}`)
    .join("\n");
}
