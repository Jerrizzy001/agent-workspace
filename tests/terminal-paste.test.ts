import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sanitizePasteText, shellEscapePath } from "../src/shared/terminal-paste.js";

const nasty = [
  "/Users/me/Library/Application Support/Agent Workspace/attachments/s/screenshot-1.png",
  "/tmp/it's \"quoted\" $(touch pwned) `x` ;|&<>*?[]{}!#~^\\.png",
  "/tmp/ünïcödé 画像/スクリーン.png",
  "/tmp/-rf",
];

test("paths are escaped into one shell word that the shell reads back exactly", () => {
  for (const original of nasty) {
    const escaped = shellEscapePath(original);
    assert.equal(/[\x00-\x1f\x7f]/.test(escaped), false);
    for (const shell of ["/bin/sh", "bash"]) {
      let echoed: string;
      try {
        echoed = execFileSync(shell, ["-c", `printf '%s' ${escaped}`], { encoding: "utf8" });
      } catch (error: any) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      assert.equal(echoed, original, shell);
    }
  }
  assert.equal(shellEscapePath("/a b/c"), "/a\\ b/c");
  assert.equal(shellEscapePath("/x/画像.png"), "/x/画像.png");
});

test("paths with control or invisible characters are refused, not altered", () => {
  for (const bad of ["/tmp/a\nb", "/tmp/a\rb", "/tmp/\u001b[31m", "/tmp/a‮b", "/tmp/a b", "/tmp/\u0000"])
    assert.throws(() => shellEscapePath(bad), /cannot be pasted safely/);
  assert.throws(() => shellEscapePath("relative.png"), /absolute/);
  assert.throws(() => shellEscapePath(5 as any), /absolute/);
});

test("text paste is stripped of control bytes and is single-line unless asked", () => {
  assert.equal(sanitizePasteText("ls\r\nrm -rf /\u001b[2J\u0007"), "ls rm -rf /[2J");
  assert.equal(sanitizePasteText("a\tb​c d"), "a bc d");
  assert.equal(sanitizePasteText("one\r\ntwo\rthree", { multiline: true }), "one\ntwo\nthree");
  assert.equal(sanitizePasteText("x\u009by", { multiline: true }), "xy");
});
