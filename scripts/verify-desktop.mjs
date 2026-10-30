import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const fixture = await mkdtemp(path.join(tmpdir(), "workspace-desktop-"));
const repo = path.join(fixture, "repo");
await mkdir(repo);
await writeFile(path.join(repo, "hello.txt"), "fixture\n");
for (const args of [["init"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "."], ["commit", "-m", "fixture"]]) execFileSync("git", args, { cwd: repo, stdio: "ignore" });
let app;
let page;
let invoke;
const checks = [];
async function launch() {
  app = await electron.launch({
    ...(process.env.WORKSPACE_APP_EXECUTABLE ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE } : { args: ["."] }),
    env: { ...process.env, WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => !!window.workspace);
  invoke = (command, payload = {}) => page.evaluate(({ command, payload }) => window.workspace.invoke(command, payload), { command, payload });
  await invoke("snapshot");
}
try {
  await launch();
  for (const [command, payload, expected] of [["invalid", {}, /Unsupported workspace command/], ["snapshot", [], /Invalid payload/], ["snapshot", { value: "x".repeat(2_000_001) }, /Invalid payload/]]) await assert.rejects(invoke(command, payload), expected);
  // A foreign window can load the preload but must not control the active workspace.
  const foreignResult = await app.evaluate(async ({ app, BrowserWindow }) => {
    const foreign = new BrowserWindow({ show: false, webPreferences: { preload: `${app.getAppPath()}/dist/desktop/preload.cjs`, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await foreign.loadURL("data:text/html,<html>foreign frame</html>");
      return await foreign.webContents.executeJavaScript("window.workspace.invoke('snapshot').then(() => 'unexpected success', e => e.message)");
    } finally { foreign.destroy(); }
  });
  assert.match(foreignResult, /Unsupported workspace command/);
  const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await page.evaluate(() => window.open("https://example.invalid"));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), windowCount);
  checks.push("IPC allowlist, payload bound, foreign-window rejection and popup denial");
  const project = await invoke("project.add", { path: repo });
  const task = await invoke("task.create", { projectId: project.id, title: "Desktop recovery" });
  const started = await invoke("attempt.start", { taskId: task.id, provider: "shell", idempotencyKey: "desktop-recovery" });
  const sp = { sessionId: started.session.id, generation: started.session.generation, viewerId: "desktop-recovery" };
  await invoke("session.attach", { ...sp, cols: 100, rows: 30 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const pid = await app.evaluate(({ app }) => app.getAppMetrics().find(m => m.name === "Agent Workspace Core")?.pid);
    assert.ok(pid, "Core PID exists");
    await app.evaluate((_, pid) => process.kill(pid, "SIGKILL"), pid);
    // Wait for a different real utility PID, then invoke while startup may still be in flight.
    await page.waitForTimeout(100);
    let next;
    for (let i = 0; i < 50; i++) {
      next = await app.evaluate(({ app }) => app.getAppMetrics().find(m => m.name === "Agent Workspace Core")?.pid);
      if (next && next !== pid) break;
      await page.waitForTimeout(100);
    }
    assert.ok(next && next !== pid, "Core restarted with a new process");
    const state = await invoke("snapshot");
    assert.ok(state.sessions.some(s => s.id === sp.sessionId && s.generation === sp.generation));
    await invoke("session.attach", { ...sp, cols: 100, rows: 30 });
    await invoke("session.input", { ...sp, data: `printf '%s%s\\n' 'RECOVERY_${attempt}_' 'OK'\r` });
    for (let tick = 0; tick < 30; tick++) {
      if ((await invoke("session.capture", sp)).data.includes(`RECOVERY_${attempt}_OK`)) break;
      await page.waitForTimeout(100);
    }
    assert.match((await invoke("session.capture", sp)).data, new RegExp(`RECOVERY_${attempt}_OK`));
  }
  checks.push("three real core crashes automatically restart; same session and generation accept shell input");
  await app.evaluate(({ app }) => { const pid = app.getAppMetrics().find(m => m.name === "Agent Workspace Core")?.pid; if (!pid) throw new Error("Core PID missing"); process.kill(pid, "SIGKILL"); });
  await page.waitForTimeout(200);
  const before = Date.now();
  await assert.rejects(invoke("snapshot"), /Core stopped/);
  assert.ok(Date.now() - before < 2000, "Exhausted core fails promptly");
  await page.waitForTimeout(1200);
  assert.equal(await app.evaluate(({ app }) => app.getAppMetrics().filter(m => m.name === "Agent Workspace Core").length), 0);
  checks.push("fourth crash exhausts restart budget and rejects new requests promptly");
  await app.close();
  await launch();
  const recovered = (await invoke("snapshot")).sessions.find(s => s.id === sp.sessionId);
  assert.equal(recovered?.generation, sp.generation);
  await invoke("session.attach", { ...sp, cols: 100, rows: 30 });
  assert.match((await invoke("session.capture", sp)).data, /RECOVERY_2_OK/);
  await invoke("session.terminate", sp);
  checks.push("reopening after exhausted core recovers same persistent tmux session");
  console.log(JSON.stringify({ passed: true, fixture, checks }));
} finally {
  if (app) await app.close().catch(() => {});
  await cleanupFixture(fixture);
}
