// Collapse redundancy in tool output before it reaches the model (D41): runs of identical consecutive
// lines, and a long run of a single character within a line, become a readable `⟨repeated N×⟩` / `⟨×N⟩`
// marker. This removes only redundancy — *what* repeated and *how often* both survive — so, unlike a
// truncating char cap, it never loses the tail (the useful end of a log or error). Applied in `dispatch`
// to every tool result EXCEPT `read` (whose `LINE#HASH` anchors must stay byte-exact for `edit`, D3).
// Pure + unit-tested. (Replaces the old per-tool output caps — bash/fetch/grep — which truncated and lost
// content; genuinely huge *non-repetitive* output is left to compaction/pruning, not pre-truncated.)

const MIN_LINE_RUN = 3; // collapse 3+ identical consecutive lines
const CHAR_RUN = /(.)\1{79,}/g; // one character repeated 80+ times within a line (separators, progress bars)

/** Collapse a long run of one repeated character within a line, e.g. a 200-char rule → `=⟨×200⟩`. */
function collapseCharRuns(line: string): string {
  return line.replace(CHAR_RUN, (m, ch: string) => `${ch}⟨×${m.length}⟩`);
}

/**
 * Collapse repeated lines + long character runs. A run of `MIN_LINE_RUN`+ identical lines is emitted once
 * followed by `⟨repeated N×⟩`; below the threshold every line is kept verbatim (char-runs still collapse).
 */
export function collapseRuns(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let run = 1;
    while (i + run < lines.length && lines[i + run] === lines[i]) run++;
    const display = collapseCharRuns(lines[i]!);
    if (run >= MIN_LINE_RUN) out.push(display, `⟨repeated ${run}×⟩`);
    else for (let k = 0; k < run; k++) out.push(display);
    i += run;
  }
  return out.join("\n");
}
