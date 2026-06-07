// The tool contract. Each tool is a plain object; `run` is a direct Bun call (no daemon, no RPC).
// JSON Schema in `parameters` is passed unchanged to both providers. See docs/manual/tools.md.

/** One answer choice the agent offers via the `ask_user` tool. */
export interface AskOption {
  label: string;
  description?: string;
  recommended?: boolean;
}
export interface AskRequest {
  question: string;
  options: AskOption[];
}

/** One item of the agent's task list (the `todo` tool, D25). */
export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolContext {
  /** Working directory; relative tool paths resolve against it. */
  cwd: string;
  /**
   * Ask the human a question and resolve with their answer (the chosen label, or free text).
   * Provided by the surface: the TUI renders an interactive picker; headless auto-picks the
   * recommended option. The `ask_user` tool falls back to the recommendation if this is absent.
   */
  ask?: (req: AskRequest) => Promise<string>;
  /** Language-server manager (D10) — `read`/`write`/`edit` append diagnostics, the `lsp` tool queries. */
  lsp?: import("../lsp/manager.ts").Lsp;
  /** Absolute paths the agent has *touched* this session (read/write/edit) — drives language packs (D24). */
  touched?: Set<string>;
  /** Absolute paths *edited* this turn (write/edit) — the post-edit hooks run on these. */
  edited?: Set<string>;
  /** Display the agent's task list (the `todo` tool, D25) — the TUI renders a panel, headless prints. */
  setTodos?: (todos: Todo[]) => void;
  /** The turn's abort signal (ESC) — so a long-running tool (e.g. `task`'s subagent, D6) cancels too. */
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the args object — fed to DeepSeek `function.parameters` / Gemini `functionDeclarations`. */
  parameters: Record<string, unknown>;
  /** PLAN-safe? The dispatcher only runs `readonly` tools (+ allowlisted bash) in PLAN mode (D4). */
  readonly: boolean;
  /** Returns the result text shown to the model. Recoverable failures return an `Error: …` string. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
