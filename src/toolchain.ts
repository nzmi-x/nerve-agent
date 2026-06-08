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

/** An optional external tool: a nerve feature degrades without it. `names` are interchangeable binaries (any
 *  present satisfies it); `install` is the Fedora command (nerve targets Fedora Linux). */
export interface OptionalDep {
  names: string[];
  feature: string;
  install: string;
}

// Optional tools nerve uses for a feature but can run without. Required deps (shell, git) are fatal in
// `preflight`; these only degrade a feature, so they're surfaced as hints, never blocked on. LSP servers +
// language-pack formatters aren't here — they're hinted at use-time (D10/D24), per-language.
export const OPTIONAL_DEPS: OptionalDep[] = [
  {
    names: ["chromium", "google-chrome-stable", "google-chrome", "chromium-browser", "brave-browser", "microsoft-edge"],
    feature: "`fetch` SPA / JavaScript rendering (Bun.WebView headless browser, D54)",
    install: "sudo dnf install chromium",
  },
];

/** The optional deps not found on PATH. `has` is injectable for tests. */
export function missingOptional(has: (cmd: string) => boolean = (c) => !!Bun.which(c)): OptionalDep[] {
  return OPTIONAL_DEPS.filter((d) => !d.names.some((n) => has(n)));
}

/** One-line hints for each missing optional dep (`feature — install: cmd`), for the TUI welcome + headless stderr. */
export function optionalHints(has?: (cmd: string) => boolean): string[] {
  return missingOptional(has).map((d) => `${d.feature} unavailable — install: ${d.install}`);
}
