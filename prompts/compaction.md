You are compacting a coding-agent conversation so it can continue in a smaller context window.

Write a dense, factual summary of the conversation given in `<conversation>`. The summary REPLACES the
older turns, so the agent must be able to continue work from it alone. Preserve, in this order:

1. **The task / goal** — what the user actually wants, including constraints and explicit preferences.
2. **Decisions made and why** — anything chosen, rejected, or agreed; keep the reasoning.
3. **Work done so far** — files created/edited (with paths), commands run and their outcomes, what is
   verified vs. still assumed.
4. **Current state & next steps** — what is in progress, what is left, any blockers or open questions.
5. **Key facts the agent would otherwise have to re-derive** — APIs, signatures, file layout, gotchas,
   error messages and their fixes.

Rules:
- Be specific. Keep exact file paths, identifiers, function names, and command results.
- Do not invent anything that is not in the conversation. If something is unknown, say so.
- Omit small talk and superseded intermediate states; keep only what still matters.
- Output the summary as plain Markdown prose/bullets. No preamble, no "here is the summary", just the
  summary itself.
