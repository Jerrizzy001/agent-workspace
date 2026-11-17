import { test } from "node:test";
import assert from "node:assert/strict";
import { paletteMatches } from "../src/renderer/palette-search.js";

const items = [
  { label: "Settings and connections", keywords: "preferences" },
  { label: "Connect SSH computer", keywords: "ssh hosts remote machine" },
  { label: "Show terminals" },
  { label: "Connect phone · remote access", keywords: "pair qr mobile" },
  { label: "demo-project", hint: "Folder" },
];
const labels = (q: string) => paletteMatches(items, q).map((i) => i.label);

test("palette matches words in any order, across label, hint and keywords", () => {
  assert.deepEqual(labels("ssh host"), ["Connect SSH computer"]);
  assert.deepEqual(labels("hosts ssh"), ["Connect SSH computer"]);
  assert.deepEqual(labels("term"), ["Show terminals"]);
  assert.deepEqual(labels("folder demo"), ["demo-project"]);
  assert.equal(labels("remote")[0], "Connect phone · remote access");
  assert.deepEqual(labels("qr"), ["Connect phone · remote access"]);
  assert.deepEqual(labels("nothing here"), []);
  assert.equal(labels("").length, items.length);
  assert.deepEqual(labels("  SETTINGS  "), ["Settings and connections"]);
});
