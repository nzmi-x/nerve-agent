---
name: pyrefly
description: Fast Python type checker + inference (Meta). Type errors, and auto-adding annotations.
---

# pyrefly — fast Python type checker

nerve runs **pyrefly's LSP automatically** on Python files, so type diagnostics already appear on
every `edit`/`write`/`read`. Use the CLI (via `bash`) when you want more:

- `pyrefly check <files>` — full type-check; reports errors with `file:line` locations.
- `pyrefly infer <files>` — automatically add type annotations for basic types (**edits in place**).

**You don't need to call these after editing** — nerve auto-runs `pyrefly infer` then `pyrefly check`
on the Python files you touched at the end of the turn (D24). Just write the code; read the post-edit
report and fix any type errors it surfaces.

Prefer fixing the actual types over `# type: ignore`. Keep annotations precise.
