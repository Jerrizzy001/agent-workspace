import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { isDirectEntry } from "../src/shared/entrypoint.js";

test("direct-entry detection resolves aliases without executing imported modules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-entry-"));
  try {
    const actual = path.join(dir, "entry.mjs");
    const alias = path.join(dir, "alias.mjs");
    const other = path.join(dir, "other.mjs");
    fs.writeFileSync(actual, "");
    fs.writeFileSync(other, "");
    fs.symlinkSync(actual, alias);
    const canonical = pathToFileURL(fs.realpathSync(actual)).href;
    assert.equal(isDirectEntry(canonical, actual), true);
    assert.equal(isDirectEntry(canonical, alias), true);
    assert.equal(isDirectEntry(canonical, other), false);
    assert.equal(isDirectEntry(canonical, path.join(dir, "missing")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the actual SSH entrypoint prints its version when executed through a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-helper-entry-"));
  try {
    const alias = path.join(dir, "helper.ts");
    fs.symlinkSync(path.resolve("src/server/stdio-host.ts"), alias);
    const result = spawnSync(
      process.execPath,
      [path.resolve("node_modules/tsx/dist/cli.mjs"), alias, "--version"],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stderr.includes(
        `agent-workspace-ssh-helper ${JSON.parse(fs.readFileSync("package.json", "utf8")).version} protocol 1-1`,
      ),
    );
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
