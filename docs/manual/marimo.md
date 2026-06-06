# marimo (notebooks)

**Status:** built (Phase 1.5), live-verified. nerve's notebook format is **marimo**, not `.ipynb` ([D23](../DECISIONS.md)).
**What:** read/edit/append cells with the normal file tools (marimo notebooks are pure `.py`); **run**
them headlessly with the `notebook` tool. No server; disk persistence via `mo.persistent_cache`.
**Code:** `src/tools/notebook.ts` (tests: `tests/notebook.test.ts`).

**The marimo format (so you edit cells correctly):**
- A notebook is a plain Python file: `import marimo`, then `__generated_with = "0.0.0"` (marimo updates
  the version; include the line or `check` warns), `app = marimo.App()`, then **cells are
  `@app.cell`-decorated functions**, ending with `if __name__ == "__main__": app.run()`.
- A cell **receives its dependencies as function args** and **returns its defined names as a tuple** —
  marimo wires the dependency graph (reactive). Example:
  ```python
  @app.cell
  def _():
      total = sum(range(10))
      return (total,)

  @app.cell
  def _(total):          # depends on `total`
      print("sum:", total)
      return
  ```
- **Reactive, not linear:** there's no hidden kernel state / run-order. A variable may be defined by
  **only one** cell. Editing a cell re-derives everything downstream.

**Reading / editing / appending cells:**
- It's `.py` → use `read`/`edit`/`write`. pyrefly + ruff diagnostics ([lsp](lsp.md)) fire on every edit, free.
- **Append a cell** = add an `@app.cell` function *before* the `if __name__ == "__main__":` line.
- To inspect a value in a run, **`print()` it** — the run report captures each cell's **stdout + errors**;
  a bare last-expression value (marimo's UI output) is not surfaced to the agent.

**Running / checking (`notebook` tool):**
- `notebook(path)` — op **`run`** (default) executes the notebook headlessly via `marimo export ipynb …
  --include-outputs` and reports each cell's output/error (`[cell N] head → output`, `N cell(s) errored`
  header). **EDIT-mode only** (executes code). Needs `uv` on PATH.
- `notebook(path, op:"check")` — marimo's **fast static lint**: the **single-definition rule** (a
  variable may be defined in only one cell), import cycles, formatting. Catches marimo-specific errors
  pyrefly/ruff can't see, **without running**. A `run` that fails structurally falls back to this.
  **Run `check` after editing a notebook** — it's the marimo equivalent of the LSP diagnostics you get
  on a normal `.py` edit.
- The notebook's own imports come from **your uv project env** (launch nerve in the project); marimo +
  nbformat are layered on by uv. A missing import → that cell errors → `uv add <pkg>`.

**Converting an existing `.ipynb`** (one-off, via `bash`): `uvx --with nbformat marimo convert old.ipynb -o old.py`
(outputs are stripped). Export back with `marimo export ipynb nb.py -o nb.ipynb --include-outputs`.

**Persistence without a server:** wrap an expensive computation in `with mo.persistent_cache(name="…"):`
(or `@mo.cache`/`@mo.persistent_cache`) — results are stored on disk (`__marimo__/cache/`) and reused
across runs. This is why nerve needs no notebook server ([D23](../DECISIONS.md)).

**Gotchas:**
- First `notebook` run provisions marimo via uv (slow once; uv-cached after).
- Bare-expression cell values aren't in the report — `print()` to see them.
- Respect marimo's single-definition rule (one cell per variable) — `notebook(…, op:"check")` catches
  violations; a `run` that can't even export falls back to `check` automatically.
- marimo doesn't ship its own LSP — it federates **pyrefly** (and others), which nerve already runs on
  `.py` ([lsp](lsp.md)). So you get the same intelligence marimo's editor uses, free.

**See:** [DECISIONS D23](../DECISIONS.md) · [tools](tools.md) · [lsp](lsp.md)
