// Loads the committed model catalog (config/models.json) and resolves the active model + its
// provider. Keys come from .env via Bun.env — never from the catalog. See docs/manual/config.md.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deepseek } from "./providers/deepseek.ts";
import { gemini } from "./providers/gemini.ts";
import { globalModelsPath } from "./paths.ts";
import { modelEffort, PROVIDER_EFFORTS, type Effort } from "./effort.ts";
import type { Provider } from "./providers/types.ts";
import type { Candidate } from "./loop.ts";
import type { Pricing } from "./usage.ts";

export interface ModelEntry {
  id: string;
  provider: "deepseek" | "gemini";
  label?: string;
  default?: boolean;
  /** Mark the model subagents run on (D6) — the cheap profile. Falls back to `default` if none set. */
  subagent?: boolean;
  temperature?: number;
  /** Default thinking effort (D52): off | low | medium | high | xhigh, within the provider's supported set
   *  (see `PROVIDER_EFFORTS`). Unset → falls back to the legacy `thinking` boolean, then "off". */
  effort?: Effort;
  /** Optional: narrow the *selectable* efforts for THIS model to a subset of the provider's set — e.g.
   *  Gemini Pro doesn't support `minimal` (§10). Unset → the provider's full set (`PROVIDER_EFFORTS`). */
  efforts?: Effort[];
  /** @deprecated use `effort`. Legacy boolean — true → "high", false → "off". */
  thinking?: boolean;
  /** Max context window in tokens — drives the context-used indicator. */
  contextWindow?: number;
  /** USD per 1M tokens — drives session cost tracking. */
  pricing?: Pricing;
}

const DEFAULT_CATALOG = resolve(import.meta.dir, "../config/models.json");

/** Load the model catalog. A global `~/.nerve/models.json` overrides the bundled one when present
 *  (D22), so the catalog can live with the user's config instead of nerve's install dir. */
export function loadModels(path?: string): ModelEntry[] {
  const p = path ?? (existsSync(globalModelsPath()) ? globalModelsPath() : DEFAULT_CATALOG);
  const data = JSON.parse(readFileSync(p, "utf8")) as { models?: ModelEntry[] };
  if (!data.models?.length) throw new Error(`no models in ${p}`);
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

/** The model subagents run on (D6): the `subagent`-flagged entry, else the active default. */
export function selectSubagentModel(models: ModelEntry[]): ModelEntry {
  return models.find((m) => m.subagent) ?? selectModel(models);
}

const PROVIDERS: Record<ModelEntry["provider"], Provider | null> = {
  deepseek,
  gemini, // raw v1beta client, src/providers/gemini.ts (D11's designated first self-hosted target)
};

function keyFor(provider: ModelEntry["provider"]): string | undefined {
  return provider === "deepseek" ? Bun.env.DEEPSEEK_API_KEY : Bun.env.GEMINI_API_KEY;
}

/** The Provider for a model, with its API key present. Throws a clear, actionable error otherwise. */
export function providerFor(entry: ModelEntry): Provider {
  const provider = PROVIDERS[entry.provider];
  if (!provider) throw new Error(`provider '${entry.provider}' isn't implemented yet — it's nerve's job to build it`);
  if (!keyFor(entry.provider)) throw new Error(`${entry.provider.toUpperCase()}_API_KEY is not set in .env`);
  return provider;
}

/** A usable Provider for `entry`, or null if its provider is unimplemented or its key is missing. */
function tryProvider(entry: ModelEntry): Provider | null {
  const provider = PROVIDERS[entry.provider];
  return provider && keyFor(entry.provider) ? provider : null;
}

/** The model-ladder fallbacks for `active` (D15): catalog entries *after* it that are usable now —
 *  i.e. their provider is implemented and keyed. So a rate-limited flash falls through to pro, etc. */
export function fallbacksFor(models: ModelEntry[], active: ModelEntry): Candidate[] {
  const start = models.findIndex((m) => m.id === active.id);
  const out: Candidate[] = [];
  for (const m of models.slice(start + 1)) {
    const provider = tryProvider(m);
    if (provider) out.push({ provider, model: m.id, effort: entryEffort(m), temperature: m.temperature });
  }
  return out;
}

/** A model's default thinking effort (D52) — its `effort`, the legacy `thinking` boolean, else "off". */
export function entryEffort(entry: ModelEntry): Effort {
  return modelEffort(entry.provider, entry.effort ?? entry.thinking);
}

/** The efforts selectable for `entry` (D52) — its `efforts` override (filtered to valid provider levels),
 *  else the provider's full set. Drives the /model + /effort pickers. */
export function modelEfforts(entry: ModelEntry): Effort[] {
  const all = PROVIDER_EFFORTS[entry.provider];
  return entry.efforts?.length ? entry.efforts.filter((e) => all.includes(e)) : all;
}
