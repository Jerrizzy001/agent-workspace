import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createCore } from "../src/core/index.js";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../src/core/migrations.js";

const version = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return (db.prepare("PRAGMA user_version").get() as any).user_version;
  } finally {
    db.close();
  }
};
/** A store exactly as the v2 build left it. */
function v2Store(file: string) {
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,time TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS launch_intents (key TEXT PRIMARY KEY,sessionId TEXT NOT NULL,attemptId TEXT NOT NULL); CREATE TABLE IF NOT EXISTS launch_requests (key TEXT PRIMARY KEY,request TEXT NOT NULL); PRAGMA user_version=2;",
  );
  return db;
}

test("migration registry is ordered, uniquely named and ends at roadmap_03_execution_hosts", () => {
  assert.deepEqual(
    MIGRATIONS.map((m) => [m.version, m.name]),
    [
      [1, "records_receipts_events"],
      [2, "folder_sessions"],
      [3, "roadmap_01_owner_utilities"],
      [4, "board_lanes"],
      [5, "roadmap_04_controller"],
      [6, "roadmap_03_execution_hosts"],
    ],
  );
  assert.equal(SCHEMA_VERSION, 6);
});

test("a fresh store is created at the current version without a backup", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-migrate-"));
  try {
    const core = await createCore({ dataDir: temp, emit: () => {} });
    await core.close();
    assert.equal(version(path.join(temp, "workspace.sqlite")), SCHEMA_VERSION);
    assert.equal(fs.existsSync(path.join(temp, "backups")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("an existing v2 store keeps its rows and is backed up before upgrading", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-migrate-"));
  const file = path.join(temp, "workspace.sqlite");
  try {
    const project = { id: "p1", name: "repo", path: temp, createdAt: "2026-01-01T00:00:00.000Z" };
    const session = {
      id: "s1",
      attemptId: null,
      projectId: "p1",
      provider: "shell",
      cwd: temp,
      backendName: "aw-s1",
      backendSocket: path.join(temp, "missing.sock"),
      generation: 7,
      status: "exited",
      createdAt: "2026-01-01T00:00:00.000Z",
      exitCode: 0,
    };
    const db = v2Store(file);
    db.prepare("INSERT INTO records VALUES (?,?,?)").run("projects", "p1", JSON.stringify(project));
    db.prepare("INSERT INTO records VALUES (?,?,?)").run("sessions", "s1", JSON.stringify(session));
    db.prepare("INSERT INTO receipts VALUES (?,?,?)").run("k1", "digest", JSON.stringify({ session }));
    db.prepare("INSERT INTO launch_intents VALUES (?,?,?)").run("k1", "s1", "");
    db.close();

    const core = await createCore({ dataDir: temp, emit: () => {} });
    const snapshot: any = await core.invoke("snapshot");
    assert.deepEqual(snapshot.sessions, [session]);
    assert.deepEqual(snapshot.projects, [project]);
    await core.close();

    assert.equal(version(file), SCHEMA_VERSION);
    const upgraded = new DatabaseSync(file);
    assert.deepEqual(
      { ...(upgraded.prepare("SELECT * FROM receipts").get() as any) },
      { key: "k1", digest: "digest", result: JSON.stringify({ session }) },
    );
    assert.deepEqual(
      { ...(upgraded.prepare("SELECT * FROM launch_intents").get() as any) },
      { key: "k1", sessionId: "s1", attemptId: "" },
    );
    upgraded.close();

    const backups = fs.readdirSync(path.join(temp, "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0]!, /^workspace-v2-[\dTZ-]+\.sqlite$/);
    const saved = path.join(temp, "backups", backups[0]!);
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(temp, "backups")).mode & 0o777, 0o700);
    // The backup is a complete, consistent v2 store.
    const copy = new DatabaseSync(saved);
    assert.equal((copy.prepare("PRAGMA user_version").get() as any).user_version, 2);
    assert.deepEqual(
      JSON.parse((copy.prepare("SELECT value FROM records WHERE kind='sessions'").get() as any).value),
      session,
    );
    copy.close();

    // Opening the current version again neither migrates nor backs up.
    const again = await createCore({ dataDir: temp, emit: () => {} });
    await again.close();
    assert.equal(fs.readdirSync(path.join(temp, "backups")).length, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a v1 store gains launch requests and only the newest three backups are kept", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-migrate-"));
  try {
    for (let round = 0; round < 5; round++) {
      const file = path.join(temp, `store-${round}.sqlite`);
      const db = new DatabaseSync(file);
      db.exec(
        "CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE receipts (key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT); CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,time TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE launch_intents (key TEXT PRIMARY KEY,sessionId TEXT NOT NULL,attemptId TEXT NOT NULL); PRAGMA user_version=1;",
      );
      db.prepare("INSERT INTO records VALUES ('projects','p','{}')").run();
      const result = await migrate(db, temp);
      assert.equal(result.from, 1);
      assert.equal(result.to, SCHEMA_VERSION);
      assert.ok(result.backup && fs.existsSync(result.backup));
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='launch_requests'").get());
      db.close();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const kept = fs.readdirSync(path.join(temp, "backups")).sort();
    assert.equal(kept.length, 3);
    assert.ok(kept.every((name) => name.startsWith("workspace-v1-")));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a newer store is rejected before anything is written", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-migrate-"));
  const file = path.join(temp, "workspace.sqlite");
  try {
    const db = v2Store(file);
    db.prepare("INSERT INTO records VALUES ('sessions','s','{\"id\":\"s\"}')").run();
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}; PRAGMA journal_mode=DELETE;`);
    db.close();
    const digest = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const before = digest();
    await assert.rejects(createCore({ dataDir: temp, emit: () => {} }), /newer app version/);
    assert.equal(digest(), before);
    assert.equal(version(file), SCHEMA_VERSION + 1);
    assert.equal(fs.existsSync(path.join(temp, "backups")), false);
    assert.equal(fs.existsSync(path.join(temp, "owner.lock")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("v6 adds SSH host records without touching a v5 store's records", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-migrate-"));
  const file = path.join(temp, "workspace.sqlite");
  try {
    const db = v2Store(file);
    const project = { id: "p1", name: "app", path: temp, createdAt: "2026-01-01T00:00:00.000Z" };
    db.prepare("INSERT INTO records VALUES (?,?,?)").run("projects", "p1", JSON.stringify(project));
    db.prepare("INSERT INTO records VALUES (?,?,?)").run("notes", "n1", JSON.stringify({ id: "n1", projectId: "p1", title: "t", body: "b", createdAt: "x", updatedAt: "x", revision: 3 }));
    db.exec("PRAGMA user_version=5;");
    db.close();
    let core = await createCore({ dataDir: temp, emit: () => {} });
    const snapshot: any = await core.invoke("snapshot");
    assert.deepEqual(snapshot.projects, [project]);
    assert.equal(snapshot.notes[0].revision, 3);
    assert.equal(snapshot.hosts, undefined, "the core itself reports no hosts; the desktop router adds them");
    const host = { id: "0a1b2c3d", alias: "box", label: "box", helperPath: "~/aw", createdAt: "x" };
    await core.hostRecords("putHost", host);
    await core.hostRecords("putProjectRefs", {
      hostId: "0a1b2c3d",
      refs: [{ id: "ssh-0a1b2c3d-r1", hostId: "0a1b2c3d", remoteProjectId: "r1", name: "remote", path: "/srv/remote", cachedAt: "x" }],
    });
    await assert.rejects(core.hostRecords("putHost", { id: "../x" }), /Invalid host ID/);
    await assert.rejects(core.hostRecords("drop", { id: "0a1b2c3d" }), /Unsupported/);
    await assert.rejects(core.invoke("hostRecords" as any, {}), /Unsupported command/);
    await core.close();
    assert.equal(version(file), 6);
    assert.ok(fs.readdirSync(path.join(temp, "backups")).some((n) => n.startsWith("workspace-v5-")));
    core = await createCore({ dataDir: temp, emit: () => {} });
    const stored: any = await core.hostRecords("list");
    assert.deepEqual(stored.hosts, [host]);
    assert.equal(stored.projectRefs.length, 1);
    // Remote folders are not local projects.
    assert.deepEqual(((await core.invoke("snapshot")) as any).projects, [project]);
    await core.hostRecords("removeHost", { id: "0a1b2c3d" });
    assert.deepEqual(await core.hostRecords("list"), { hosts: [], projectRefs: [] });
    await core.close();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
