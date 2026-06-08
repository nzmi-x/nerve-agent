// Thinking / reasoning effort (D52). A unified ladder the two providers map to their own knobs: DeepSeek's
// `reasoning_effort` (high / xhigh, or thinking disabled) and Gemini's `thinkingLevel` (low / medium / high).
// "off" = no thinking. The PICKER offers each provider only the levels it actually accepts; the provider
// modules additionally treat `off` (or any level they don't take) gracefully — they omit the knob, falling
// back to the model default — so e.g. compaction can ask for "off" on a Gemini model and just get its default.

export type Effort = "off" | "low" | "medium" | "high" | "xhigh";

/** Selectable efforts per provider — their real API capability (only two providers, charter-locked). The
 *  `/model` + `/effort` pickers show exactly these. DeepSeek can disable thinking ("off"); Gemini 3 always
 *  thinks, so its floor is "low". */
export const PROVIDER_EFFORTS: Record<"deepseek" | "gemini", Effort[]> = {
  deepseek: ["off", "high", "xhigh"],
  gemini: ["low", "medium", "high"],
};

/** Normalize a model's configured effort — a string, a legacy `thinking` boolean, or unset — to a valid
 *  Effort. Unset/unknown → "off" (the D11 speed default: no thinking unless a model opts in). */
export function modelEffort(provider: "deepseek" | "gemini", raw: unknown): Effort {
  if (typeof raw === "boolean") return raw ? "high" : "off"; // legacy `thinking: true/false`
  if (typeof raw === "string" && PROVIDER_EFFORTS[provider].includes(raw as Effort)) return raw as Effort;
  return "off";
}

/** Short label for the picker / status line ("off" stays "off"; the rest are their own name). */
export function effortLabel(e: Effort): string {
  return e;
}
