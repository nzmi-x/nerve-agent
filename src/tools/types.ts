// The tool contract. Each tool is a plain object; `run` is a direct Bun call (no daemon, no RPC).
// JSON Schema in `parameters` is passed unchanged to both providers. See docs/manual/tools.md.

export interface ToolContext {
  /** Working directory; relative tool paths resolve against it. */
  cwd: string;
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
