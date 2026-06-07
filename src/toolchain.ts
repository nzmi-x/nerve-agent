// Install hints for missing external tools, chaining the package manager itself when it's also absent
// (a `uv tool install pyrefly` hint is useless without uv; `bun install -g …` without bun). Shared by
// the LSP servers (D10) and the language-pack hooks (D24).

/** How to install the package managers our install hints rely on. */
export const TOOLCHAIN: Record<string, string> = {
  uv: "curl -LsSf https://astral.sh/uv/install.sh | sh",
  bun: "curl -fsSL https://bun.sh/install | bash",
};

/**
 * Render an install instruction, prepending the package-manager install if it too is missing
 * (e.g. "install bun first (…), then `bun install -g @vtsls/language-server`"). `has` is injectable for tests.
 */
export function installHint(install: string, has: (cmd: string) => boolean = (c) => !!Bun.which(c)): string {
  const tool = install.split(/\s+/)[0] ?? "";
  if (TOOLCHAIN[tool] && !has(tool)) return `install ${tool} first (\`${TOOLCHAIN[tool]}\`), then \`${install}\``;
  return `\`${install}\``;
}
