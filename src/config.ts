// Loads the committed model catalog (config/models.json) and resolves the active model + its
// provider. Keys come from .env via Bun.env — never from the catalog. See docs/manual/config.md.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deepseek } from "./providers/deepseek.ts";
import type { Provider } from "./providers/types.ts";

export interface ModelEntry {
  id: string;
  provider: "deepseek" | "gemini";
  label?: string;
  default?: boolean;
  temperature?: number;
  thinking?: boolean;
}

const DEFAULT_CATALOG = resolve(import.meta.dir, "../config/models.json");

export function loadModels(path: string = DEFAULT_CATALOG): ModelEntry[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as { models?: ModelEntry[] };
  if (!data.models?.length) throw new Error(`no models in ${path}`);
  return data.models;
}

/** Pick the active model: by id if given, else the one marked `default`, else the first. */
export function selectModel(models: ModelEntry[], id?: string): ModelEntry {
  if (id) {
    const found = models.find((m) => m.id === id);
    if (!found) throw new Error(`unknown model '${id}' (have: ${models.map((m) => m.id).join(", ")})`);
    return found;
  }
  return models.find((m) => m.default) ?? models[0]!;
}

const PROVIDERS: Record<ModelEntry["provider"], Provider | null> = {
  deepseek,
  gemini: null, // nerve's first self-hosted task (D11) — Claude doesn't build it
};

/** The Provider for a model, with its API key present. Throws a clear, actionable error otherwise. */
export function providerFor(entry: ModelEntry): Provider {
  const provider = PROVIDERS[entry.provider];
  if (!provider) throw new Error(`provider '${entry.provider}' isn't implemented yet — it's nerve's job to build it`);
  const key = entry.provider === "deepseek" ? Bun.env.DEEPSEEK_API_KEY : Bun.env.GEMINI_API_KEY;
  if (!key) throw new Error(`${entry.provider.toUpperCase()}_API_KEY is not set in .env`);
  return provider;
}
