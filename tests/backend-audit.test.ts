import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createCore } from "../src/core/index.js";
import { migrate } from "../src/core/migrations.js";
import { indexedRecords } from "../src/core/records.js";
import { deltaPublisher, deltaReceiver } from "../src/shared/deltas.js";
import { run, runStream } from "../src/core/process.js";
import { launchArguments, codexActivityConfig } from "../src/core/providers.js";
import { terminalInputChunk } from "../src/shared/terminal-paste.js";
import type { CoreEvent, Snapshot } from "../src/shared/contracts.js";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aw-backend-"));

test("1,000 ended sessions never contact tmux; 200 exports list without text; deltas omit note bodies", async () => {
  const dir = temp();
  const oldTmux = process.env.WORKSPACE_TMUX;
  const called = path.join(dir, "tmux-called");
  const fakeTmux = path.join(dir, "tmux");
  fs.writeFileSync(fakeTmux, `#!/bin/sh\ntouch '${called}'\nexit 1\n`, {
    mode: 0o700,
  });
  process.env.WORKSPACE_TMUX = fakeTmux;
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  await migrate(db, dir);
  const put = db.prepare("INSERT INTO records VALUES (?,?,?)");
  const date = new Date().toISOString();
  put.run(
    "projects",
    "p",
    JSON.stringify({ id: "p", path: dir, name: "scale", createdAt: date }),
  );
  for (let i = 0; i < 1000; i++)
    put.run(
      "sessions",
      "s" + i,
      JSON.stringify({
        id: "s" + i,
        projectId: "p",
        provider: "shell",
        attemptId: null,
        cwd: dir,
        backendName: "aw-s" + i,
        ...(i % 2 ? { backendSocket: path.join(dir, "missing.sock") } : {}),
        generation: 1,
        status: "exited",
        createdAt: date,
      }),
    );
  for (let i = 0; i < 200; i++) {
    put.run(
      "transcriptExports",
      "e" + i,
      JSON.stringify({
        id: "e" + i,
        text: "x".repeat(192 * 1024),
        info: {},
        createdAt: date,
      }),
    );
    put.run(
      "transcriptLinks",
      "l" + i,
      JSON.stringify({
        id: "l" + i,
        exportId: "e" + i,
        source: { sessionId: "s0" },
        recipient: { sessionId: "s1" },
        createdAt: date,
      }),
    );
  }
  db.close();
  const published: CoreEvent[] = [];
  const publish = deltaPublisher("scale");
  const core = await createCore({
    dataDir: dir,
    emit: (e) => {
      if (e.type === "snapshot") published.push(publish(e.snapshot));
    },
  });
  try {
    const call = (command: any, payload = {}) =>
      core.invoke(command, payload) as Promise<any>;
    assert.equal(fs.existsSync(called), false);
    assert.equal((await call("snapshot")).sessions.length, 1000);
    const links = await call("transcript.list");
    assert.equal(links.length, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(links)) < 150_000);
    assert.equal(links[0].export.text, undefined);
    const note = await call("note.create", {
      projectId: "p",
      title: "large",
      body: "n".repeat(2 * 1024 * 1024),
    });
    const snapshot = await call("snapshot");
    assert.equal(snapshot.notes[0].body, "");
    assert.equal(snapshot.notes[0].bodyLoaded, false);
    assert.equal(
      (await call("note.read", { noteId: note.id })).body.length,
      2 * 1024 * 1024,
    );
    await call("note.update", {
      noteId: note.id,
      revision: 1,
      title: "renamed",
    });
    const delta = published.at(-1)!;
    assert.equal(delta.type, "workspace.delta");
    assert.ok(Buffer.byteLength(JSON.stringify(delta)) < 1024);
    await assert.rejects(
      call("note.update", { noteId: note.id, body: "lost" }),
      /revision/,
    );
    await assert.rejects(
      call("note.update", { noteId: note.id, revision: 1, body: "lost" }),
      /revision/,
    );
    assert.equal(
      (await call("note.read", { noteId: note.id })).body,
      note.body,
    );
    const removed = await call("history.prune", {
      before: new Date().toISOString(),
    });
    assert.equal(removed.archived, 1000);
    assert.equal((await call("snapshot")).sessions.length, 0);
    assert.equal(
      (await call("history.list", { offset: 950 })).sessions.length,
      50,
    );
    await call("history.restore", { sessionId: "s0" });
    assert.equal((await call("snapshot")).sessions.length, 1);
    await assert.rejects(
      call("note.delete", { noteId: note.id, revision: 2 }),
      /Archive/,
    );
    await call("note.archive", {
      noteId: note.id,
      revision: 2,
      archived: true,
    });
    await call("note.delete", { noteId: note.id, revision: 3 });
    assert.equal((await call("snapshot")).notes.length, 0);
    assert.equal(fs.existsSync(called), false);
  } finally {
    await core.close();
    if (oldTmux === undefined) delete process.env.WORKSPACE_TMUX;
    else process.env.WORKSPACE_TMUX = oldTmux;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("record index preserves identities, SQL deletes and external updates; rollback invalidation restores persisted state", async () => {
  const dir = temp(),
    file = path.join(dir, "workspace.sqlite");
  const db = new DatabaseSync(file);
  await migrate(db, dir);
  const records = indexedRecords(db);
  const put = (kind: string, id: string, value: any) =>
    db
      .prepare("INSERT OR REPLACE INTO records VALUES (?,?,?)")
      .run(kind, id, JSON.stringify(value));
  try {
    put("notes", "n", { id: "n", body: "private" });
    const first = records.metadata("notes")[0];
    assert.equal(first.body, "");
    put("tasks", "t", { id: "t" });
    assert.equal(records.metadata("notes")[0], first);
    db.exec("BEGIN");
    put("notes", "n", { id: "n", body: "rolled back" });
    assert.equal(records.get("notes", "n").body, "rolled back");
    db.exec("ROLLBACK");
    records.invalidate();
    assert.equal(records.get("notes", "n").body, "private");
    const external = new DatabaseSync(file);
    external
      .prepare("UPDATE records SET value=? WHERE kind='notes' AND id='n'")
      .run(JSON.stringify({ id: "n", title: "external", body: "outside" }));
    external.close();
    assert.equal(records.metadata("notes")[0].title, "external");
    db.prepare("DELETE FROM records WHERE kind='notes' AND id='n'").run();
    assert.equal(records.metadata("notes").length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delta receivers reject gaps and epochs and resume from a fresh full snapshot", () => {
  const state: Snapshot = {
    projects: [],
    tasks: [],
    attempts: [],
    sessions: [],
    notes: [],
    layouts: [],
    boardLanes: [],
    capabilities: [],
  };
  const publish = deltaPublisher("one"),
    receive = deltaReceiver();
  const full = publish(state);
  assert.equal(receive.accept(full)?.type, "snapshot");
  const second = publish({
    ...state,
    projects: [{ id: "p", name: "p", path: "/p", createdAt: "now" }],
  });
  assert.equal((receive.accept(second) as any).snapshot.projects.length, 1);
  const third = publish(state);
  assert.equal(
    receive.accept({ ...third, sequence: 44 } as CoreEvent),
    undefined,
  );
  assert.equal(
    receive.accept({ ...third, epoch: "other" } as CoreEvent),
    undefined,
  );
  assert.equal(receive.accept(third)?.type, "snapshot");
  const restarted = deltaPublisher("two")(state);
  assert.equal((receive.accept(restarted) as any).snapshot.projects.length, 0);
});

test("slow Git lane does not delay tmux and streaming handles more than 4 MiB", async () => {
  const blockers = Array.from({ length: 4 }, () =>
    run(
      process.execPath,
      ["-e", "setTimeout(()=>{},500)"],
      undefined,
      undefined,
      { lane: "git" },
    ),
  );
  const winner = await Promise.race([
    run(
      process.execPath,
      ["-e", "process.stdout.write('tmux')"],
      undefined,
      undefined,
      { lane: "tmux" },
    ),
    ...blockers.map((p) => p.then(() => "blocked")),
  ]);
  assert.equal(winner, "tmux");
  await Promise.all(blockers);
  let bytes = 0;
  await runStream(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(5*1024*1024))"],
    process.cwd(),
    (chunk) => {
      bytes += chunk.length;
    },
  );
  assert.equal(bytes, 5 * 1024 * 1024);
  await assert.rejects(
    run(
      process.execPath,
      ["-e", "setTimeout(()=>{},1000)"],
      undefined,
      undefined,
      { timeout: 25 },
    ),
    /outcome unknown/,
  );
});

test("worktree removal refuses dirty or untracked data, retains branch, and new files respect umask", async () => {
  const dir = temp(),
    repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(repo, "file"), "initial");
  git("add", ".");
  git("commit", "-m", "fixture");
  const core = await createCore({
    dataDir: path.join(dir, "data"),
    emit: () => {},
  });
  const call = (command: any, payload = {}) =>
    core.invoke(command, payload) as Promise<any>;
  try {
    const project = await call("project.add", { path: repo }),
      projectId = project.id;
    await call("files.write", {
      projectId,
      path: "new",
      expectedHash: null,
      content: "new",
    });
    assert.equal(
      fs.statSync(path.join(repo, "new")).mode & 0o777,
      0o666 & ~process.umask(),
    );
    const tree = await call("worktree.create", {
      projectId,
      branch: "audit-worktree",
      path: path.join(dir, "beside"),
    });
    fs.writeFileSync(path.join(tree.path, "untracked"), "preserve");
    await assert.rejects(
      call("worktree.remove", { projectId, path: tree.path }),
      /uncommitted or untracked/,
    );
    assert.equal(
      fs.readFileSync(path.join(tree.path, "untracked"), "utf8"),
      "preserve",
    );
    fs.rmSync(path.join(tree.path, "untracked"));
    fs.appendFileSync(
      path.join(repo, ".git", "info", "exclude"),
      "\nignored.secret\n",
    );
    fs.writeFileSync(
      path.join(tree.path, "ignored.secret"),
      "preserve ignored data",
    );
    await assert.rejects(
      call("worktree.remove", { projectId, path: tree.path }),
      /uncommitted or untracked/,
    );
    assert.equal(
      fs.readFileSync(path.join(tree.path, "ignored.secret"), "utf8"),
      "preserve ignored data",
    );
    fs.rmSync(path.join(tree.path, "ignored.secret"));
    await call("worktree.remove", { projectId, path: tree.path });
    assert.equal(fs.existsSync(tree.path), false);
    assert.match(git("branch", "--list", "audit-worktree"), /audit-worktree/);
    await assert.rejects(
      call("worktree.remove", { projectId, path: repo }),
      /linked worktree/,
    );
    const task = await call("task.create", { projectId, title: "delete" });
    await assert.rejects(
      call("task.delete", { taskId: task.id, revision: 0 }),
      /Stale/,
    );
    await call("task.delete", { taskId: task.id, revision: 1 });
    assert.equal((await call("snapshot")).tasks.length, 0);
  } finally {
    await core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export is a private recoverable SQLite copy and daily backup does not multiply on restart", async () => {
  const dir = temp();
  let core = await createCore({ dataDir: dir, emit: () => {} });
  try {
    const project: any = await core.invoke("project.add", { path: dir });
    const note: any = await core.invoke("note.create", {
      projectId: project.id,
      title: "recover",
      body: "saved",
    });
    const exported: any = await core.invoke("backup.export");
    assert.equal(fs.statSync(exported.path).mode & 0o777, 0o600);
    const copy = new DatabaseSync(exported.path);
    assert.equal(
      JSON.parse(
        (
          copy
            .prepare("SELECT value FROM records WHERE kind='notes' AND id=?")
            .get(note.id) as any
        ).value,
      ).body,
      "saved",
    );
    assert.equal(
      (copy.prepare("PRAGMA integrity_check").get() as any).integrity_check,
      "ok",
    );
    copy.close();
    await core.close();
    core = await createCore({ dataDir: dir, emit: () => {} });
    assert.equal(
      fs
        .readdirSync(path.join(dir, "backups"))
        .filter((name) => name.startsWith("workspace-daily-")).length,
      1,
    );
  } finally {
    await core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("large terminal paste chunks preserve exact Unicode bytes", () => {
  const original = "x".repeat(16_383) + "🙂日本語".repeat(40_000);
  let rest = original;
  const chunks: string[] = [];
  while (rest) {
    const chunk = terminalInputChunk(rest);
    chunks.push(chunk);
    rest = rest.slice(chunk.length);
    assert.ok(Buffer.byteLength(chunk) <= 65536);
  }
  assert.equal(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(),
    original,
  );
});

test("Codex resumes the precise ID and invocation-local hooks preserve owner trust", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  assert.deepEqual(
    launchArguments("codex", { codexResumeId: id, model: "fixture" }),
    ["resume", id, "--model", "fixture"],
  );
  assert.throws(
    () => launchArguments("codex", { codexResumeId: "--last" }),
    /Invalid/,
  );
  const config = codexActivityConfig("/opt/homebrew/bin/tmux");
  assert.equal(config.includes("--dangerously-bypass-hook-trust"), false);
  assert.match(config.join("\n"), /PermissionRequest/);
  assert.match(config.join("\n"), /@aw_activity needs/);
  assert.match(config.join("\n"), /SessionStart/);
});

test("a removed live tmux socket reports unknown and reconnects to the same process after socket recovery", async () => {
  const dir = temp(),
    dataDir = path.join(dir, "data");
  let core = await createCore({ dataDir, emit: () => {} });
  let socket = "",
    serverPid = 0;
  const tmux = process.env.WORKSPACE_TMUX || "tmux";
  const call = (command: any, payload = {}) =>
    core.invoke(command, payload) as Promise<any>;
  try {
    const project = await call("project.add", { path: dir });
    const launched = await call("terminal.open", {
      projectId: project.id,
      provider: "shell",
      idempotencyKey: "socket-recovery",
    });
    socket = launched.session.backendSocket;
    const read = (format: string) =>
      execFileSync(
        tmux,
        [
          "-S",
          socket,
          "display-message",
          "-p",
          "-t",
          launched.session.backendName + ":0.0",
          format,
        ],
        { encoding: "utf8" },
      ).trim();
    const panePid = Number(read("#{pane_pid}"));
    serverPid = Number(read("#{pid}"));
    fs.unlinkSync(socket);
    await core.close();
    core = await createCore({ dataDir, emit: () => {} });
    assert.equal((await call("snapshot")).sessions[0].status, "unknown");
    assert.doesNotThrow(() => process.kill(panePid, 0));
    // tmux recreates its own missing socket on SIGUSR1; no new process is launched.
    process.kill(serverPid, "SIGUSR1");
    for (let i = 0; i < 100 && !fs.existsSync(socket); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(Number(read("#{pane_pid}")), panePid);
    const viewer = {
      sessionId: launched.session.id,
      generation: 1,
      viewerId: "recover",
    };
    await call("session.attach", viewer);
    assert.equal((await call("snapshot")).sessions[0].status, "running");
    await call("session.terminate", viewer);
  } finally {
    await core.close();
    if (socket)
      try {
        execFileSync(tmux, ["-S", socket, "kill-server"], { stdio: "ignore" });
      } catch {
        if (serverPid)
          try {
            process.kill(serverPid, "SIGTERM");
          } catch {}
      }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
