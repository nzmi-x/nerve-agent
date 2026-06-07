---
name: marimo
description: Reactive Python notebooks stored as pure .py. Edit cells with file tools; run via the notebook tool.
---

# marimo — notebooks (pure `.py`)

nerve's notebook format is **marimo** (D23): notebooks are plain Python, so **read/edit/append cells
with the normal `read`/`edit`/`write` tools** (and you get pyrefly + ruff diagnostics on edit, free).

- A cell is an `@app.cell`-decorated function that takes its dependencies as args and returns its
  defined names. A variable may be defined in **only one** cell (reactive — no hidden run-order state).
- **Run** a notebook with the **`notebook` tool**: op `run` executes it headlessly and reports each
  cell's output/errors; op `check` runs marimo's static lint (the single-definition rule). Don't invoke
  marimo by hand.
- marimo is **auto-provisioned via uv** — no global install needed, but `uv` must be on PATH.
- Persist expensive results across runs with `mo.persistent_cache` (disk, no server).

Full format + converting existing `.ipynb`: `manual("marimo")`.
