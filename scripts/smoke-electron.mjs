import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const fixture = await mkdtemp(path.join(tmpdir(), "workspace-smoke-"));
const repo = path.join(fixture, "repo");
await mkdir(repo);
await writeFile(path.join(repo, "hello.txt"), "before\n");
for (const args of [
  ["init"],
  ["config", "user.email", "fixture@example.invalid"],
  ["config", "user.name", "Fixture"],
  ["add", "."],
  ["commit", "-m", "fixture"],
])
  execFileSync("git", args, { cwd: repo });
const executablePath = process.env.WORKSPACE_APP_EXECUTABLE;
async function launch() {
  return electron.launch({
    ...(executablePath ? { executablePath } : { args: ["."] }),
    env: {
      ...process.env,
      WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
    },
  });
}
let app;
try {
app = await launch();
const runtime = await app.evaluate(({app}) => ({version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node, architecture: process.arch}));
let page = await app.firstWindow();
await page.waitForFunction(() => !!window.workspace);
let invoke = (command, payload = {}) =>
  page.evaluate(
    ({ command, payload }) => window.workspace.invoke(command, payload),
    { command, payload },
  );
const snapshot = await invoke("snapshot");
assert.equal(snapshot.projects.length, 0);
const project = await invoke("project.add", { path: repo });
const task = await invoke("task.create", {
  projectId: project.id,
  title: "Persistence fixture",
});
const launchResult = await invoke("attempt.start", {
  taskId: task.id,
  provider: "shell",
  idempotencyKey: "smoke-one",
});
let state = await invoke("snapshot");
const session = state.sessions.find((s) => s.id === launchResult.session.id);
assert.ok(session);
const sp = {
  sessionId: session.id,
  generation: session.generation,
  viewerId: "smoke",
};
await invoke("session.attach", {
  ...sp,
  viewerId: "smoke",
  cols: 100,
  rows: 30,
});
await invoke("session.input", {
  ...sp,
  data: "printf '%s%s\\n' 'SMOKE_PERSIST_' '123'\r",
});
await page.waitForTimeout(600);
assert.match((await invoke("session.capture", sp)).data, /SMOKE_PERSIST_123/);
await writeFile(path.join(repo, "hello.txt"), "after\n");
assert.match(
  (await invoke("git.diff", { projectId: project.id })).diff,
  /after/,
);
const worktree = await invoke("worktree.create", {
  projectId: project.id,
  branch: "smoke-branch",
});
assert.ok(worktree.path);
await page.screenshot({ path: path.join(fixture, "desktop.png") });
await app.close();
app = await launch();
page = await app.firstWindow();
await page.waitForFunction(() => !!window.workspace);
invoke = (command, payload = {}) =>
  page.evaluate(
    ({ command, payload }) => window.workspace.invoke(command, payload),
    { command, payload },
  );
state = await invoke("snapshot");
assert.equal(state.sessions.length, 1);
await invoke("session.attach", { ...sp, cols: 100, rows: 30 });
assert.match((await invoke("session.capture", sp)).data, /SMOKE_PERSIST_123/);
await invoke("session.terminate", sp);
await app.close();
console.log(
  JSON.stringify({
    passed: true,
    runtime,
    fixture,
    checks: [
      "snapshot",
      "project",
      "task",
      "shell input/capture",
      "git diff",
      "worktree",
      "quit/reopen same backend",
      "terminate",
    ],
  }),
);

} finally {
  if (app) await app.close().catch(() => {});
  await cleanupFixture(fixture);
}
