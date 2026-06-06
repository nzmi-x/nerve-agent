# balance

**Status:** built (Phase 1). Wired into the status line + `/balance` with the TUI slice.
**What:** provider account balance lookup.
**Code:** `src/balance.ts` (tests: `tests/balance.test.ts`).

**How it works:**
- `fetchBalance(provider, key)` — DeepSeek: `GET https://api.deepseek.com/user/balance`
  (`Authorization: Bearer`), parsed by `parseBalance` (prefers the USD entry). **Gemini returns
  `null`** — the Developer API has no per-key balance endpoint (billing is Google Cloud), so it
  shows `n/a` ([D-answer](../DECISIONS.md)).
- `formatBalance` → `"$19.47"` / `"¥110.00"` / `"n/a"` / `"… (low)"` when `is_available` is false.

**How to change it:**
- A new provider with a balance API → add a branch in `fetchBalance` + a parser. Keep parse/format
  pure (the fetch is the only live part).

**Gotchas:**
- `total_balance` is a **string** in the wire response — `parseBalance` `Number()`s it.
- Verified live (real key) — keep it a read-only GET; never cache the key.

**See:** [providers.md](../providers.md) · [usage](usage.md)
