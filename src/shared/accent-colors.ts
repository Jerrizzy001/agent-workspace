// Derives the accent tokens from the macOS accent colour so every rendered
// pair passes WCAG contrast, whichever accent the user has chosen.

type RGB = [number, number, number];

const hex = (c: RGB) =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

export function parseHex(value: string): RGB | undefined {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGB) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function contrast(a: RGB, b: RGB) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (c: RGB, toward: RGB, t: number): RGB =>
  c.map((v, i) => v + (toward[i] - v) * t) as RGB;

const round = (c: RGB) => c.map(Math.round) as RGB;
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

// Moves `color` toward `toward` in 2% steps until it reaches `ratio` against
// `against`. Returns the closest step that passes.
function shift(color: RGB, toward: RGB, against: RGB, ratio: number): RGB {
  for (let t = 0; t <= 1; t += 0.02) {
    const next = mix(color, toward, t);
    if (contrast(round(next), against) >= ratio) return round(next);
  }
  return toward;
}

// Surfaces the accent must read against, kept in step with tokens.css.
export const LIGHT_TEXT_BG: RGB = [235, 235, 235];
export const DARK_TEXT_BG: RGB = [56, 56, 56];

export interface AccentTokens {
  /** The user's accent, for focus rings, toggles and selection. */
  accent: string;
  /** Fill for primary buttons and selected rows. */
  fill: string;
  /** Text and icons on `fill`. */
  onFill: string;
  /** Accent used as text (links, active labels) in the light theme. */
  inkLight: string;
  /** Accent used as text in the dark theme. */
  inkDark: string;
}

export function accentTokens(value: string): AccentTokens | undefined {
  const base = parseHex(value);
  if (!base) return undefined;
  // Keep white text where the hue allows it, as macOS does; very light
  // accents (yellow) keep their colour and switch to black text instead.
  const whiteFits = contrast(base, WHITE) >= 2.4;
  const fill = whiteFits ? shift(base, BLACK, WHITE, 4.5) : base;
  return {
    accent: hex(base),
    fill: hex(fill),
    onFill: whiteFits ? "#ffffff" : "#000000",
    inkLight: hex(shift(base, BLACK, LIGHT_TEXT_BG, 4.5)),
    inkDark: hex(shift(base, WHITE, DARK_TEXT_BG, 4.5)),
  };
}

export function accentCSS(tokens: AccentTokens) {
  return `:root{--system-accent:${tokens.accent};--system-accent-fill:${tokens.fill};--system-accent-on-fill:${tokens.onFill};--system-accent-ink-light:${tokens.inkLight};--system-accent-ink-dark:${tokens.inkDark};}`;
}
