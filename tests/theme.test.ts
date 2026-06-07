import { test, expect, afterEach } from "bun:test";
import { pickTheme, type Theme } from "../src/tui/theme.ts";

const KEYS: (keyof Theme)[] = ["FG", "MUTE", "DIM", "BORDER", "ACCENT", "GREEN", "YELLOW", "RED", "MAGENTA", "CYAN", "ORANGE", "SELBG", "PANEL", "DARKFG", "WHITE"];
const HEX = /^#[0-9a-f]{6}$/i;

afterEach(() => {
  delete process.env.NERVE_THEME;
});

test("NERVE_THEME forces the palette (Adwaita light vs dark grounds)", () => {
  process.env.NERVE_THEME = "light";
  expect(pickTheme().DARKFG).toBe("#ffffff");
  process.env.NERVE_THEME = "dark";
  expect(pickTheme().DARKFG).toBe("#1d1d20");
});

test("both palettes define every role as a valid #rrggbb hex", () => {
  for (const forced of ["light", "dark"]) {
    process.env.NERVE_THEME = forced;
    const th = pickTheme();
    for (const k of KEYS) expect(th[k]).toMatch(HEX);
  }
});
