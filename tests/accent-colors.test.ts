import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accentTokens,
  contrast,
  parseHex,
  LIGHT_TEXT_BG,
  DARK_TEXT_BG,
} from "../src/shared/accent-colors.js";

const rgb = (v: string) => parseHex(v)!;
// macOS accent colours as systemPreferences.getAccentColor() reports them.
const accents = {
  blue: "007affff",
  purple: "953d96ff",
  pink: "e0398fff",
  red: "e0383eff",
  orange: "f7821bff",
  yellow: "ffc600ff",
  green: "62ba46ff",
  graphite: "8c8c8cff",
};

test("every macOS accent yields passing fill and text pairs", () => {
  for (const [name, value] of Object.entries(accents)) {
    const t = accentTokens(value)!;
    assert.ok(t, name);
    assert.ok(contrast(rgb(t.fill), rgb(t.onFill)) >= 4.5, `${name} fill`);
    assert.ok(contrast(rgb(t.inkLight), LIGHT_TEXT_BG) >= 4.5, `${name} light ink`);
    assert.ok(contrast(rgb(t.inkDark), DARK_TEXT_BG) >= 4.5, `${name} dark ink`);
  }
});

test("blue keeps white text; yellow keeps its colour with black text", () => {
  assert.equal(accentTokens(accents.blue)!.onFill, "#ffffff");
  const yellow = accentTokens(accents.yellow)!;
  assert.equal(yellow.onFill, "#000000");
  assert.equal(yellow.fill, "#ffc600");
});

test("invalid values are ignored", () => {
  assert.equal(accentTokens(""), undefined);
  assert.equal(accentTokens("blue"), undefined);
});
