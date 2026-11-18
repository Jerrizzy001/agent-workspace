import { test } from "node:test";
import assert from "node:assert/strict";
import { contextPreview } from "../src/renderer/context-preview.js";

test("readable preview preserves command payloads and shows the actual redactions", () => {
  const source = "<command-name>/example</command-name>\n<command-message>run example</command-message>\n<command-args>PRIVATE_ARGUMENT</command-args>\n<local-command-stdout>private result</local-command-stdout>";
  const readable = contextPreview(source);
  assert.match(readable, /Arguments: PRIVATE_ARGUMENT/);
  assert.match(readable, /Command message: run example/);
  assert.match(readable, /private result/);
  const start = source.indexOf("PRIVATE_ARGUMENT");
  const masked = contextPreview(source, [[start, start + "PRIVATE_ARGUMENT".length]]);
  assert.doesNotMatch(masked, /PRIVATE_ARGUMENT/);
  assert.match(masked, /Arguments: \[redacted\]/);
  assert.match(masked, /private result/);
});
