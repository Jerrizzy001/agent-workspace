import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
// Fixture hooks prove the policy and Electron power API wiring, not real-provider hook delivery.
const fixture = await mkdtemp(path.join(tmpdir(), "agent-keep-awake-"));
const repo = path.join(fixture, "repo");
const bin = path.join(fixture, "bin");
const release = path.join(fixture, "release");
await mkdir(repo);
await mkdir(bin);
// A fixture `claude`: lists the flags the core probes for, reports a working turn
// through the UserPromptSubmit hook, then reports Stop once released (unless told to hold).
await writeFile(
  path.join(bin, "claude"),
  `#!${process.execPath}
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  process.stdout.write("Usage: claude [options]\\n  --session-id <uuid>\\n  --settings <file-or-json>\\n");
  process.exit(0);
}
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const run = (name) => execSync(settings.hooks[name][0].hooks[0].command, { stdio: "ignore" });
const hold = args.includes("hold");
process.stdout.write("fixture claude ready\\n");
run("UserPromptSubmit");
const timer = setInterval(() => {
  if (hold || !fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  run("Stop");
}, 100);
setInterval(() => {}, 1000);
`,
  { mode: 0o700 },
);
const env = {
  ...process.env,
  PATH: bin + path.delimiter + process.env.PATH,
  WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
};
const launch = () =>
  electron.launch({
    executablePath: process.env.WORKSPACE_APP_EXECUTABLE,
    args: process.env.WORKSPACE_APP_EXECUTABLE ? [] : ["."],
    env,
  });
let app = await launch();
let page = await app.firstWindow();
page.setDefaultTimeout(20000);
const checks = [];
const invoke = (command, payload = {}) =>
  page.evaluate(
    ({ command, payload }) => window.workspace.invoke(command, payload),
    { command, payload },
  );
const power = () => page.evaluate(() => window.workspace.power.status());
// Electron's own view of blockers (ids are small integers); independent of our status object.
const started = () =>
  app.evaluate(({ powerSaveBlocker }) =>
    [...Array(64).keys()].filter((id) => powerSaveBlocker.isStarted(id)),
  );
const statusText = (text) =>
  page.locator(".keep-awake-status").filter({ hasText: text }).waitFor();
const toggle = () =>
  page.getByRole("switch", { name: "Keep awake during agent work" });
const until = async (read, ok, label) => {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out: " + label);
};
try {
  await page.waitForFunction(() => !!window.workspace?.power);
  await page.getByRole("button", { name: "Settings and connections" }).click();
  await statusText("Off");
  assert.deepEqual(await power(), { enabled: false, active: false, sessions: [] });
  assert.equal(await toggle().isChecked(), false);
  assert.deepEqual(await started(), []);
  assert.equal(
    (await invoke("settings.read", { key: "keepAwake" })).value,
    false,
  );
  checks.push("off by default: unchecked switch, status Off, no blocker");

  // A foreign window can load the preload but must not change or read the power policy.
  const foreign = await app.evaluate(async ({ app, BrowserWindow }) => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload: `${app.getAppPath()}/dist/desktop/preload.cjs`, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await w.loadURL("data:text/html,foreign");
      return await w.webContents.executeJavaScript(
        "Promise.all([window.workspace.power.setEnabled(true), window.workspace.power.status()].map(p => p.then(() => 'unexpected success', e => e.message)))",
      );
    } finally { w.destroy(); }
  });
  for (const message of foreign) assert.match(message, /Invalid sender/);
  assert.deepEqual(await power(), { enabled: false, active: false, sessions: [] });
  checks.push("foreign window cannot read or enable keep-awake");

  const project = await invoke("project.add", { path: repo });
  await page.locator(".keep-awake").hover();
  const tooltip = await page.locator(".keep-awake").getAttribute("title");
  assert.match(tooltip, /display can still sleep/);
  assert.match(tooltip, /20 minutes/);
  await toggle().click();
  await statusText("On · idle");
  assert.deepEqual(await power(), { enabled: true, active: false, sessions: [] });
  assert.deepEqual(await started(), []);
  await assert.rejects(
    invoke("settings.write", { key: "keepAwake", value: false }),
    /power settings/,
  );
  checks.push("toggle on with no working agent: On · idle, still no blocker; renderer cannot bypass the power channel");

  const first = await invoke("terminal.open", {
    projectId: project.id,
    provider: "claude",
    idempotencyKey: "keep-awake-first",
  });
  await statusText("Keeping awake · 1 session working");
  const working = await power();
  assert.equal(working.active, true);
  assert.deepEqual(working.sessions, [first.session.id]);
  assert.equal((await started()).length, 1);
  const session = await until(
    async () => (await invoke("snapshot")).sessions.find((s) => s.id === first.session.id),
    (s) => s.activity === "running" && typeof s.activityAt === "number",
    "activityAt",
  );
  assert.ok(Math.abs(Date.now() - session.activityAt) < 60000);
  await page.screenshot({ path: path.join(fixture, "keeping-awake.png") });
  checks.push("UserPromptSubmit hook: snapshot has fresh activityAt, UI shows Keeping awake · 1 session working, one Electron blocker started");

  const second = await invoke("terminal.open", {
    projectId: project.id,
    provider: "claude",
    prompt: "hold",
    idempotencyKey: "keep-awake-second",
  });
  await statusText("Keeping awake · 2 sessions working");
  assert.equal((await started()).length, 1);
  checks.push("two working sessions share exactly one blocker");

  await writeFile(release, "");
  await statusText("Keeping awake · 1 session working");
  assert.deepEqual((await power()).sessions, [second.session.id]);
  assert.equal((await started()).length, 1);
  checks.push("Stop hook on one session releases only its demand");

  await toggle().click();
  await statusText("Off");
  assert.deepEqual(await started(), []);
  await toggle().click();
  await statusText("Keeping awake · 1 session working");
  assert.equal((await started()).length, 1);
  checks.push("turning the setting off releases while an agent still works; on again reacquires");

  // Quit releases; the setting and the still-working tmux session survive a restart.
  await app.evaluate(({ app }) => app.quit());
  await app.waitForEvent("close").catch(() => {});
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => !!window.workspace?.power);
  await page.getByRole("button", { name: "Settings and connections" }).click();
  await statusText("Keeping awake · 1 session working");
  assert.equal(await toggle().isChecked(), true);
  assert.deepEqual((await power()).sessions, [second.session.id]);
  assert.equal((await started()).length, 1);
  checks.push("after quit and relaunch the preference persists and the still-working session reacquires from the core snapshot");

  const p = { sessionId: second.session.id, generation: 1, viewerId: "keep-awake" };
  await invoke("session.attach", p);
  await invoke("session.terminate", p);
  await statusText("On · idle");
  assert.deepEqual(await started(), []);
  checks.push("ending the session releases the blocker");
  await page.screenshot({ path: path.join(fixture, "idle.png") });
  console.log(JSON.stringify({ passed: true, fixture, checks }));
} catch (error) {
  await page.screenshot({ path: path.join(fixture, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ passed: false, fixture, checks, error: String(error) }));
  process.exitCode = 1;
} finally {
  try {
    const state = await invoke("snapshot");
    for (const s of state.sessions.filter((s) => s.status === "running")) {
      const p = { sessionId: s.id, generation: s.generation, viewerId: "cleanup" };
      await invoke("session.attach", p);
      await invoke("session.terminate", p);
    }
  } catch {}
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await cleanupFixture(fixture);
}
