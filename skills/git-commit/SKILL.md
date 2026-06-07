---
name: git-commit
description: Conventional Commits — analyze the diff, group logically, write a semantic message. Always-on.
---

# Git commits — Conventional Commits

When committing, read the actual diff (`git diff --staged` / `git diff` / `git status --porcelain`)
and write a **Conventional Commit**. One logical change per commit — stage related files together and
split unrelated work into separate commits.

```
<type>[optional scope]: <description>

[optional body explaining *why*]

[optional footer — e.g. Closes #123]
```

**Types:** `feat` (feature) · `fix` (bug) · `docs` · `style` (formatting, no logic) · `refactor` ·
`perf` · `test` · `build` (deps/build) · `ci` · `chore` · `revert`.

**Breaking change:** `feat!: …` (bang after type/scope) and/or a `BREAKING CHANGE: …` footer.

**Description:** imperative, present tense ("add", not "added"/"adds"), ≤72 chars, no trailing period.

Multi-line message (body/footer):
```bash
git commit -m "$(cat <<'EOF'
feat(scope): short description

Why this change, not what (the diff shows what).
EOF
)"
```

## Rules

- **One logical change per commit.** Stage whole files for the group (`git add <files>`); the shell is
  non-interactive, so `git add -p` / `git rebase -i` won't work.
- **Never commit secrets** — `.env`, keys, credential files.
- **Never** `git config` changes, `--force`, or hard reset unless the user explicitly asks.
- Don't add `Co-Authored-By`/tool-attribution footers unless asked.
