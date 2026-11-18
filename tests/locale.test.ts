import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureUtf8Locale } from "../src/core/process.js";

test("a missing locale defaults to UTF-8; a chosen one is kept", () => {
  const empty: NodeJS.ProcessEnv = {};
  ensureUtf8Locale(empty);
  assert.match(empty.LANG!, /UTF-8$/);
  const chosen: NodeJS.ProcessEnv = { LC_CTYPE: "fr_FR.UTF-8" };
  ensureUtf8Locale(chosen);
  assert.equal(chosen.LANG, undefined);
  const lang: NodeJS.ProcessEnv = { LANG: "de_DE.ISO8859-1" };
  ensureUtf8Locale(lang);
  assert.equal(lang.LANG, "de_DE.ISO8859-1");
});
