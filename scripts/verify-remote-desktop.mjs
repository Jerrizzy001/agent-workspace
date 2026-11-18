import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron, chromium } from "playwright";
import { WebSocket } from "ws";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const fixture = await mkdtemp(path.join(tmpdir(), "workspace-remote-desktop-"));
const repo = path.join(fixture, "repo");
await mkdir(repo);
await writeFile(path.join(repo, "hello.txt"), "fixture\n");
for (const args of [
  ["init"],
  ["config", "user.name", "Fixture"],
  ["config", "user.email", "fixture@example.invalid"],
  ["add", "."],
  ["commit", "-m", "fixture"],
])
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
let app, client, browser;
const checks = [];
try {
  app = await electron.launch({
    ...(process.env.WORKSPACE_APP_EXECUTABLE
      ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
      : { args: ["."] }),
    env: {
      ...process.env,
      WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.workspace?.remote);
  page.setDefaultTimeout(20000);
  const invoke = (command, payload = {}) =>
    page.evaluate(
      ({ command, payload }) => window.workspace.invoke(command, payload),
      { command, payload },
    );
  const manage = (action, value) =>
    page.evaluate(
      ({ action, value }) => window.workspace.remote[action](value),
      { action, value },
    );
  await invoke("snapshot");
  assert.equal((await manage("status")).enabled, false);
  await assert.rejects(
    manage("enable", { host: "0.0.0.0", port: 4318, tls: false }),
    /requires TLS/,
  );
  const foreign = await app.evaluate(async ({ app, BrowserWindow }) => {
    const w = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: `${app.getAppPath()}/dist/desktop/preload.cjs`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      await w.loadURL("data:text/html,foreign");
      return await w.webContents.executeJavaScript(
        "window.workspace.remote.pairingSecret().then(()=> 'bad',e=>e.message)",
      );
    } finally {
      w.destroy();
    }
  });
  assert.match(foreign, /Invalid sender/);
  checks.push(
    "default-off gateway, network TLS enforcement and owner-only management IPC",
  );
  const project = await invoke("project.add", { path: repo });
  const task = await invoke("task.create", {
    projectId: project.id,
    title: "Remote continuity",
  });
  const attempt = await invoke("attempt.start", {
    taskId: task.id,
    provider: "shell",
    idempotencyKey: "remote-continuity",
  });
  const local = {
    sessionId: attempt.session.id,
    generation: attempt.session.generation,
    viewerId: "desktop",
  };
  await invoke("session.attach", { ...local, cols: 100, rows: 30 });
  const enabled = await manage("enable", {
    host: "127.0.0.1",
    port: 0,
    tls: false,
    projectIds: [project.id],
  });
  const origin = enabled.url;
  assert.equal(enabled.coreStatus, "ready");
  const status = await (await fetch(origin + "/api/status")).json();
  assert.equal(status.authenticated, false);
  await new Promise((resolve, reject) => {
    const denied = new WebSocket(origin.replace("http", "ws") + "/api/ws", {
      origin,
    });
    denied.once("unexpected-response", (_, res) => {
      assert.equal(res.statusCode, 403);
      resolve();
    });
    denied.once("open", () =>
      reject(new Error("Unauthenticated socket opened")),
    );
    denied.once("error", () => {});
  });
  await page.getByRole("button", { name: "Settings and connections" }).click();
  await page.getByRole("button", { name: "Remote access settings" }).click();
  await page.getByRole("heading", { name: "Remote access" }).waitFor();
  await page.getByRole("group", { name: "1. Choose folders" }).waitFor();
  assert.equal(await page.locator(".remote-secret").count(), 0);
  assert.equal(
    await page.getByLabel("Public browser address").inputValue(),
    "",
  );
  await page
    .locator("label")
    .filter({ hasText: "Open on this computer" })
    .locator("output")
    .waitFor();
  await page.screenshot({ path: path.join(fixture, "remote-settings.png") });
  await page.getByRole("button", { name: "Close remote access" }).click();
  const code = await manage("pairingSecret");
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ secret: code }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WORKSPACE_BROWSER
      ? { executablePath: process.env.WORKSPACE_BROWSER }
      : { channel: process.env.WORKSPACE_BROWSER_CHANNEL || "chrome" }),
  });
  const browserPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const browserErrors = [];
  browserPage.on("pageerror", (error) => browserErrors.push(error.message));
  await browserPage.goto(origin);
  await browserPage.getByLabel("Pairing code").fill(code);
  await browserPage
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await browserPage
    .getByText("Connected to workspace", { exact: true })
    .waitFor();
  const browserState = await browserPage.evaluate(() =>
    window.workspace.invoke("snapshot"),
  );
  assert.ok(
    browserState.sessions.some(
      (s) => s.id === local.sessionId && s.generation === local.generation,
    ),
  );
  // Dictation is desktop-only: no API, no controls and no microphone in a paired browser.
  assert.equal(
    await browserPage.evaluate(() => "dictation" in window.workspace),
    false,
  );
  assert.equal(
    await browserPage
      .locator(".dictation-toggle, .dictation-indicator")
      .count(),
    0,
  );
  assert.equal(
    await browserPage
      .getByRole("button", { name: "Voice dictation settings" })
      .count(),
    0,
  );
  assert.equal(
    await browserPage
      .evaluate(
        () =>
          navigator.mediaDevices?.getUserMedia({ audio: true }).then(
            () => "granted",
            (e) => e.name,
          ) ?? "unavailable",
      )
      .then((v) => v === "granted"),
    false,
  );
  assert.deepEqual(browserErrors, []);
  checks.push(
    "desktop serves its bundled browser assets; phone-sized Chrome pairs against the same desktop core; no dictation API, controls or microphone there",
  );

  client = new WebSocket(origin.replace("http", "ws") + "/api/ws", {
    origin,
    headers: { cookie },
  });
  const pending = new Map();
  const events = [];
  let sequence = 0;
  client.on("message", (bytes) => {
    const m = JSON.parse(bytes);
    if (m.type === "event") events.push(m.event);
    if (m.type === "result") {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    }
  });
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const rpc = (command, payload = {}) =>
    new Promise((resolve, reject) => {
      const id = String(++sequence),
        timer = setTimeout(() => reject(new Error("RPC timeout")), 20000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      client.send(
        JSON.stringify({ type: "rpc", version: 1, id, command, payload }),
      );
    });
  const state = await rpc("snapshot");
  assert.ok(
    state.sessions.some(
      (s) => s.id === local.sessionId && s.generation === local.generation,
    ),
  );
  const remote = { ...local, viewerId: "browser" };
  await rpc("session.attach", { ...remote, cols: 90, rows: 25 });
  await rpc("session.input", {
    ...remote,
    data: "printf 'REMOTE_PID=%s\\n' \"$$\"\r",
  });
  for (let i = 0; i < 50; i++) {
    if (/REMOTE_PID=\d+/.test((await invoke("session.capture", local)).data))
      break;
    await page.waitForTimeout(80);
  }
  const localCapture = (await invoke("session.capture", local)).data;
  const pid = localCapture.match(/REMOTE_PID=(\d+)/)?.[1];
  assert.ok(pid);
  assert.match(
    (
      await rpc("session.capture", {
        sessionId: local.sessionId,
        generation: local.generation,
      })
    ).data,
    new RegExp("REMOTE_PID=" + pid),
  );
  checks.push(
    "remote authenticated browser protocol shares desktop session ID, generation, actual shell PID and terminal bytes",
  );
  const corePid = await app.evaluate(
    ({ app }) =>
      app.getAppMetrics().find((m) => m.name === "Agent Workspace Core")?.pid,
  );
  assert.ok(corePid);
  await app.evaluate((_, pid) => process.kill(pid, "SIGKILL"), corePid);
  for (let i = 0; i < 60; i++) {
    if (events.some((e) => e.type === "core.status" && e.status === "ready"))
      break;
    await page.waitForTimeout(100);
  }
  assert.ok(
    events.some((e) => e.type === "core.status" && e.status === "restarting"),
  );
  assert.ok(
    events.some((e) => e.type === "core.status" && e.status === "ready"),
  );
  await rpc("session.attach", { ...remote, cols: 90, rows: 25 });
  assert.match(
    (
      await rpc("session.capture", {
        sessionId: local.sessionId,
        generation: local.generation,
      })
    ).data,
    new RegExp("REMOTE_PID=" + pid),
  );
  checks.push(
    "gateway broadcasts core reconnect/recovery and reconnects the same persistent shell",
  );
  const closed = new Promise((resolve) => client.once("close", resolve));
  await manage("revokeSessions");
  await closed;
  await browserPage.getByLabel("Pairing code").waitFor();
  assert.equal(await browserPage.locator(".app-shell").count(), 0);
  assert.notEqual(await manage("pairingSecret"), code);
  assert.equal(
    (
      await (
        await fetch(origin + "/api/status", { headers: { cookie } })
      ).json()
    ).authenticated,
    false,
  );
  checks.push(
    "revoke closes the active WebSocket, expires browser access and rotates pairing",
  );
  await manage("disable");
  assert.equal((await manage("status")).enabled, false);
  assert.match(
    (await invoke("session.capture", local)).data,
    new RegExp("REMOTE_PID=" + pid),
  );
  await invoke("session.attach", { ...local, cols: 100, rows: 30 });
  await invoke("session.input", {
    ...local,
    data: "printf '%s%s\\n' 'DESKTOP_AFTER_' 'STOP'\r",
  });
  for (let i = 0; i < 30; i++) {
    if (
      (await invoke("session.capture", local)).data.includes(
        "DESKTOP_AFTER_STOP",
      )
    )
      break;
    await page.waitForTimeout(100);
  }
  assert.match(
    (await invoke("session.capture", local)).data,
    /DESKTOP_AFTER_STOP/,
  );
  await invoke("session.terminate", local);
  checks.push(
    "stopping remote gateway detaches browsers while desktop shell stays alive",
  );
  await manage("enable", {
    host: "127.0.0.1",
    port: 0,
    tls: false,
    projectIds: [project.id],
  });
  await app.close();
  app = await electron.launch({
    ...(process.env.WORKSPACE_APP_EXECUTABLE
      ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
      : { args: ["."] }),
    env: {
      ...process.env,
      WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
    },
  });
  const reopenedPage = await app.firstWindow();
  await reopenedPage.waitForFunction(() => !!window.workspace?.remote);
  assert.equal(
    (await reopenedPage.evaluate(() => window.workspace.remote.status()))
      .enabled,
    false,
  );
  checks.push(
    "quitting an enabled gateway and reopening the same desktop data leaves remote access off",
  );
  console.log(JSON.stringify({ passed: true, fixture, checks }));
} finally {
  client?.terminate();
  await browser?.close();
  if (app) await app.close().catch(() => {});
  await cleanupFixture(fixture);
}
