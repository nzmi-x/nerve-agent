---
name: ruff
description: Extremely fast Python linter + formatter. Style, imports, and autofixes.
---

# ruff — Python linter + formatter

nerve runs **ruff's LSP automatically** on Python files (lint diagnostics on edit). CLI (via `bash`):

- `ruff check <files>` — lint. `--fix` applies autofixes; `ruff check --select I --fix` sorts imports.
- `ruff format <files>` — format (**edits in place**).

**You don't need to call these after editing** — nerve auto-runs, on the Python files you touched at
the end of the turn (D24): `ruff check --select I --fix` → `ruff check --fix` → `ruff format` →
`ruff check`. So write idiomatic Python and let the formatter shape it; don't hand-format or fight it.

Read the post-edit report and address any remaining `ruff check` warnings (autofix can't fix all).
