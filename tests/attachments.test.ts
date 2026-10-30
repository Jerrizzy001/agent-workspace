import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createCore } from "../src/core/index.js";
import {
  ATTACHMENT_GRACE_MS,
  MAX_ATTACHMENT_BYTES,
  writeAttachment,
} from "../src/core/attachments.js";

const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";
/** A real RGBA PNG of the given size. */
export function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0x7f)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function socketFor(dataDir: string) {
  return path.join(
    os.tmpdir(),
    "aw-" +
      crypto.createHash("sha256").update(fs.realpathSync(dataDir)).digest("hex").slice(0, 20) +
      ".sock",
  );
}
async function fixture() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workspace-attach-")));
  const dataDir = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  process.env.SHELL = "/bin/sh";
  const core = await createCore({ dataDir, emit: () => {} });
  const project: any = await core.invoke("project.add", { path: repo });
  const shell = async (key: string) =>
    ((await core.invoke("terminal.open", {
      projectId: project.id,
      provider: "shell",
      idempotencyKey: key,
    })) as any).session;
  const cleanup = () => {
    try {
      execFileSync(tmux, ["-S", socketFor(dataDir), "kill-server"], { stdio: "ignore" });
    } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  };
  return { temp, dataDir, core, project, shell, cleanup };
}

test("pasted images are private, exact, never overwritten and bound to a live session generation", async () => {
  const f = await fixture();
  let core = f.core;
  try {
    const s = await f.shell("a");
    assert.equal(s.status, "running");
    const image = png(3, 2);
    const first = await core.createAttachment({ sessionId: s.id, generation: 1, data: image });
    const second = await core.createAttachment({ sessionId: s.id, generation: 1, data: image });
    const folder = path.join(f.dataDir, "attachments", s.id);
    assert.equal(path.dirname(first.path), folder);
    assert.match(path.basename(first.path), /^screenshot-\d{8}T\d{6}-[0-9a-f]{12}\.png$/);
    assert.notEqual(first.path, second.path);
    assert.deepEqual(fs.readFileSync(first.path), image);
    assert.equal(first.bytes, image.length);
    assert.equal(first.sha256, crypto.createHash("sha256").update(image).digest("hex"));
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(folder)).mode & 0o777, 0o700);
    // Attachment records stay private to the core.
    const snapshot: any = await core.invoke("snapshot");
    assert.equal(JSON.stringify(snapshot).includes(first.path), false);

    await assert.rejects(
      core.createAttachment({ sessionId: s.id, generation: 2, data: image }),
      /Stale session generation/,
    );
    await assert.rejects(
      core.createAttachment({ sessionId: "missing", generation: 1, data: image }),
      /not found/,
    );
    await assert.rejects(
      core.createAttachment({ sessionId: s.id, generation: 1, data: Buffer.from("GIF89a not a png") }),
      /not a PNG/,
    );
    await assert.rejects(
      core.createAttachment({ sessionId: s.id, generation: 1, data: png(8193, 1) }),
      /dimensions/,
    );
    const oversize = Buffer.concat([image, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    await assert.rejects(
      core.createAttachment({ sessionId: s.id, generation: 1, data: oversize }),
      /20 MB/,
    );
    await assert.rejects(
      core.createAttachment({ sessionId: s.id, generation: 1, data: "text" as any }),
      /Invalid attachment data/,
    );
    assert.equal(fs.readdirSync(folder).length, 2);

    // A session folder replaced by a link elsewhere is refused, not followed.
    const elsewhere = path.join(f.temp, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(f.dataDir, "attachments", "linked"));
    assert.throws(() => writeAttachment(f.dataDir, "linked", image), /private directory/);
    assert.throws(() => writeAttachment(f.dataDir, "../x", image), /Invalid session id/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);

    // Once the process has ended, nothing more is saved for it.
    execFileSync(tmux, ["-S", socketFor(f.dataDir), "kill-session", "-t", "=" + s.backendName]);
    await assert.rejects(
      core.createAttachment({ sessionId: s.id, generation: 1, data: image }),
      /not running/,
    );
  } finally {
    await core.close();
    f.cleanup();
  }
});

test("images of sessions ended beyond the grace period are removed; recent and live ones stay", async () => {
  const f = await fixture();
  let core = f.core;
  try {
    const old = await f.shell("old");
    const recent = await f.shell("recent");
    const live = await f.shell("live");
    const image = png(1, 1);
    const oldFile = await core.createAttachment({ sessionId: old.id, generation: 1, data: image });
    const recentFile = await core.createAttachment({ sessionId: recent.id, generation: 1, data: image });
    const liveFile = await core.createAttachment({ sessionId: live.id, generation: 1, data: image });
    for (const s of [old, recent])
      execFileSync(tmux, ["-S", socketFor(f.dataDir), "kill-session", "-t", "=" + s.backendName]);
    await core.close();

    const db = new DatabaseSync(path.join(f.dataDir, "workspace.sqlite"));
    const row = db.prepare("SELECT value FROM records WHERE kind='attachments' AND id=?");
    const record = JSON.parse((row.get(oldFile.id) as any).value);
    record.sessionEndedAt = new Date(Date.now() - ATTACHMENT_GRACE_MS - 60_000).toISOString();
    db.prepare("UPDATE records SET value=? WHERE kind='attachments' AND id=?").run(
      JSON.stringify(record),
      oldFile.id,
    );
    db.close();

    // Startup reconciles the ended sessions, then applies retention.
    core = await createCore({ dataDir: f.dataDir, emit: () => {} });
    await core.close();
    assert.equal(fs.existsSync(oldFile.path), false);
    assert.equal(fs.existsSync(path.dirname(oldFile.path)), false);
    assert.equal(fs.existsSync(recentFile.path), true);
    assert.equal(fs.existsSync(liveFile.path), true);
    const check = new DatabaseSync(path.join(f.dataDir, "workspace.sqlite"));
    const records = (
      check.prepare("SELECT value FROM records WHERE kind='attachments'").all() as any[]
    ).map((r) => JSON.parse(r.value));
    check.close();
    assert.deepEqual(records.map((r) => r.id).sort(), [recentFile.id, liveFile.id].sort());
    assert.ok(records.find((r) => r.id === recentFile.id).sessionEndedAt);
    assert.equal(records.find((r) => r.id === liveFile.id).sessionEndedAt, undefined);
    core = await createCore({ dataDir: f.dataDir, emit: () => {} });
  } finally {
    await core.close();
    f.cleanup();
  }
});
