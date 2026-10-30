import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "../src/core/migrations.js";
import { WebSocket } from "ws";
import { createCore } from "../src/core/index.js";
import { startGateway } from "../src/server/gateway.js";
import { validateCommand } from "../src/server/validation.js";
import { COMMAND_POLICY } from "../src/shared/command-policy.js";
import {
  DEFAULT_LANES,
  laneNameText,
  laneOf,
  lanesFor,
} from "../src/shared/board.js";
import type { CoreEvent } from "../src/shared/contracts.js";

const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";
const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const socketFor = (dataDir: string) =>
  path.join(
    os.tmpdir(),
    "aw-" +
      crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 20) +
      ".sock",
  );
/** Only the tmux server this test's own core created. */
function killServer(dataDir: string) {
  try {
    execFileSync(tmux, ["-S", socketFor(dataDir), "kill-server"], {
      stdio: "ignore",
    });
  } catch {}
}
const panePid = (dataDir: string, backendName: string) =>
  execFileSync(
    tmux,
    ["-S", socketFor(dataDir), "display-message", "-p", "-t", "=" + backendName + ":0.0", "#{pane_pid}"],
    { encoding: "utf8" },
  ).trim();
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await wait();
  }
  throw new Error("Timed out: " + label);
}

test("default lanes, fallback lanes and lane names", () => {
  assert.deepEqual(
    DEFAULT_LANES.map((l) => l.name),
    ["Up next", "Working", "Review", "Done"],
  );
  const lanes = lanesFor([], "p").lanes;
  assert.equal(lanesFor([], "p").revision, 0);
  assert.equal(laneOf({ status: "running" }, lanes), "working");
  assert.equal(laneOf({ status: "exited" }, lanes), "done");
  assert.equal(laneOf({ status: "running", lane: "review" }, lanes), "review");
  assert.equal(laneOf({ status: "running", lane: "gone" }, lanes), "working");
  const custom = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  assert.equal(laneOf({ status: "running" }, custom), "a");
  assert.equal(laneOf({ status: "exited" }, custom), "b");
  assert.equal(laneNameText("  QA\n‮ready "), "QA ready");
  assert.throws(() => laneNameText("   "), /needs a name/);
  assert.throws(() => laneNameText("x".repeat(41)), /40 characters/);
  assert.throws(() => laneNameText(5), /Invalid lane name/);
});

