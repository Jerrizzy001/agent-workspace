import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createCore } from "../src/core/index.js";
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
async function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-services-"));
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  const dataDir = path.join(temp, "data");
  const core = await createCore({ dataDir, emit: () => {} });
  const project: any = await core.invoke("project.add", { path: repo });
  const call = (command: any, payload: any = {}) =>
    core.invoke(command, { projectId: project.id, ...payload }) as Promise<any>;
  return { temp, repo, dataDir, core, project, call };
}
test("Git handles literal filenames, unborn unstaging, staged-only diffs, renames and commits", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.repo, "a[1].txt"), "literal\n");
    fs.writeFileSync(path.join(f.repo, "a1.txt"), "other\n");
    await f.call("git.stage", { paths: ["a[1].txt"] });
    let status = await f.call("git.status");
    assert.equal(
      status.files.find((v: any) => v.path === "a[1].txt").index,
      "A",
    );
    assert.equal(status.files.find((v: any) => v.path === "a1.txt").index, "?");
    await f.call("git.unstage", { paths: ["a[1].txt"] });
    assert.equal(
      fs.readFileSync(path.join(f.repo, "a[1].txt"), "utf8"),
      "literal\n",
    );
    assert.equal(
      (await f.call("git.status")).files.every((v: any) => v.index === "?"),
      true,
    );
    await f.call("git.stage", { paths: ["."] });
    const initial = await f.call("git.commit", { message: "Initial fixture" });
    assert.match(initial.hash, /^[a-f0-9]{40}$/);
    fs.writeFileSync(path.join(f.repo, "a1.txt"), "staged change\n");
    await f.call("git.stage", { paths: ["a1.txt"] });
    fs.writeFileSync(path.join(f.repo, "a1.txt"), "later working change\n");
    assert.match(
      (await f.call("git.diff", { path: "a1.txt", staged: true })).diff,
      /\+staged change/,
    );
    assert.doesNotMatch(
      (await f.call("git.diff", { path: "a1.txt", staged: true })).diff,
      /later working change/,
    );
    assert.match(
      (await f.call("git.diff", { path: "a1.txt" })).diff,
      /\+later working change/,
    );
    await f.call("git.unstage", { paths: ["a1.txt"] });
    fs.renameSync(
      path.join(f.repo, "a[1].txt"),
      path.join(f.repo, "renamed.txt"),
    );
    await f.call("git.stage", { paths: ["."] });
    status = await f.call("git.status");
    assert.equal(
      status.files.find((v: any) => v.path === "renamed.txt").originalPath,
      "a[1].txt",
    );
    assert.match(
      (await f.call("git.diff", { path: "renamed.txt", staged: true })).diff,
      /rename from a\[1\]\.txt/,
    );
    await f.call("git.unstage", { paths: ["renamed.txt"] });
    status = await f.call("git.status");
    assert.equal(
      status.files.some(
        (v: any) =>
          v.index === "D" ||
          v.index === "R" ||
          (v.index === "A" && v.path === "renamed.txt"),
      ),
      false,
    );
    assert.equal(fs.existsSync(path.join(f.repo, "renamed.txt")), true);
    fs.writeFileSync(path.join(f.repo, "untracked.txt"), "review me\n");
    assert.match(
      (await f.call("git.diff", { path: "untracked.txt" })).diff,
      /\+review me/,
    );
    await assert.rejects(
      f.call("git.diff", { path: "../outside" }),
      /Invalid Git path/,
    );
    await assert.rejects(
      f.call("git.stage", { paths: ["../outside"] }),
      /Invalid Git path/,
    );
    await assert.rejects(
      f.call("git.diff", { path: "a1.txt", staged: "yes" }),
      /staged flag/,
    );
  } finally {
    await f.core.close();
    fs.rmSync(f.temp, { recursive: true, force: true });
  }
});
test("file services enforce symlink/root boundaries and durable optimistic saves", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.temp, "outside.txt"), "private outside");
    fs.symlinkSync(
      path.join(f.temp, "outside.txt"),
      path.join(f.repo, "escape"),
    );
    fs.symlinkSync(f.temp, path.join(f.repo, "escape-dir"));
    await assert.rejects(f.call("files.read", { path: "escape" }), /escapes/);
    await assert.rejects(
      f.call("files.write", {
        path: "escape",
        content: "bad",
        expectedHash: null,
      }),
      /escapes/,
    );
    await assert.rejects(
      f.call("files.write", {
        path: "escape-dir/new",
        content: "bad",
        expectedHash: null,
      }),
      /escapes/,
    );
    await assert.rejects(f.call("files.read", { path: "." }), /regular files/);
    await assert.rejects(
      f.call("files.write", { path: ".", content: "bad", expectedHash: null }),
      /regular files/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.temp, "outside.txt"), "utf8"),
      "private outside",
    );
    const saved = await f.call("files.write", {
      path: "new.txt",
      content: "created",
      expectedHash: null,
    });
    const updated = await f.call("files.write", {
      path: "new.txt",
      content: "updated",
      expectedHash: saved.hash,
    });
    await assert.rejects(
      f.call("files.write", {
        path: "new.txt",
        content: "stale",
        expectedHash: saved.hash,
      }),
      /conflict/,
    );
    assert.equal(
      (await f.call("files.read", { path: "new.txt" })).hash,
      updated.hash,
    );
    fs.writeFileSync(path.join(f.repo, "binary"), Buffer.from([0, 1, 2]));
    await assert.rejects(f.call("files.read", { path: "binary" }), /Binary/);
    fs.writeFileSync(path.join(f.repo, "invalid-utf8"), Buffer.from([0xff, 0xfe]));
    await assert.rejects(f.call("files.read", { path: "invalid-utf8" }), /non-UTF-8/);
    fs.writeFileSync(path.join(f.repo, "replacement.txt"), "\ufffd");
    const replacement = await f.call("files.read", { path: "replacement.txt" });
    fs.writeFileSync(path.join(f.repo, "replacement.txt"), Buffer.from([0xff]));
    await assert.rejects(
      f.call("files.write", { path: "replacement.txt", expectedHash: replacement.hash, content: "overwrite" }),
      /conflict/,
    );
    assert.deepEqual(fs.readFileSync(path.join(f.repo, "replacement.txt")), Buffer.from([0xff]));
    await assert.rejects(
      f.call("files.write", { path: "new-binary", expectedHash: null, content: "\0" }),
      /Invalid file content/,
    );
    fs.mkdirSync(path.join(f.repo, "nested"));
    const nested: any = await f.core.invoke("project.add", {
      path: path.join(f.repo, "nested"),
    });
    await assert.rejects(
      f.core.invoke("git.status", { projectId: nested.id }),
      /repository root/,
    );
    await assert.rejects(
      f.call("files.read", { worktreePath: f.temp, path: "outside.txt" }),
      /does not belong/,
    );
    const task = await f.call("task.create", {
      title: "Persistent",
      description: "Saved task",
    });
    const note = await f.call("note.create", { title: "Note", body: "first" });
    await f.call("note.update", { noteId: note.id, body: "second" });
    await f.call("layout.save", { positions: { [task.id]: { x: 12, y: 34 } } });
    await assert.rejects(
      f.call("note.update", { noteId: note.id, body: { bad: true } }),
      /Invalid body/,
    );
    await assert.rejects(
      f.call("task.create", { title: "bad", description: [] }),
      /Invalid description/,
    );
    await f.core.close();
    const reopened = await createCore({ dataDir: f.dataDir, emit: () => {} });
    try {
      const snapshot: any = await reopened.invoke("snapshot");
      assert.equal(snapshot.notes[0].body, "second");
      assert.equal(snapshot.layouts[0].positions[task.id].x, 12);
      assert.equal(snapshot.tasks[0].description, "Saved task");
    } finally {
      await reopened.close();
    }
  } finally {
    await f.core.close();
    fs.rmSync(f.temp, { recursive: true, force: true });
  }
});
test("failed database startup releases owner lock and stale owner recovery preserves database", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-storage-"));
  try {
    fs.writeFileSync(path.join(temp, "workspace.sqlite"), "invalid database");
    await assert.rejects(createCore({ dataDir: temp, emit: () => {} }));
    assert.equal(fs.existsSync(path.join(temp, "owner.lock")), false);
    fs.unlinkSync(path.join(temp, "workspace.sqlite"));
    fs.writeFileSync(
      path.join(temp, "owner.lock"),
      JSON.stringify({ pid: 2147483647 }),
    );
    const core = await createCore({ dataDir: temp, emit: () => {} });
    await assert.rejects(
      createCore({ dataDir: temp, emit: () => {} }),
      /already owned/,
    );
    await core.close();
    assert.equal(fs.existsSync(path.join(temp, "owner.lock")), false);
    const newer = new DatabaseSync(path.join(temp, "workspace.sqlite"));
    newer.exec("PRAGMA user_version=4");
    newer.close();
    await assert.rejects(createCore({ dataDir: temp, emit: () => {} }), /newer app version/);
    const preserved = new DatabaseSync(path.join(temp, "workspace.sqlite"));
    assert.equal((preserved.prepare("PRAGMA user_version").get() as any).user_version, 4);
    preserved.close();
    assert.equal(fs.existsSync(path.join(temp, "owner.lock")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function childOwner(dataDir: string, leaveAcquisition = false) {
  const module = pathToFileURL(path.resolve("src/core/index.ts")).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       import {createCore} from ${JSON.stringify(module)};
       const dataDir = ${JSON.stringify(dataDir)};
       try {
         const core = await createCore({dataDir, emit: () => {}});
         await core.invoke("project.add", {path: dataDir});
         if (${leaveAcquisition}) fs.writeFileSync(dataDir + "/owner.acquire.lock", JSON.stringify({pid: process.pid}));
         process.send({state: "acquired"});
         setInterval(() => {}, 1000);
       } catch (error) {
         process.send({state: "rejected", message: error.message});
         process.disconnect();
       }`,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const result = new Promise<{ state: string; message?: string }>((resolve, reject) => {
    child.once("message", (message) => resolve(message as any));
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`Owner child exited before reporting: ${code ?? signal}: ${stderr}`)),
    );
  });
  return { child, result };
}
async function killOwner(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
test("ownership survives a real process crash with acquisition residue and rejects concurrent processes", { timeout: 15000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-owner-crash-"));
  const crashed = childOwner(temp, true);
  let reopened: Awaited<ReturnType<typeof createCore>> | undefined;
  try {
    assert.equal((await crashed.result).state, "acquired");
    await assert.rejects(createCore({ dataDir: temp, emit: () => {} }), /already owned/);
    await killOwner(crashed.child);
    assert.equal(fs.existsSync(path.join(temp, "owner.acquire.lock")), true);
    reopened = await createCore({ dataDir: temp, emit: () => {} });
    assert.equal(((await reopened.invoke("snapshot")) as any).projects.length, 1);
    assert.equal(fs.existsSync(path.join(temp, "owner.acquire.lock")), false);
    await Promise.all([reopened.close(), reopened.close()]);
    reopened = undefined;
    for (const contenderDir of [temp, path.join(temp, "fresh")]) {
      const contenders = [childOwner(contenderDir), childOwner(contenderDir)];
      try {
        const results = await Promise.all(contenders.map((c) => c.result));
        assert.equal(results.filter((r) => r.state === "acquired").length, 1, JSON.stringify(results));
        assert.equal(results.filter((r) => r.state === "rejected").length, 1);
        assert.match(results.find((r) => r.state === "rejected")!.message!, /already owned/);
      } finally {
        await Promise.all(contenders.map((c) => killOwner(c.child)));
      }
    }
    reopened = await createCore({ dataDir: temp, emit: () => {} });
    assert.equal(((await reopened.invoke("snapshot")) as any).projects.length, 1);
  } finally {
    await killOwner(crashed.child);
    await reopened?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("legacy live ownership files are never stolen and failed acquisition releases the SQLite lock", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-owner-legacy-"));
  try {
    for (const name of ["owner.lock", "owner.acquire.lock"]) {
      const file = path.join(temp, name);
      const contents = JSON.stringify({ pid: process.pid });
      fs.writeFileSync(file, contents);
      await assert.rejects(createCore({ dataDir: temp, emit: () => {} }), /owned|in progress/);
      assert.equal(fs.readFileSync(file, "utf8"), contents);
      fs.unlinkSync(file);
      const core = await createCore({ dataDir: temp, emit: () => {} });
      await core.close();
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("owner folder listing sorts folders first, flags repositories and explains denied folders", async () => {
  const { listDirectory } = await import("../src/desktop/folders.js");
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workspace-browse-")));
  try {
    fs.mkdirSync(path.join(temp, "beta"));
    fs.mkdirSync(path.join(temp, "alpha", ".git"), { recursive: true });
    fs.mkdirSync(path.join(temp, ".hidden"));
    fs.writeFileSync(path.join(temp, "notes.txt"), "x");
    fs.symlinkSync(path.join(temp, "beta"), path.join(temp, "beta-link"));
    const listing = await listDirectory(temp);
    assert.equal(listing.path, temp);
    assert.equal(listing.parent, path.dirname(temp));
    assert.deepEqual(
      listing.entries.map((e) => [e.name, e.type, !!e.git, e.hidden]),
      [
        [".hidden", "directory", false, true],
        ["alpha", "directory", true, false],
        ["beta", "directory", false, false],
        ["beta-link", "directory", false, false],
        ["notes.txt", "file", false, false],
      ],
    );
    assert.ok(listing.places.some((p) => p.name === "Home"));
    await assert.rejects(listDirectory("relative/path"), /Choose a folder/);
    await assert.rejects(listDirectory(path.join(temp, "missing")), /no longer exists/);
    await assert.rejects(listDirectory(path.join(temp, "notes.txt")), /file, not a folder/);
    if (process.getuid?.() !== 0) {
      fs.mkdirSync(path.join(temp, "locked"), { mode: 0o000 });
      await assert.rejects(listDirectory(path.join(temp, "locked")), /permission/);
    }
  } finally {
    fs.chmodSync(temp, 0o700);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
