// Inherit ghostty's `theme = light:Adwaita,dark:Adwaita Dark` (D30). We match the GNOME system light/dark
// scheme — the *same* signal ghostty resolves that line against — via `gsettings`, then apply the matching
// Adwaita palette. The accent colours are ghostty's own `/usr/share/ghostty/themes/Adwaita[ Dark]` values;
// the chrome roles nerve needs but a terminal palette doesn't define (border/panel/selection/dim) are
// derived for legibility on each ground. Detection is at **startup** (a relaunch re-detects — no live
// follow); falls back to dark off-GNOME. `$NERVE_THEME=light|dark` forces one.

import { SyntaxStyle, RGBA } from "@opentui/core";

export interface Theme {
  FG: string;
  MUTE: string;
  DIM: string;
  BORDER: string;
  ACCENT: string;
  GREEN: string;
  YELLOW: string;
  RED: string;
  MAGENTA: string;
  CYAN: string;
  ORANGE: string;
  SELBG: string;
  PANEL: string;
  DARKFG: string;
  /** Strongest/high-emphasis text (literally white on dark, near-black on light — not always "white"). */
  WHITE: string;
}

// Ghostty "Adwaita Dark" (bg #1d1d20, fg #fff) — bright ANSI variants for accents (legible on the dark
// ground); border/panel/selection derived a touch above the background.
const ADWAITA_DARK: Theme = {
  DARKFG: "#1d1d20",
  PANEL: "#28282c",
  BORDER: "#3a383f",
  SELBG: "#2a3340",
  FG: "#ffffff",
  WHITE: "#ffffff",
  MUTE: "#c0bfbc",
  DIM: "#787680",
  ACCENT: "#51a1ff",
  GREEN: "#57e389",
  YELLOW: "#f8e45c",
  RED: "#ed333b",
  MAGENTA: "#c061cb",
  CYAN: "#4fd2fd",
  ORANGE: "#ffa348",
};

// Ghostty "Adwaita" (light, bg #fff, fg #000) — accents darkened to the libadwaita ramp so coloured text
// (and the inverted EDIT/PLAN badges, whose text is the background colour) stays readable on white.
const ADWAITA_LIGHT: Theme = {
  DARKFG: "#ffffff",
  PANEL: "#f0eff1",
  BORDER: "#d4d2d8",
  SELBG: "#d8e6f8",
  FG: "#241f31",
  WHITE: "#000000",
  MUTE: "#5e5c64",
  DIM: "#9a9a9e",
  ACCENT: "#1c71d8",
  GREEN: "#1a8f4e",
  YELLOW: "#9a6700",
  RED: "#c01c28",
  MAGENTA: "#9841bb",
  CYAN: "#107a8f",
  ORANGE: "#c4620a",
};

/** True if the GNOME color-scheme prefers dark (matching how ghostty picks the dark variant). */
function prefersDark(): boolean {
  try {
    const r = Bun.spawnSync(["gsettings", "get", "org.gnome.desktop.interface", "color-scheme"]);
    const out = r.stdout.toString();
    if (out.includes("prefer-dark")) return true;
    if (out.includes("prefer-light") || out.includes("default")) return false;
  } catch {
    /* gsettings absent (not GNOME) — fall through to the dark default */
  }
  return true; // a dark terminal is the safer default
}

/** The palette to theme the TUI with: `$NERVE_THEME` override, else the GNOME light/dark scheme. */
export function pickTheme(): Theme {
  const forced = Bun.env.NERVE_THEME;
  if (forced === "light") return ADWAITA_LIGHT;
  if (forced === "dark") return ADWAITA_DARK;
  return prefersDark() ? ADWAITA_DARK : ADWAITA_LIGHT;
}

/** Map a palette to the markdown/code `SyntaxStyle`. Rebuilt on a live light/dark change (D30) so the
 *  transcript's existing renderables re-colour when their `.syntaxStyle` is re-set. */
export function buildSyntaxStyle(theme: Theme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(theme.FG) },
    "markup.heading": { fg: RGBA.fromHex(theme.ACCENT), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex(theme.ACCENT), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(theme.CYAN), bold: true },
    "markup.bold": { fg: RGBA.fromHex(theme.YELLOW), bold: true },
    "markup.italic": { italic: true },
    "markup.list": { fg: RGBA.fromHex(theme.MAGENTA) },
    "markup.raw": { fg: RGBA.fromHex(theme.GREEN) },
    "markup.link": { fg: RGBA.fromHex(theme.CYAN), underline: true },
    "markup.quote": { fg: RGBA.fromHex(theme.DIM), italic: true },
    keyword: { fg: RGBA.fromHex(theme.MAGENTA) },
    string: { fg: RGBA.fromHex(theme.GREEN) },
    comment: { fg: RGBA.fromHex(theme.DIM), italic: true },
    function: { fg: RGBA.fromHex(theme.ACCENT) },
    number: { fg: RGBA.fromHex(theme.ORANGE) },
    boolean: { fg: RGBA.fromHex(theme.ORANGE) },
    type: { fg: RGBA.fromHex(theme.CYAN) },
    property: { fg: RGBA.fromHex(theme.CYAN) },
    operator: { fg: RGBA.fromHex(theme.CYAN) },
    punctuation: { fg: RGBA.fromHex(theme.MUTE) },
  });
}
