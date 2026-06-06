// Provider balance lookup. DeepSeek exposes GET /user/balance; the Gemini Developer API has no
// per-key balance endpoint (billing is Google Cloud), so it returns null → "n/a". Parsing +
// formatting are pure (unit-tested); the fetch is live-smoke-tested. See docs/manual/balance.md.

export interface Balance {
  currency: string;
  total: number;
  available: boolean;
}

/** Parse a DeepSeek /user/balance response. Prefers the USD entry, else the first. */
export function parseBalance(data: unknown): Balance | null {
  const d = data as { is_available?: boolean; balance_infos?: { currency?: string; total_balance?: string }[] };
  const infos = d.balance_infos ?? [];
  const info = infos.find((i) => i.currency === "USD") ?? infos[0];
  if (!info) return null;
  return { currency: info.currency ?? "USD", total: Number(info.total_balance ?? "0"), available: d.is_available ?? true };
}

export async function fetchBalance(
  provider: "deepseek" | "gemini",
  key: string,
  signal?: AbortSignal,
): Promise<Balance | null> {
  if (provider !== "deepseek") return null; // Gemini has no API balance endpoint
  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${key}` },
    signal,
  });
  if (!res.ok) throw new Error(`DeepSeek balance ${res.status}: ${await res.text().catch(() => "")}`);
  return parseBalance(await res.json());
}

export function formatBalance(b: Balance | null): string {
  if (!b) return "n/a";
  const sym = b.currency === "USD" ? "$" : b.currency === "CNY" ? "¥" : "";
  const amt = sym ? `${sym}${b.total.toFixed(2)}` : `${b.total.toFixed(2)} ${b.currency}`;
  return b.available ? amt : `${amt} (low)`;
}