test("placement is revision-checked metadata; lanes follow their rules; the process is untouched", async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workspace-board-")));
  const dataDir = path.join(temp, "data");
  process.env.SHELL = "/bin/sh";
  const events: CoreEvent[] = [];
  let core = await createCore({ dataDir, emit: (e) => events.push(e) });
  try {
    const project: any = await core.invoke("project.add", { path: temp });
    const open = async (key: string) =>
      ((await core.invoke("terminal.open", {
        projectId: project.id,
        provider: "shell",
        idempotencyKey: key,
      })) as any).session;
    const one = await open("board-1");
    const two = await open("board-2");
    await core.invoke("session.attach", {
      sessionId: one.id,
      generation: 1,
      viewerId: "board-viewer",
    });
    const pid = panePid(dataDir, one.backendName);
    assert.match(pid, /^[0-9]+$/);
    // The interactive shell's own PID, as it reports it before and after placement.
    const shellPid = async (file: string) => {
      await core.invoke("session.input", {
        sessionId: one.id,
        generation: 1,
        viewerId: "board-viewer",
        data: `printf 'PID=%s\\n' "$$" > ${file}\r`,
      });
      const target = path.join(temp, file);
      await until(
        () => fs.existsSync(target) && fs.readFileSync(target, "utf8").endsWith("\n"),
        "shell wrote " + file,
      );
      return fs.readFileSync(target, "utf8");
    };
    const before = await shellPid("before-place.txt");
    assert.match(before, /^PID=[0-9]+\n$/);
    const place = (payload: Record<string, unknown>) =>
      core.invoke("session.place", { sessionId: one.id, generation: 1, ...payload }) as Promise<any>;

    const terminalEvents = events.length;
    const placed = await place({ lane: "review", placementRevision: 0 });
    assert.equal(placed.lane, "review");
    assert.equal(placed.laneOrder, 1);
    assert.equal(placed.placementRevision, 1);
    assert.equal(placed.generation, 1);
    assert.equal(placed.status, "running");
    // Only a snapshot is emitted; nothing reaches the terminal.
    assert.ok(events.slice(terminalEvents).every((e) => e.type === "snapshot"));
    await assert.rejects(place({ lane: "done", placementRevision: 0 }), /Stale session placement/);
    await assert.rejects(place({ lane: "done" }), /Stale session placement/);
    await assert.rejects(place({ lane: "done", placementRevision: 1, generation: 2 }), /Stale session generation/);
    await assert.rejects(
      core.invoke("session.place", { sessionId: one.id, lane: "done", placementRevision: 1 }),
      /generation required/,
    );
    await assert.rejects(place({ lane: "nowhere", placementRevision: 1 }), /Unknown lane/);
    await assert.rejects(place({ lane: "done", placementRevision: 1, order: Number.NaN }), /Invalid lane order/);
    await assert.rejects(place({ lane: "done", placementRevision: 1, order: "1" }), /Invalid lane order/);
    const second: any = await core.invoke("session.place", {
      sessionId: two.id,
      generation: 1,
      lane: "review",
      order: 0.5,
      placementRevision: 0,
    });
    assert.equal(second.laneOrder, 0.5);
    const appended: any = await place({ lane: "review", placementRevision: 1 });
    assert.equal(appended.laneOrder, 1.5, "omitted order appends after the lane's last card");

    // Same process, same generation, still attached and still accepting input.
    assert.equal(panePid(dataDir, one.backendName), pid);
    assert.equal(await shellPid("after-place.txt"), before);

    // Lanes: rename, add up to six, remove only when empty.
    const lane = (command: string, payload: Record<string, unknown>) =>
      core.invoke(command as any, { projectId: project.id, ...payload }) as Promise<any>;
    const renamed = await lane("lane.rename", { laneId: "review", name: " QA\tcheck ", revision: 0 });
    assert.equal(renamed.revision, 1);
    assert.equal(renamed.lanes.find((l: any) => l.id === "review").name, "QA check");
    await assert.rejects(lane("lane.rename", { laneId: "review", name: "Old", revision: 0 }), /Stale board lanes/);
    await assert.rejects(lane("lane.rename", { laneId: "review", name: " ", revision: 1 }), /needs a name/);
    await assert.rejects(lane("lane.rename", { laneId: "missing", name: "X", revision: 1 }), /Unknown lane/);
    const five = await lane("lane.add", { name: "Blocked", revision: 1 });
    const six = await lane("lane.add", { name: "Later", revision: 2 });
    assert.equal(six.lanes.length, 6);
    await assert.rejects(lane("lane.add", { name: "Seventh", revision: 3 }), /at most 6 lanes/);
    await assert.rejects(lane("lane.remove", { laneId: "review", revision: 3 }), /Move this lane's cards/);
    const blocked = five.lanes.find((l: any) => l.name === "Blocked").id;
    const removed = await lane("lane.remove", { laneId: blocked, revision: 3 });
    assert.equal(removed.lanes.length, 5);
    await assert.rejects(
      core.invoke("session.place", { sessionId: two.id, generation: 1, lane: blocked, placementRevision: 1 }),
      /Unknown lane/,
    );
    // An unplaced open session shows in Working, so Working is not empty.
    const three = await open("board-3");
    await assert.rejects(lane("lane.remove", { laneId: "working", revision: 4 }), /Move this lane's cards/);
    // Ended sessions can be placed too.
    await core.invoke("session.attach", { sessionId: three.id, generation: 1, viewerId: "end" });
    await core.invoke("session.terminate", { sessionId: three.id, generation: 1, viewerId: "end" });
    const endedPlaced: any = await core.invoke("session.place", {
      sessionId: three.id,
      generation: 1,
      lane: "next",
      placementRevision: 0,
    });
    assert.equal(endedPlaced.status, "exited");
    assert.equal(endedPlaced.lane, "next");
    const working = await lane("lane.remove", { laneId: "working", revision: 4 });
    assert.deepEqual(
      working.lanes.map((l: any) => l.id).filter((id: string) => !id.startsWith("lane-")),
      ["next", "review", "done"],
    );

    // Everything persists across a core restart; the shell is the same process.
    await core.close();
    core = await createCore({ dataDir, emit: () => {} });
    const reopened: any = await core.invoke("snapshot");
    const byId = new Map(reopened.sessions.map((s: any) => [s.id, s]));
    assert.equal((byId.get(one.id) as any).lane, "review");
    assert.equal((byId.get(one.id) as any).placementRevision, 2);
    assert.equal((byId.get(one.id) as any).status, "running");
    assert.equal((byId.get(three.id) as any).lane, "next");
    assert.equal(reopened.boardLanes.length, 1);
    assert.equal(reopened.boardLanes[0].revision, 5);
    assert.equal(panePid(dataDir, one.backendName), pid);
  } finally {
    await core.close();
    killServer(dataDir);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a v3 store upgrades to board_lanes with its records unchanged", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-board-migrate-"));
  const file = path.join(temp, "workspace.sqlite");
  try {
    const db = new DatabaseSync(file);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE receipts (key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT); CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,time TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE launch_intents (key TEXT PRIMARY KEY,sessionId TEXT NOT NULL,attemptId TEXT NOT NULL); CREATE TABLE launch_requests (key TEXT PRIMARY KEY,request TEXT NOT NULL); PRAGMA user_version=3;",
    );
    const project = { id: "p1", name: "repo", path: temp, createdAt: "2026-01-01T00:00:00.000Z" };
    const session = {
      id: "s1",
      attemptId: null,
      projectId: "p1",
      provider: "claude",
      cwd: temp,
      backendName: "aw-s1",
      backendSocket: path.join(temp, "missing.sock"),
      generation: 3,
      status: "exited",
      createdAt: "2026-01-01T00:00:00.000Z",
      conversationId: "c1",
      title: "Named before the board",
      titleRevision: 2,
    };
    const setting = { id: "keepAwake", value: true, updatedAt: "2026-01-01T00:00:00.000Z" };
    db.prepare("INSERT INTO records VALUES (?,?,?)").run("projects", "p1", JSON.stringify(project));
    db.prepare("INSERT INTO records VALUES (?,?,?)").run("sessions", "s1", JSON.stringify(session));
    db.prepare("INSERT INTO records VALUES (?,?,?)").run("ownerSettings", "keepAwake", JSON.stringify(setting));
    db.close();
    const core = await createCore({ dataDir: temp, emit: () => {} });
    try {
      const snapshot: any = await core.invoke("snapshot");
      assert.deepEqual(snapshot.sessions, [session]);
      assert.deepEqual(snapshot.projects, [project]);
      assert.deepEqual(snapshot.boardLanes, []);
      assert.deepEqual(await core.invoke("settings.read", { key: "keepAwake" }), { key: "keepAwake", value: true });
    } finally {
      await core.close();
    }
    const upgraded = new DatabaseSync(file);
    assert.equal((upgraded.prepare("PRAGMA user_version").get() as any).user_version, SCHEMA_VERSION);
    upgraded.close();
    const backups = fs.readdirSync(path.join(temp, "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0]!, /^workspace-v3-[\dTZ-]+\.sqlite$/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("remote validation: placement and lane commands take exactly their fields", () => {
  for (const command of ["session.place", "lane.rename", "lane.add", "lane.remove"] as const)
    assert.equal(COMMAND_POLICY[command], "remote");
  const ok = { sessionId: "s", generation: 1, lane: "review", placementRevision: 0 };
  assert.deepEqual(validateCommand("session.place", ok).payload, ok);
  assert.deepEqual(validateCommand("session.place", { ...ok, order: -2.5 }).payload, { ...ok, order: -2.5 });
  assert.throws(() => validateCommand("session.place", { ...ok, viewerId: "v" }), /Unexpected command field/);
  assert.throws(() => validateCommand("session.place", { ...ok, data: "x" }), /Unexpected command field/);
  assert.throws(() => validateCommand("session.place", { ...ok, generation: undefined }), /generation required/);
  assert.throws(() => validateCommand("session.place", { ...ok, placementRevision: undefined }), /Missing placementRevision/);
  assert.throws(() => validateCommand("session.place", { ...ok, placementRevision: 1.5 }), /Invalid placementRevision/);
  assert.throws(() => validateCommand("session.place", { ...ok, order: "1" }), /Invalid order/);
  assert.throws(() => validateCommand("session.place", { ...ok, order: Infinity }), /Invalid order/);
  assert.throws(() => validateCommand("session.place", { ...ok, lane: 3 }), /Invalid lane/);
  const rename = { projectId: "p", laneId: "review", name: "QA", revision: 0 };
  assert.deepEqual(validateCommand("lane.rename", rename).payload, rename);
  assert.throws(() => validateCommand("lane.rename", { ...rename, lanes: [] }), /Unexpected command field/);
  assert.throws(() => validateCommand("lane.add", { projectId: "p", name: "X" }), /Missing revision/);
  assert.throws(() => validateCommand("lane.remove", { projectId: "p", revision: 0 }), /Missing laneId/);
});

test("remote owners place cards and change lanes only in shared folders; owner-only commands stay owner-only", async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workspace-board-remote-")));
  const dataDir = path.join(temp, "data");
  const shared = path.join(temp, "shared");
  const privateDir = path.join(temp, "private");
  fs.mkdirSync(shared);
  fs.mkdirSync(privateDir);
  process.env.SHELL = "/bin/sh";
  const listeners = new Set<(e: CoreEvent) => void>();
  const core = await createCore({ dataDir, emit: (e) => listeners.forEach((fn) => fn(e)) });
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let ws: WebSocket | undefined;
  try {
    const p1: any = await core.invoke("project.add", { path: shared });
    const p2: any = await core.invoke("project.add", { path: privateDir });
    const open = async (projectId: string, key: string) =>
      ((await core.invoke("terminal.open", { projectId, provider: "shell", idempotencyKey: key })) as any).session;
    const mine = await open(p1.id, "remote-1");
    const hidden = await open(p2.id, "remote-2");
    await core.invoke("lane.rename", { projectId: p2.id, laneId: "review", name: "Private name", revision: 0 });
    const pid = panePid(dataDir, mine.backendName);
    gateway = await startGateway({
      dataDir: path.join(temp, "gateway"),
      invoke: (c, p) => core.invoke(c, p),
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      port: 0,
      allowedProjectIds: [p1.id],
    });
    const url = gateway.status().url;
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ secret: await gateway.pairingSecret() }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    ws = new WebSocket(url.replace("http", "ws") + "/api/ws", { origin: url, headers: { cookie } });
    const messages: any[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await once(ws, "open");
    let sequence = 0;
    const rpc = async (command: string, payload: any = {}) => {
      const id = String(++sequence);
      ws!.send(JSON.stringify({ type: "rpc", version: 1, id, command, payload }));
      for (let i = 0; i < 400; i++) {
        const response = messages.find((m) => m.type === "result" && m.id === id);
        if (response) return response;
        await wait(5);
      }
      throw new Error("RPC timeout");
    };

    const placed = await rpc("session.place", {
      sessionId: mine.id,
      generation: 1,
      lane: "review",
      placementRevision: 0,
    });
    assert.equal(placed.error, undefined);
    assert.equal(placed.result.lane, "review");
    assert.equal(placed.result.placementRevision, 1);
    assert.equal(placed.result.laneOrder, 1);
    assert.equal(placed.result.backendSocket, undefined, "projection keeps host details out");
    assert.match(
      (await rpc("session.place", { sessionId: mine.id, generation: 1, lane: "done", placementRevision: 0 })).error,
      /Stale session placement/,
    );
    assert.equal(
      (await rpc("session.place", { sessionId: hidden.id, generation: 1, lane: "done", placementRevision: 0 })).error,
      "Project access denied",
    );
    const renamed = await rpc("lane.rename", { projectId: p1.id, laneId: "next", name: "Phone queue", revision: 0 });
    assert.equal(renamed.error, undefined);
    assert.equal(renamed.result.lanes[0].name, "Phone queue");
    assert.equal((await rpc("lane.add", { projectId: p1.id, name: "Later", revision: 1 })).result.lanes.length, 5);
    for (const [command, payload] of [
      ["lane.rename", { projectId: p2.id, laneId: "next", name: "X", revision: 1 }],
      ["lane.add", { projectId: p2.id, name: "X", revision: 1 }],
      ["lane.remove", { projectId: p2.id, laneId: "next", revision: 1 }],
    ] as const)
      assert.equal((await rpc(command, payload)).error, "Project access denied", command);
    for (const [command, payload] of [
      ["project.add", { path: privateDir }],
      ["project.hide", { projectId: p1.id }],
      ["settings.write", { key: "keepAwake", value: true }],
    ] as const)
      assert.equal((await rpc(command, payload)).error, "Command is not available remotely", command);
    const snap = (await rpc("snapshot")).result;
    assert.deepEqual(snap.boardLanes.map((b: any) => b.projectId), [p1.id]);
    assert.ok(!JSON.stringify(snap).includes("Private name"));
    const remoteMine = snap.sessions.find((s: any) => s.id === mine.id);
    assert.equal(remoteMine.lane, "review");
    assert.equal(remoteMine.placementRevision, 1);
    assert.equal(snap.sessions.some((s: any) => s.id === hidden.id), false);
    const local: any = await core.invoke("snapshot");
    assert.equal(local.sessions.find((s: any) => s.id === hidden.id).lane, undefined);
    assert.equal(local.boardLanes.find((b: any) => b.projectId === p2.id).lanes[2].name, "Private name");
    assert.equal(panePid(dataDir, mine.backendName), pid);
    assert.equal(local.sessions.find((s: any) => s.id === mine.id).status, "running");
  } finally {
    ws?.close();
    await gateway?.stop();
    await core.close();
    killServer(dataDir);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
