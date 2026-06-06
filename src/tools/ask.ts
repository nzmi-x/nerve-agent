import type { AskOption, Tool } from "./types.ts";

export const askUser: Tool = {
  name: "ask_user",
  description:
    "Ask the user a question and get their answer. Offer 2–4 options and mark one `recommended: true` " +
    "UNLESS the options are genuinely equivalent (no clear upside/downside). Use only when you're " +
    "blocked on a decision that's the user's to make — not for things you can decide or look up.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user." },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        description: "The answer choices.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "A concise answer choice." },
            description: { type: "string", description: "Optional: what it means / its trade-off." },
            recommended: { type: "boolean", description: "Mark the recommended choice; omit if options are equivalent." },
          },
          required: ["label"],
        },
      },
    },
    required: ["question", "options"],
  },
  readonly: true, // asking mutates nothing — usable in PLAN
  async run(args, ctx) {
    if (typeof args.question !== "string") return "Error: 'question' must be a string";
    if (!Array.isArray(args.options) || args.options.length < 2) return "Error: provide 2–4 options";

    const options: AskOption[] = args.options.map((o) => {
      const opt = o as Record<string, unknown>;
      return {
        label: String(opt.label ?? ""),
        ...(typeof opt.description === "string" ? { description: opt.description } : {}),
        ...(opt.recommended === true ? { recommended: true } : {}),
      };
    });
    if (options.some((o) => !o.label)) return "Error: every option needs a 'label'";

    if (!ctx.ask) {
      const rec = options.find((o) => o.recommended) ?? options[0]!;
      return `(no interactive surface) proceeding with the recommended option: ${rec.label}`;
    }
    const answer = await ctx.ask({ question: args.question, options });
    return `User answered: ${answer}`;
  },
};
