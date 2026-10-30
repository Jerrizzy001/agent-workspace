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
    await call("session.attach", { ...session, viewerId: "a" });
    await call("session.attach", { ...session, viewerId: "b" });
    await call("session.detach", { ...session, viewerId: "a" });
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
    const oldTmux = process.env.WORKSPACE_TMUX;
    process.env.WORKSPACE_TMUX = unavailable;
    core = await createCore({ dataDir, emit: () => {} });
    assert.equal((await call("snapshot")).sessions[0].status, "unknown");
    await core.close();
    if (oldTmux) process.env.WORKSPACE_TMUX = oldTmux;
    else delete process.env.WORKSPACE_TMUX;
    core = await createCore({ dataDir, emit: () => {} });
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
    await call("session.terminate", session);
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
  } finally {
    if (sid)
      try {
        await call("session.terminate", { sessionId: sid });
      } catch {}
    await core.close();
    const socket = path.join(
      os.tmpdir(),
      "aw-" +
        crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 20) +
        ".sock",
    );
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
    });
    for (let retry = 0; retry < 40 && !fs.existsSync(received); retry++)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      fs.readFileSync(received, "utf8"),
      `--\nTask\n\nliteral $(touch ${marker})\n`,
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
    const socket = path.join(
      os.tmpdir(),
      "aw-" +
        crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 20) +
        ".sock",
    );
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
  const socket = path.join(
    os.tmpdir(),
    "aw-" +
      crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 20) +
      ".sock",
  );
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
