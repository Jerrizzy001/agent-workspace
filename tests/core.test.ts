import { workspaceSocket } from "../src/core/socket.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createCore } from "../src/core/index.js";
const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
test("persistent core, file conflict, worktree and session ownership", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "initial");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture"]);
  const dataDir = path.join(temp, "data");
  let core = await createCore({ dataDir, emit: () => {} });
  const call = (c: any, p: any = {}) => core.invoke(c, p) as Promise<any>;
  let sid = "";
  try {
    await assert.rejects(
      () => createCore({ dataDir, emit: () => {} }),
      /already owned/,
    );
    const project = await call("project.add", { path: repo });
    const scope = { projectId: project.id };
    const task = await call("task.create", { ...scope, title: "Test" });
    await assert.rejects(
      call("task.update", { taskId: task.id, revision: 0, status: "done" }),
      /Stale/,
    );
    const f = await call("files.read", { ...scope, path: "file.txt" });
    fs.writeFileSync(path.join(repo, "file.txt"), "outside");
    await assert.rejects(
      call("files.write", {
        ...scope,
        path: "file.txt",
        expectedHash: f.hash,
        content: "stale",
      }),
      /conflict/,
    );
    await assert.rejects(
      call("files.read", { ...scope, path: "../data/owner.lock" }),
      /escapes/,
    );
    const wt = await call("worktree.create", {
      ...scope,
      branch: "fixture-isolated",
    });
    await call("files.write", {
      ...scope,
      worktreePath: wt.path,
      path: "file.txt",
      expectedHash: (
        await call("files.read", {
          ...scope,
          worktreePath: wt.path,
          path: "file.txt",
        })
      ).hash,
      content: "isolated",
    });
    assert.equal(
      fs.readFileSync(path.join(repo, "file.txt"), "utf8"),
      "outside",
    );
    const args = {
      taskId: task.id,
      provider: "shell",
      idempotencyKey: "launch-one",
    };
    const [first, second] = await Promise.all([
      call("attempt.start", args),
      call("attempt.start", args),
    ]);
    sid = first.session.id;
    assert.equal(second.session.id, sid);
    await assert.rejects(
      call("attempt.start", { ...args, provider: "codex" }),
      /different request/,
    );
    const session = { sessionId: sid, generation: 1, viewerId: "b" };
    await call("session.attach", {
      ...session,
      viewerId: "a",
      cols: 120,
      rows: 40,
    });
    await call("session.attach", {
      ...session,
      viewerId: "b",
      cols: 80,
      rows: 24,
    });
    const sessionSocket = workspaceSocket(fs.realpathSync(dataDir));
    const paneSize = () =>
      execFileSync(
        "/opt/homebrew/bin/tmux",
        [
          "-S",
          sessionSocket,
          "display-message",
          "-p",
          "-t",
          first.session.backendName + ":0.0",
          "#{pane_width},#{pane_height}",
        ],
        { encoding: "utf8" },
      ).trim();
    for (let retry = 0; retry < 20 && paneSize() !== "80,24"; retry++)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(paneSize(), "80,24");
    await call("session.resize", {
      ...session,
      viewerId: "a",
      cols: 60,
      rows: 18,
    });
    for (let retry = 0; retry < 20 && paneSize() !== "60,18"; retry++)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(paneSize(), "60,18");
    await assert.rejects(
      call("session.resize", { ...session, generation: 2, cols: 80, rows: 24 }),
      /Stale/,
    );
    await call("session.detach", { ...session, viewerId: "a" });
    for (let retry = 0; retry < 20 && paneSize() !== "80,24"; retry++)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(paneSize(), "80,24");
    await assert.rejects(
      call("session.terminate", { ...session, viewerId: "a" }),
      /not attached/,
    );
    await assert.rejects(
      call("session.input", { sessionId: sid, viewerId: "b", data: "x" }),
      /generation required/,
    );
    await assert.rejects(
      call("session.input", { ...session, viewerId: "a", data: "x" }),
      /not attached/,
    );
    await call("session.input", {
      ...session,
      data: "printf 'CORE_FIXTURE_OK\\n'\r",
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.match(
      (await call("session.capture", session)).data,
      /CORE_FIXTURE_OK/,
    );
    await assert.rejects(
      call("session.input", { ...session, generation: 2, data: "x" }),
      /Stale/,
    );
    await core.close();
    const unavailable = path.join(temp, "unreachable-tmux");
    fs.writeFileSync(
      unavailable,
      '#!/bin/sh\nprintf "permission denied\\n" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    const dataAlias = path.join(temp, "data-alias");
    fs.symlinkSync(dataDir, dataAlias);
    const oldTmux = process.env.WORKSPACE_TMUX;
    process.env.WORKSPACE_TMUX = unavailable;
    core = await createCore({ dataDir, emit: () => {} });
    assert.equal((await call("snapshot")).sessions[0].status, "unknown");
    await core.close();
    if (oldTmux) process.env.WORKSPACE_TMUX = oldTmux;
    else delete process.env.WORKSPACE_TMUX;
    core = await createCore({ dataDir: dataAlias, emit: () => {} });
    assert.equal((await call("snapshot")).sessions[0].id, sid);
    assert.equal((await call("snapshot")).sessions[0].status, "running");
    assert.match(
      (await call("session.capture", session)).data,
      /CORE_FIXTURE_OK/,
    );
    const other = await call("attempt.start", {
      ...args,
      idempotencyKey: "launch-two",
    });
    await call("session.attach", session);
    execFileSync("/opt/homebrew/bin/tmux", [
      "-S",
      sessionSocket,
      "new-session",
      "-d",
      "-s",
      first.session.backendName + "-neighbor",
      "/bin/sh",
    ]);
    await call("session.input", {
      ...session,
      data: "printf 'END_CAPTURE_OK\\n'\r",
    });
    await new Promise((r) => setTimeout(r, 150));
    await call("session.terminate", session);
    assert.doesNotThrow(() =>
      execFileSync(
        "/opt/homebrew/bin/tmux",
        [
          "-S",
          sessionSocket,
          "has-session",
          "-t",
          "=" + first.session.backendName + "-neighbor",
        ],
        { stdio: "ignore" },
      ),
    );
    const finalScreen = await call("session.capture", session);
    assert.equal(finalScreen.saved, true);
    assert.match(finalScreen.data, /END_CAPTURE_OK/);
    assert.equal(
      (await call("snapshot")).sessions.find(
        (s: any) => s.id === other.session.id,
      ).status,
      "running",
    );
    const journal = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
    journal
      .prepare("UPDATE receipts SET result=NULL WHERE key=?")
      .run("launch-two");
    journal.close();
    assert.equal(
      (await call("attempt.start", { ...args, idempotencyKey: "launch-two" }))
        .session.id,
      other.session.id,
    );
    await call("session.attach", {
      sessionId: other.session.id,
      viewerId: "b",
    });
    await call("session.terminate", {
      sessionId: other.session.id,
      generation: 1,
      viewerId: "b",
    });
    assert.equal((await call("snapshot")).sessions[0].status, "exited");
    assert.equal((await call("attempt.start", args)).session.status, "exited");
    const absentJournal = new DatabaseSync(
      path.join(dataDir, "workspace.sqlite"),
    );
    absentJournal
      .prepare("UPDATE receipts SET result=NULL WHERE key=?")
      .run("launch-two");
    absentJournal.close();
    await assert.rejects(
      call("attempt.start", { ...args, idempotencyKey: "launch-two" }),
      /outcome unknown/,
    );
    assert.equal((await call("snapshot")).attempts.length, 2);
  } finally {
    if (sid)
      try {
        await call("session.terminate", { sessionId: sid });
      } catch {}
    await core.close();
    const socket = workspaceSocket(fs.realpathSync(dataDir));
    try {
      execFileSync(
        process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux",
        ["-S", socket, "kill-server"],
        { stdio: "ignore" },
      );
    } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("fresh provider launch receives exact task prompt as arguments without shell interpretation", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-provider-"));
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  const received = path.join(temp, "received");
  const marker = path.join(temp, "unwanted");
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${received}'\nexec /bin/cat\n`,
    { mode: 0o700 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  const dataDir = path.join(temp, "data");
  let core: Awaited<ReturnType<typeof createCore>> | undefined;
  try {
    core = await createCore({ dataDir, emit: () => {} });
    const project: any = await core.invoke("project.add", { path: temp });
    const task: any = await core.invoke("task.create", {
      projectId: project.id,
      title: "Task",
      description: `literal $(touch ${marker})`,
    });
    const launched: any = await core.invoke("attempt.start", {
      taskId: task.id,
      provider: "codex",
      idempotencyKey: "synthetic-provider",
      model: "fixture-model",
    });
    for (let retry = 0; retry < 40 && !fs.existsSync(received); retry++)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      fs.readFileSync(received, "utf8"),
      `--model\nfixture-model\n--\nTask\n\nliteral $(touch ${marker})\n`,
    );
    assert.equal(launched.attempt.model, "fixture-model");
    await assert.rejects(
      core.invoke("attempt.start", {
        taskId: task.id,
        provider: "codex",
        idempotencyKey: "synthetic-provider",
        model: "different-model",
      }),
      /different request/,
    );
    assert.equal(fs.existsSync(marker), false);
    await core.invoke("session.attach", {
      sessionId: launched.session.id,
      viewerId: "test",
    });
    await core.invoke("session.terminate", {
      sessionId: launched.session.id,
      viewerId: "test",
      generation: 1,
    });
  } finally {
    process.env.PATH = oldPath;
    await core?.close();
    const socket = workspaceSocket(fs.realpathSync(dataDir));
    try {
      execFileSync("/opt/homebrew/bin/tmux", ["-S", socket, "kill-server"], {
        stdio: "ignore",
      });
    } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("detached shell exit is reconciled without reopening and private tmux has no status bar", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-exit-"));
  const dataDir = path.join(temp, "data");
  const snapshots: any[] = [];
  const core = await createCore({
    dataDir,
    emit: (event) => {
      if (event.type === "snapshot") snapshots.push(event.snapshot);
    },
  });
  const socket = workspaceSocket(fs.realpathSync(dataDir));
  try {
    const project: any = await core.invoke("project.add", { path: temp });
    const task: any = await core.invoke("task.create", {
      projectId: project.id,
      title: "Exit fixture",
    });
    const launched: any = await core.invoke("attempt.start", {
      taskId: task.id,
      provider: "shell",
      idempotencyKey: "delayed-exit",
    });
    assert.equal(
      execFileSync(
        "/opt/homebrew/bin/tmux",
        [
          "-S",
          socket,
          "show-option",
          "-v",
          "-t",
          launched.session.backendName,
          "status",
        ],
        { encoding: "utf8" },
      ).trim(),
      "off",
    );
    const viewer = {
      sessionId: launched.session.id,
      generation: 1,
      viewerId: "fixture",
    };
    await core.invoke("session.attach", viewer);
    await core.invoke("session.input", {
      ...viewer,
      data: "sleep 0.8; exit\r",
    });
    await new Promise((r) => setTimeout(r, 50));
    await core.invoke("session.detach", viewer);
    for (let retry = 0; retry < 100; retry++) {
      if (
        ((await core.invoke("snapshot")) as any).sessions[0].status === "exited"
      )
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const snapshot: any = await core.invoke("snapshot");
    assert.equal(snapshot.sessions[0].status, "exited");
    assert.equal(snapshot.attempts[0].status, "exited");
    assert.ok(snapshots.some((s) => s.sessions[0]?.status === "exited"));
    await assert.rejects(core.invoke("session.attach", viewer), /has exited/);
  } finally {
    await core.close();
    try {
      execFileSync("/opt/homebrew/bin/tmux", ["-S", socket, "kill-server"], {
        stdio: "ignore",
      });
    } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("legacy socket upgrade preserves old shell identity and independently targets mixed backend sockets", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-upgrade-"));
  const oldTmpdir = process.env.TMPDIR;
  const isolatedSockets = fs.mkdtempSync("/tmp/aw-sockets-");
  process.env.TMPDIR = isolatedSockets;
  const dataDir = path.join(temp, "data");
  let core = await createCore({ dataDir, emit: () => {} });
  const sockets = new Set<string>();
  const tmux = (socket: string, args: string[]) =>
    execFileSync("/opt/homebrew/bin/tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const project: any = await core.invoke("project.add", { path: temp });
    const task: any = await core.invoke("task.create", {
      projectId: project.id,
      title: "Upgrade fixture",
    });
    const modern: any = await core.invoke("attempt.start", {
      taskId: task.id,
      provider: "shell",
      idempotencyKey: "modern",
    });
    sockets.add(modern.session.backendSocket);
    await core.close();
    const alias = path.join(temp, "old-data-alias");
    fs.symlinkSync(dataDir, alias);
    const legacySocket = path.join(
      os.tmpdir(),
      "aw-" +
        crypto.createHash("sha256").update(alias).digest("hex").slice(0, 20) +
        ".sock",
    );
    sockets.add(legacySocket);
    // Real older sockets must remain discoverable beyond an arbitrary scan prefix.
    for (let i = 0; i < 70; i++)
      fs.writeFileSync(
        path.join(
          isolatedSockets,
          `aw-${i.toString(16).padStart(20, "0")}.sock`,
        ),
        "stale socket fixture",
      );
    const sid = crypto.randomUUID(),
      aid = crypto.randomUUID();
    const backendName = "aw-" + sid;
    tmux(legacySocket, [
      "new-session",
      "-d",
      "-s",
      backendName,
      "-c",
      temp,
      "/bin/sh",
    ]);
    const before = tmux(legacySocket, [
      "display-message",
      "-p",
      "-t",
      backendName + ":0.0",
      "#{pane_pid}",
    ]).trim();
    const oldSession = {
      id: sid,
      attemptId: aid,
      projectId: project.id,
      provider: "shell",
      cwd: temp,
      backendName,
      generation: 1,
      status: "running",
      createdAt: new Date().toISOString(),
    };
    const oldAttempt = {
      id: aid,
      taskId: task.id,
      projectId: project.id,
      provider: "shell",
      sessionId: sid,
      worktreePath: temp,
      status: "running",
      createdAt: new Date().toISOString(),
    };
    const database = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
    database.prepare("DELETE FROM records WHERE kind=?").run("backend");
    const modernSession = { ...modern.session };
    delete modernSession.backendSocket;
    database
      .prepare("UPDATE records SET value=? WHERE kind=? AND id=?")
      .run(JSON.stringify(modernSession), "sessions", modernSession.id);
    database
      .prepare("INSERT INTO records VALUES (?,?,?)")
      .run("sessions", sid, JSON.stringify(oldSession));
    database
      .prepare("INSERT INTO records VALUES (?,?,?)")
      .run("attempts", aid, JSON.stringify(oldAttempt));
    database.close();
    core = await createCore({
      dataDir: fs.realpathSync(dataDir),
      emit: () => {},
    });
    let snapshot: any = await core.invoke("snapshot");
    assert.equal(
      snapshot.sessions.find((s: any) => s.id === sid).status,
      "running",
    );
    assert.equal(
      snapshot.sessions.find((s: any) => s.id === sid).backendSocket,
      legacySocket,
    );
    assert.equal(
      tmux(legacySocket, [
        "display-message",
        "-p",
        "-t",
        backendName + ":0.0",
        "#{pane_pid}",
      ]).trim(),
      before,
    );
    const viewer = { sessionId: sid, generation: 1, viewerId: "legacy" };
    await core.invoke("session.attach", viewer);
    await core.invoke("session.input", {
      ...viewer,
      data: "printf 'LEGACY_SOCKET_MARKER\\n'\r",
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(
      ((await core.invoke("session.capture", viewer)) as any).data,
      /LEGACY_SOCKET_MARKER/,
    );
    assert.doesNotMatch(
      (
        (await core.invoke("session.capture", {
          sessionId: modernSession.id,
        })) as any
      ).data,
      /LEGACY_SOCKET_MARKER/,
    );
    await core.invoke("session.terminate", viewer);
    snapshot = await core.invoke("snapshot");
    assert.equal(
      snapshot.sessions.find((s: any) => s.id === modernSession.id).status,
      "running",
    );
    assert.equal(
      snapshot.sessions.find((s: any) => s.id === sid).status,
      "exited",
    );
  } finally {
    await core.close();
    for (const socket of sockets)
      try {
        tmux(socket, ["kill-server"]);
      } catch {}
    if (oldTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmpdir;
    fs.rmSync(isolatedSockets, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
