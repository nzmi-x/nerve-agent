---
name: prettier
description: Opinionated code formatter for JS/TS (and JSON, CSS, Markdown). Auto-applied after edits.
---

# prettier — code formatter

nerve auto-runs **`prettier --write`** on the TS/JS files you edit, at the end of the turn (D24) — you
don't call it. So write the logic and let prettier own the formatting: spacing, quotes, semicolons,
trailing commas, line width. Don't hand-format or fight it.

For TS/JS **type and lint** diagnostics, the LSP (vtsls) already reports them on every edit — fix those
as they appear. prettier is formatting only.
