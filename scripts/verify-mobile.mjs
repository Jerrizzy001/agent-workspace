import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { cleanupFixture } from "./fixture-cleanup.mjs";

const fixture = await mkdtemp(path.join(tmpdir(), "aw-mobile-"));
const repo = path.join(fixture, "phone-project");
const screenshotDir = path.resolve("docs/screenshots/remote");
await mkdir(repo);
await mkdir(screenshotDir, { recursive: true });
await writeFile(path.join(repo, "hello.txt"), "Shared workspace file\n");
for (const args of [
  ["init", "-q"],
  ["config", "user.name", "Fixture"],
  ["config", "user.email", "fixture@example.invalid"],
  ["add", "."],
  ["commit", "-qm", "Fixture"],
])
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
const server = spawn(
  process.execPath,
  [
    "node_modules/tsx/dist/cli.mjs",
    "src/server/headless.ts",
    "--data-dir",
    path.join(fixture, "data"),
    "--port",
    "0",
    "--project",
    repo,
    "--static-dir",
    path.resolve("dist/renderer"),
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stderr.on("data", (data) => {
  serverLog += data;
});
let context;
let secondContext;
const checks = [];
const errors = [];
async function poll(check, label) {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out: " + label);
}
async function read(name) {
  return readFile(path.join(repo, name), "utf8");
}
async function noOverflow(page) {
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.body.scrollWidth <= innerWidth,
    ),
    true,
    "body must not horizontally overflow",
  );
}
async function openBrowser(profile = "browser-profile") {
  const executablePath =
    process.env.WORKSPACE_BROWSER ||
    (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined);
  const opened = await chromium.launchPersistentContext(
    path.join(fixture, profile),
    {
      executablePath,
      headless: true,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    },
  );
  return opened;
}
try {
  const info = await new Promise((resolve, reject) => {
    let output = "";
    server.stdout.on("data", (data) => {
      output += data;
      const first = output
        .split("\n")
        .find((line) => line.startsWith('{"service"'));
      if (first) resolve(JSON.parse(first));
    });
    server.once("exit", (code) =>
      reject(new Error(`Host exited ${code}: ${serverLog}`)),
    );
    setTimeout(
      () => reject(new Error("Host startup timed out: " + serverLog)),
      15000,
    ).unref();
  });
  const secret = (await readFile(info.pairingFile, "utf8")).trim();
  context = await openBrowser();
  let page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(info.url);
  await page.getByLabel("Pairing code", { exact: true }).waitFor();
  await page.screenshot({
    animations: "disabled",
    path: path.join(screenshotDir, "phone-pairing.png"),
  });
  await page.getByLabel("Pairing code", { exact: true }).fill("incorrect");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "not accepted" }).waitFor();
  await page.getByLabel("Pairing code", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Connected to workspace", { exact: true }).waitFor();
  await page
    .locator(".topbar-title h1")
    .filter({ hasText: "phone-project" })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        /token|secret|credential|password/i.test(key),
      ),
    ),
    false,
  );
  await noOverflow(page);
  checks.push(
    "pairing accepts owner secret, rejects incorrect secret; no credential localStorage",
  );

  // Planning is optional; check the phone modal fits, then launch with one tap.
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Board", exact: true })
    .click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByPlaceholder("What do you want to work on?")
    .fill("Continue from my phone");
  await page
    .getByPlaceholder("Add context, constraints, or an intended outcome.")
    .fill("Shared terminal, files and notes.");
  await noOverflow(page);
  const dialogBounds = await page.getByRole("dialog").boundingBox();
  assert.ok(dialogBounds.width <= 390 && dialogBounds.height <= 844);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(
    () =>
      document.querySelector(".modal").getBoundingClientRect().height <=
      innerHeight,
  );
  const landscapeDialog = await page.getByRole("dialog").boundingBox();
  assert.ok(landscapeDialog.width <= 844 && landscapeDialog.height <= 390);
  await noOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".modal")
    .getByRole("button", { name: "Create task", exact: true })
    .click();
  await page.getByRole("button", { name: "Close task details" }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await page.getByRole("button", { name: "Launch options" }).click();
  assert.equal(await page.getByLabel("Claude model").inputValue(), "");
  assert.equal(await page.getByLabel("Codex model").inputValue(), "");
  const options = await page.getByRole("dialog", { name: "Launch options" }).boundingBox();
  assert.ok(options.x >= 0 && options.x + options.width <= 390);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Shell here" }).click();
  await page.getByRole("button", { name: "Focus terminal keyboard" }).waitFor();
  await poll(
    () =>
      page.getByRole("button", { name: "Focus terminal keyboard" }).isEnabled(),
    "terminal attached",
  );
  await page.getByRole("button", { name: "Focus terminal keyboard" }).click();
  await page.keyboard.type(
    'printf "PHONE_PID=%s\\n" "$$" > mobile-pid.txt; printf "once\\n" >> phone-once.txt; printf "From phone\\n" > mobile-proof.txt',
  );
  await page
    .getByRole("button", { name: "Terminal Enter", exact: true })
    .click();
  await poll(
    async () => (await read("mobile-proof.txt")) === "From phone\n",
    "phone command creates file",
  );
  const originalPid = await read("mobile-pid.txt");
  const original = await page.evaluate(() =>
    window.workspace.invoke("snapshot"),
  );
  assert.equal(original.sessions.length, 1);
  assert.equal(original.attempts.length, 0);
  checks.push(
    "390×844 touch layout: task modal fits portrait/landscape; launch options default to CLI models; one tap opens a shell with no task; terminal input creates server file",
  );

  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await page
    .getByPlaceholder("Paste text here…")
    .fill('printf "Pasted text\\n" > mobile-paste.txt\n');
  await page.getByRole("button", { name: "Send text", exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(read("mobile-paste.txt"), { code: "ENOENT" });
  await page
    .getByRole("button", { name: "Terminal Enter", exact: true })
    .click();
  await poll(
    async () => (await read("mobile-paste.txt")) === "Pasted text\n",
    "explicit terminal paste",
  );
  await page
    .getByRole("button", { name: "Terminal Ctrl C", exact: true })
    .click();
  for (const [mode, expected, marker] of [
    ["h", "1b4f41", "APPLICATION_READY"],
    ["l", "1b5b41", "NORMAL_READY"],
  ]) {
    await page.getByRole("button", { name: "Focus terminal keyboard" }).click();
    await page.keyboard.type(
      `python3 -c 'import sys,tty,termios; f=sys.stdin.fileno(); old=termios.tcgetattr(f); tty.setraw(f); sys.stdout.write("\\033[?1${mode}" + "${marker.split("_")[0]}_" + "READY\\r\\n"); sys.stdout.flush(); data=sys.stdin.buffer.read(3); termios.tcsetattr(f,termios.TCSADRAIN,old); sys.stdout.write("\\033[?1l"); print("CURSOR_BYTES="+data.hex())'`,
    );
    await page
      .getByRole("button", { name: "Terminal Enter", exact: true })
      .click();
    await page.waitForFunction(
      (value) =>
        document.querySelector(".xterm-screen")?.textContent?.includes(value),
      marker,
    );
    await page.getByRole("button", { name: "Terminal ↑", exact: true }).click();
    await page.waitForFunction(
      (value) =>
        document.querySelector(".xterm-screen")?.textContent?.includes(value),
      "CURSOR_BYTES=" + expected,
    );
  }
  await noOverflow(page);
  await page.screenshot({
    animations: "disabled",
    path: path.join(screenshotDir, "phone-terminal-portrait.png"),
  });
  checks.push(
    "touch keyboard focus, Enter and Ctrl C work; bracketed multiline paste waits for Enter; arrow keys honor application and normal cursor modes",
  );

  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Folders", exact: true })
    .click();
  await page
    .locator(".sidebar .session-row")
    .filter({ hasText: "Shell" })
    .waitFor({ state: "visible" });
  await page.screenshot({
    animations: "disabled",
    path: path.join(screenshotDir, "phone-project-drawer.png"),
  });
  await page
    .locator(".sidebar .session-row")
    .filter({ hasText: "Shell" })
    .click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await page
    .locator(".panel-tabs")
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await page
    .getByRole("button", { name: "mobile-proof.txt", exact: true })
    .click();
  await page.locator(".editor-overlay").waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".monaco-editor .view-lines")
      ?.textContent?.replace(/\u00a0/g, " ")
      .includes("From phone"),
  );
  await noOverflow(page);
  await page.screenshot({
    animations: "disabled",
    path: path.join(screenshotDir, "phone-files.png"),
  });
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Board", exact: true })
    .click();
  assert.equal(
    await page
      .locator(".board")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
    true,
  );
  await noOverflow(page);
  await page.screenshot({
    animations: "disabled",
    path: path.join(screenshotDir, "phone-board.png"),
  });
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.evaluate(() => {
    const invoke = window.workspace.invoke.bind(window.workspace);
    globalThis.__restoreNoteInvoke = () => {
      window.workspace.invoke = invoke;
    };
    window.workspace.invoke = async (command, payload) => {
      if (command === "snapshot" && globalThis.__staleNoteSnapshot) {
        const snapshot = globalThis.__staleNoteSnapshot;
        globalThis.__staleNoteSnapshot = undefined;
        globalThis.__staleNoteReloaded = true;
        return snapshot;
      }
      const result = await invoke(command, payload);
      if (command === "note.update")
        await new Promise((resolve) => setTimeout(resolve, 600));
      return result;
    };
  });
  const canvasNote = page.getByLabel("Canvas note");
  await canvasNote.fill("The same workspace note,");
  await poll(
    async () =>
      (await page.evaluate(() => window.workspace.invoke("snapshot"))).notes[0]
        ?.body === "The same workspace note,",
    "first note snapshot before delayed acknowledgement",
  );
  const firstNoteSnapshot = await page.evaluate(() =>
    window.workspace.invoke("snapshot"),
  );
  assert.equal(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
    "pending note protects a canceled unload",
  );
  await canvasNote.focus();
  await canvasNote.evaluate((element) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.type(" written from a phone viewport");
  const continuedNote =
    "The same workspace note, written from a phone viewport";
  await page.evaluate(
    (snapshot) => window.workspace.emit({ type: "snapshot", snapshot }),
    firstNoteSnapshot,
  );
  assert.equal(await canvasNote.inputValue(), continuedNote);
  await poll(
    async () =>
      (await page.evaluate(() => window.workspace.invoke("snapshot"))).notes[0]
        ?.body === continuedNote,
    "continued note serializes after first acknowledgement",
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.evaluate(
    (snapshot) => window.workspace.emit({ type: "snapshot", snapshot }),
    firstNoteSnapshot,
  );
  assert.equal(
    await canvasNote.inputValue(),
    continuedNote,
    "stale acknowledged snapshot cannot revert the local draft",
  );
  assert.equal(
    (await page.evaluate(() => window.workspace.invoke("snapshot"))).notes[0]
      .body,
    continuedNote,
  );
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByLabel("Canvas note").waitFor();
  assert.equal(
    await page.getByLabel("Canvas note").inputValue(),
    continuedNote,
    "a note remount cannot initialize from an older snapshot",
  );
  await page.evaluate((snapshot) => {
    globalThis.__staleNoteSnapshot = snapshot;
    window.workspace.emit({ type: "core.status", status: "ready" });
  }, firstNoteSnapshot);
  await page.waitForFunction(() => globalThis.__staleNoteReloaded);
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  assert.equal(
    await canvasNote.inputValue(),
    continuedNote,
    "a stale reload cannot rebind an older note on remount",
  );
  await page.evaluate(() => globalThis.__restoreNoteInvoke());
  const latestNoteSnapshot = await page.evaluate(() =>
    window.workspace.invoke("snapshot"),
  );
  assert.equal(latestNoteSnapshot.notes[0].body, continuedNote);
  await page.evaluate((snapshot) => {
    window.workspace.emit({
      type: "snapshot",
      snapshot: { ...snapshot, notes: [] },
    });
  }, latestNoteSnapshot);
  await canvasNote.waitFor({ state: "detached" });
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  assert.equal(await canvasNote.count(), 0, "removed notes stay removed on remount");
  await page.evaluate(
    (snapshot) => window.workspace.emit({ type: "snapshot", snapshot }),
    latestNoteSnapshot,
  );
  await canvasNote.waitFor();
  assert.equal(await canvasNote.inputValue(), continuedNote);
  checks.push(
    "delayed note acknowledgements, canceled unload, stale event/reload snapshots and canvas remounts preserve exact visible/durable text; removed notes stay removed",
  );
  await canvasNote.focus();
  await canvasNote.evaluate((element) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.type(".");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Pairing code", { exact: true }).waitFor();
  await page.getByLabel("Pairing code", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Connected to workspace", { exact: true }).waitFor();
  await poll(
    async () =>
      (
        await page.evaluate(() => window.workspace.invoke("snapshot"))
      ).notes[0]?.body === continuedNote + ".",
    "pending note flush before explicit sign out",
  );
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  assert.equal(await canvasNote.inputValue(), continuedNote + ".");
  checks.push(
    "manual sign out flushes the latest pending canvas note before revoking access",
  );
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  checks.push(
    "touch project/task drawer, files editor, horizontally scrolling board and persistent canvas note",
  );

  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(
    () =>
      document.querySelector(".mobile-navigation").getBoundingClientRect()
        .bottom <=
      innerHeight + 1,
  );
  await poll(
    () =>
      page.getByRole("button", { name: "Focus terminal keyboard" }).isEnabled(),
    "landscape terminal",
  );
  await noOverflow(page);
  const terminalBounds = await page.locator(".terminal-host").boundingBox();
  assert.ok(
    terminalBounds.height >= 80,
    "landscape leaves a usable focused terminal",
  );
  await page.screenshot({
    animations: "disabled",
    path: path.join(screenshotDir, "phone-terminal-landscape.png"),
  });
  await page.setViewportSize({ width: 390, height: 560 });
  await noOverflow(page);
  await page.getByRole("button", { name: "Focus terminal keyboard" }).click();
  assert.equal(
    await page
      .locator(".xterm-helper-textarea")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  checks.push(
    "portrait, landscape and keyboard-height viewport resizing preserve terminal focus and prevent body overflow",
  );

  await context.setOffline(true);

  try {
    await page
      .getByText("Reconnecting · input paused", { exact: true })
      .waitFor();
  } catch (error) {
    console.log(
      await page.evaluate(() => ({
        online: navigator.onLine,
        text: document.body.innerText.slice(0, 500),
      })),
    );
    throw error;
  }
  assert.equal(
    await page
      .getByRole("button", { name: "Terminal Enter", exact: true })
      .isEnabled(),
    false,
  );
  const rejected = await page.evaluate(async () => {
    try {
      await window.workspace.invoke("session.input", { data: "UNSENT" });
      return false;
    } catch (error) {
      return String(error).includes("Nothing was queued");
    }
  });
  assert.equal(rejected, true);
  await context.setOffline(false);
  await page.getByText("Connected to workspace", { exact: true }).waitFor();
  await poll(
    () =>
      page.getByRole("button", { name: "Focus terminal keyboard" }).isEnabled(),
    "reattach after network drop",
  );
  assert.equal(await read("phone-once.txt"), "once\n");
  const afterReconnect = await page.evaluate(() =>
    window.workspace.invoke("snapshot"),
  );
  assert.equal(afterReconnect.sessions[0].id, original.sessions[0].id);
  assert.equal(
    afterReconnect.sessions[0].generation,
    original.sessions[0].generation,
  );
  assert.equal(afterReconnect.sessions.length, 1);
  checks.push(
    "network loss pauses input, rejects unsent commands, reattaches same generation and never relaunches/replays",
  );

  await context.close();
  context = await openBrowser();
  page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(info.url);
  await page.getByText("Connected to workspace", { exact: true }).waitFor();
  await page
    .locator(".session-identity strong")
    .filter({ hasText: "Shell" })
    .waitFor();
  await poll(
    () =>
      page.getByRole("button", { name: "Focus terminal keyboard" }).isEnabled(),
    "browser restart reattaches selected session",
  );
  await page.getByRole("button", { name: "Focus terminal keyboard" }).click();
  await page.keyboard.type(
    'printf "PHONE_PID=%s\\n" "$$" > after-restart-pid.txt',
  );
  await page
    .getByRole("button", { name: "Terminal Enter", exact: true })
    .click();
  await poll(
    async () => (await read("after-restart-pid.txt")) === originalPid,
    "same PID after browser restart",
  );
  assert.equal(await read("phone-once.txt"), "once\n");
  const afterRestart = await page.evaluate(() =>
    window.workspace.invoke("snapshot"),
  );
  assert.equal(afterRestart.sessions.length, 1);
  assert.equal(
    afterRestart.notes[0].body,
    "The same workspace note, written from a phone viewport.",
  );
  checks.push(
    "full Chromium profile close/reopen restores cookie authentication, selected session, original process PID and note without a duplicate launch",
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await noOverflow(page);
  assert.equal(await page.locator(".sidebar").isVisible(), true);
  assert.equal(await page.locator(".review-panel").isVisible(), true);
  await page.screenshot({
    animations: "disabled",
    path: path.join(screenshotDir, "browser-desktop.png"),
  });
  secondContext = await openBrowser("second-viewer");
  const second = secondContext.pages()[0] || (await secondContext.newPage());
  second.setDefaultTimeout(15000);
  await second.goto(info.url);
  await second.getByLabel("Pairing code", { exact: true }).fill(secret);
  await second.getByRole("button", { name: "Connect", exact: true }).click();
  await second.getByText("Connected to workspace", { exact: true }).waitFor();
  await second
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Folders", exact: true })
    .click();
  await second
    .locator(".sidebar .session-row")
    .filter({ hasText: "Shell" })
    .click();
  await poll(
    () =>
      second
        .getByRole("button", { name: "Focus terminal keyboard" })
        .isEnabled(),
    "second browser viewer attached",
  );
  await second.setViewportSize({ width: 1440, height: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.evaluate(() => {
    globalThis.__resyncs = 0;
    globalThis.__transportDisconnects = 0;
    globalThis.__holdAcks = true;
    const invoke = window.workspace.invoke.bind(window.workspace);
    window.workspace.invoke = (command, payload) => {
      if (command === "session.ack" && globalThis.__holdAcks)
        return Promise.resolve({ ok: true });
      return invoke(command, payload);
    };
    window.workspace.subscribe((event) => {
      if (event.type === "terminal.resync") {
        globalThis.__resyncs++;
        globalThis.__holdAcks = false;
      }
      if (event.type === "core.status" && event.status === "restarting")
        globalThis.__transportDisconnects++;
    });
  });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(
    `python3 -c 'import sys,time; [(sys.stdout.write("remote %05d " % i + "x"*40 + "\\n"),sys.stdout.flush(),time.sleep(0.0001)) for i in range(10000)]; print("REMOTE_"+"BURST_COMPLETE")'`,
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector(".xterm-screen")
      ?.textContent?.includes("REMOTE_BURST_COMPLETE"),
  );
  await second.waitForFunction(() =>
    document
      .querySelector(".xterm-screen")
      ?.textContent?.includes("REMOTE_BURST_COMPLETE"),
  );
  await poll(
    async () => (await page.evaluate(() => globalThis.__resyncs)) > 0,
    "actual terminal.resync event over WebSocket",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const capture = await page.evaluate(
    ({ sessionId, generation }) =>
      window.workspace.invoke("session.capture", { sessionId, generation }),
    {
      sessionId: original.sessions[0].id,
      generation: original.sessions[0].generation,
    },
  );
  const rendered = await page.locator(".xterm-screen").innerText();
  const actualRows = [...rendered.matchAll(/remote\s+(\d{5})/g)].map((match) =>
    Number(match[1]),
  );
  const backendRows = [...capture.data.matchAll(/remote\s+(\d{5})/g)].map(
    (match) => Number(match[1]),
  );
  assert.ok(actualRows.length > 5, "burst leaves visible rows");
  assert.equal(new Set(actualRows).size, actualRows.length);
  assert.deepEqual(
    actualRows,
    backendRows.slice(-actualRows.length),
    "visible browser rows match final backend rows after resync",
  );
  assert.equal(
    await page.evaluate(() => globalThis.__transportDisconnects),
    0,
    "ACK bursts must not disconnect the transport",
  );
  assert.equal(await page.locator(".terminal-wrap [role=alert]").count(), 0);
  const burstMetrics = {
    renderedRows: actualRows.length,
    firstRow: actualRows[0],
    lastRow: actualRows.at(-1),
    resyncEvents: await page.evaluate(() => globalThis.__resyncs),
    transportDisconnects: await page.evaluate(
      () => globalThis.__transportDisconnects,
    ),
  };
  await second.locator(".xterm-helper-textarea").focus();
  await second.keyboard.type('printf "After burst\\n" > post-burst.txt');
  await second.keyboard.press("Enter");
  await poll(
    async () => (await read("post-burst.txt")) === "After burst\n",
    "second viewer input after burst",
  );
  await secondContext.close();
  secondContext = undefined;
  checks.push(
    "two browsers share one terminal; 10000-line output triggers real WS resync, final visible rows match tmux, ACKs stay bounded without disconnect and subsequent typing works",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await page
    .locator(".panel-tabs")
    .getByRole("button", { name: "Worktrees", exact: true })
    .click();
  await page
    .getByLabel("New worktree branch", { exact: true })
    .fill("phone-review");
  await page
    .getByRole("button", { name: "Create worktree", exact: true })
    .click();
  await page
    .locator(".worktree-card")
    .filter({ hasText: "phone-review" })
    .waitFor();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Board", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue from my phone", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start an attempt", exact: true })
    .click();
  const worktreeOption = await page
    .getByLabel("Working directory")
    .locator("option")
    .filter({ hasText: "phone-review" })
    .getAttribute("value");
  await page.getByLabel("Working directory").selectOption(worktreeOption);
  await page
    .locator(".modal")
    .getByRole("button", { name: "Start attempt", exact: true })
    .click();
  await poll(
    () =>
      page.getByRole("button", { name: "Focus terminal keyboard" }).isEnabled(),
    "worktree attempt attached",
  );
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await page
    .locator(".panel-tabs")
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await page.getByRole("button", { name: "hello.txt", exact: true }).click();
  await page.locator(".editor-overlay").waitFor();
  assert.equal(
    await page.locator(".error-banner").count(),
    0,
    "worktree scoped review should not reject valid payload fields",
  );
  await page
    .locator(".monaco-editor textarea")
    .first()
    .waitFor({ state: "attached" });
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Worktree edit from phone\n", { delay: 4 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await poll(
    async () =>
      (await readFile(path.join(worktreeOption, "hello.txt"), "utf8")) ===
      "Worktree edit from phone\n",
    "remote selected-worktree file save",
  );
  assert.equal(
    await read("hello.txt"),
    "Shared workspace file\n",
    "worktree save preserves main repository file",
  );
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page
    .locator(".panel-tabs")
    .getByRole("button", { name: /^Changes/ })
    .click();
  await page
    .getByRole("button", { name: "Refresh files and git", exact: true })
    .click();
  await page
    .locator(".file-row > button:first-child")
    .filter({ hasText: "hello.txt" })
    .click();
  await page
    .locator(".editor-overlay")
    .getByText("Selected diff", { exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".monaco-editor .view-lines")
      ?.textContent?.replace(/\u00a0/g, " ")
      .includes("Worktree edit from phone"),
  );
  assert.equal(
    await page.locator(".error-banner").count(),
    0,
    "remote git.diff payload accepted",
  );
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  checks.push(
    "mobile worktree creation, scoped file read/save and tracked diff use valid remote command scopes; main repository file is preserved",
  );

  await page.waitForFunction(async () =>
    Boolean(await navigator.serviceWorker.getRegistration()),
  );
  const cachedPaths = await page.evaluate(async () => {
    const names = await caches.keys();
    const requests = (
      await Promise.all(
        names.map(async (name) => (await caches.open(name)).keys()),
      )
    ).flat();
    return requests.map((request) => new URL(request.url).pathname);
  });
  assert.equal(
    cachedPaths.some(
      (name) =>
        name.startsWith("/api/") || name === "/" || name.endsWith(".html"),
    ),
    false,
  );
  assert.equal(
    (await page.request.get(info.url + "/manifest.webmanifest")).status(),
    200,
  );
  checks.push(
    "wide browser retains desktop layout; PWA manifest and worker available; cache contains no HTML/API/private workspace responses",
  );
  await page
    .locator(".panel-tabs")
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await page.getByRole("button", { name: "hello.txt", exact: true }).click();
  await page
    .locator(".monaco-editor textarea")
    .first()
    .waitFor({ state: "attached" });
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Unsaved editor draft", { delay: 4 });
  await poll(
    () => page.getByRole("button", { name: "Save", exact: true }).isEnabled(),
    "editor draft dirty",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByText("Connected to workspace", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save", exact: true }).isEnabled(),
    true,
  );
  assert.equal(
    (await (await page.request.get(info.url + "/api/status")).json())
      .authenticated,
    true,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Pairing code", { exact: true }).waitFor();
  assert.equal(await page.locator(".task-heading").count(), 0);
  checks.push(
    "dirty editor sign out cancel keeps pairing and draft; accepting discards draft and clears private UI",
  );
  const status = await (
    await page.request.get(info.url + "/api/status")
  ).json();
  assert.equal(status.authenticated, false);
  checks.push(
    "sign out revokes cookie access and removes private workspace UI",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(screenshotDir, "mobile-verification.json"),
    JSON.stringify(
      {
        platform: `Playwright driving ${process.env.WORKSPACE_BROWSER ? "Chromium at " + process.env.WORKSPACE_BROWSER : "installed Google Chrome (Chromium)"} on ${process.platform}; synthetic touch phone viewports, not a physical iOS/Android device`,
        browserVersion: context.browser()?.version(),
        passed: checks,
        burst: burstMetrics,
        screenshots: [
          "phone-pairing.png",
          "phone-terminal-portrait.png",
          "phone-project-drawer.png",
          "phone-files.png",
          "phone-board.png",
          "phone-terminal-landscape.png",
          "browser-desktop.png",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ passed: checks.length, checks, screenshotDir }, null, 2),
  );
} finally {
  await secondContext?.close();
  await context?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null)
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await once(server, "exit");
  }
  await cleanupFixture(fixture);
  await rm(fixture, { recursive: true, force: true });
}
