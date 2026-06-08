// A tiny, zero-dep line differ for **display** (D49): show what the agent changed, like Claude Code's
// inline edit diffs. NOT sent to the model — `edit`/`write` still return their concise text result; this
// only paints the +/- for the human. Pure + unit-tested. Common prefix/suffix is trimmed before the LCS so
// localized edits (the common case) are cheap.

export interface DiffStat {
  added: number;
  removed: number;
}

type Op = [" " | "-" | "+", string];

function splitLines(s: string): string[] {
  return s === "" ? [] : s.replace(/\n$/, "").split("\n");
}

/** Line ops (context / removed / added) between two line arrays — LCS over the changed middle. */
function diffOps(a: string[], b: string[]): Op[] {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ha = a.length;
  let hb = b.length;
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) (ha--, hb--);
  const am = a.slice(lo, ha);
  const bm = b.slice(lo, hb);
  const n = am.length;
  const m = bm.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  const ops: Op[] = [];
  for (let k = 0; k < lo; k++) ops.push([" ", a[k]!]); // common prefix
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) (ops.push([" ", am[i]!]), i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) (ops.push(["-", am[i]!]), i++);
    else (ops.push(["+", bm[j]!]), j++);
  }
  while (i < n) ops.push(["-", am[i++]!]);
  while (j < m) ops.push(["+", bm[j++]!]);
  for (let k = hb; k < b.length; k++) ops.push([" ", b[k]!]); // common suffix
  return ops;
}

/** Added/removed line counts between two texts — for a compact `+a -b` summary. */
export function diffStat(oldText: string, newText: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const [tag] of diffOps(splitLines(oldText), splitLines(newText))) {
    if (tag === "+") added++;
    else if (tag === "-") removed++;
  }
  return { added, removed };
}

/**
 * A compact unified-style diff: changed lines (`+`/`-`) with up to `context` unchanged lines around each
 * hunk; far-away unchanged regions collapse to a single `⋯`. Returns "" when the texts are identical.
 * Render as a ```diff block (syntax-highlighted) or themed +/- rows.
 */
export function lineDiff(oldText: string, newText: string, context = 3): string {
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  if (!ops.some(([tag]) => tag !== " ")) return "";
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]![0] === " ") continue;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  }
  const out: string[] = [];
  let gap = false;
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) (out.push(ops[i]![0] + ops[i]![1]), (gap = false));
    else if (!gap) (out.push("⋯"), (gap = true));
  }
  return out.join("\n");
}
