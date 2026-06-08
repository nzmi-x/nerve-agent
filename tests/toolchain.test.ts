import { test, expect } from "bun:test";
import { installHint, missingOptional, optionalHints } from "../src/toolchain.ts";

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

test("missingOptional / optionalHints: a browser satisfies fetch's SPA rendering; absent → a Fedora hint (D55)", () => {
  // any chrome-family binary present → nothing missing
  expect(missingOptional((c) => c === "google-chrome")).toEqual([]);
  expect(missingOptional((c) => c === "chromium")).toEqual([]);
  // none present → the browser dep is missing, with a `sudo dnf install` hint
  const none = missingOptional(() => false);
  expect(none).toHaveLength(1);
  expect(none[0]!.install).toBe("sudo dnf install chromium");
  expect(optionalHints(() => false)[0]).toContain("install: sudo dnf install chromium");
  expect(optionalHints((c) => c === "chromium")).toEqual([]);
});
