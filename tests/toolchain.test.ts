import { test, expect } from "bun:test";
import { installHint } from "../src/toolchain.ts";

test("installHint: chains the package-manager install when it's also missing", () => {
  // uv present → just the install
  expect(installHint("uv tool install pyrefly", () => true)).toBe("`uv tool install pyrefly`");
  // uv missing too → install uv first
  const noUv = installHint("uv tool install pyrefly", (c) => c !== "uv");
  expect(noUv).toContain("install uv first");
  expect(noUv).toContain("astral.sh/uv/install.sh");
  expect(noUv).toContain("uv tool install pyrefly");
  // bun chains the same way (vtsls / prettier)
  const noBun = installHint("bun install -g @vtsls/language-server", (c) => c !== "bun");
  expect(noBun).toContain("install bun first");
  expect(noBun).toContain("bun.sh/install");
  // an unknown package manager is left as-is
  expect(installHint("go install golang.org/x/tools/gopls@latest", () => false)).toBe("`go install golang.org/x/tools/gopls@latest`");
});
