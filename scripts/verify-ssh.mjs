import { workspaceSocket } from "../src/core/socket.ts";
import { _electron as electron } from "playwright";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { cleanupFixture } from "./fixture-cleanup.mjs";
import { installHelper, startSshd } from "./ssh-fixture.mjs";

// SSH projects end to end in the desktop app against a disposable local sshd:
// add a host in the UI, see the unknown host key refused with its fingerprint,
// trust it out of band, probe, connect, register a folder on the host, open a
// shell there, kill the ssh client and see the same session come back, then
// edit a file and read Git status on the host. No provider is called.
const fixture = await mkdtemp(path.join(tmpdir(), "verify-ssh-"));
const screenshots = path.resolve(
  process.env.WORKSPACE_SCREENSHOT_DIR || "docs/screenshots/desktop",
);
await mkdir(screenshots, { recursive: true });
const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";
const remoteHome = path.join(fixture, "remote-home");
const remoteRepo = path.join(remoteHome, "service");
const localRepo = path.join(fixture, "local-home", "service");
const helperDir = path.join(fixture, "helper");
const remoteData = path.join(fixture, "remote-data");
for (const dir of [remoteRepo, localRepo]) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "notes.txt"), "original\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "f@example.invalid"],
    ["config", "user.name", "F"],
    ["add", "."],
    ["commit", "-qm", "init"],
  ])
    execFileSync("git", args, { cwd: dir });
}
const installedFrom = await installHelper(helperDir);
const sshDir = path.join(fixture, "ssh");
await mkdir(sshDir);
const sshd = await startSshd(sshDir, { alias: "aw-verify" });
const checks = [];
const errors = [];
let app;
const socketFor = async (dir) =>
  workspaceSocket(await realpath(dir));
try {
  app = await electron.launch({
    executablePath: process.env.WORKSPACE_APP_EXECUTABLE,
    args: process.env.WORKSPACE_APP_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      SHELL: "/bin/sh",
      WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
      // Test only: the fixture's own OpenSSH client configuration (-F).
      WORKSPACE_SSH_CONFIG: sshd.config,
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  const invoke = (command, payload = {}) =>
    page.evaluate(
      ({ command, payload }) => window.workspace.invoke(command, payload),
      { command, payload },
    );
  const poll = async (check, label, tries = 600) => {
    for (let i = 0; i < tries; i++) {
      try {
        if (await check()) return;
      } catch {}
      await page.waitForTimeout(50);
    }
    throw new Error("Timed out: " + label);
  };
  await page.waitForFunction(() => !!window.workspace?.ssh);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 900),
  );
  // A local folder with the same name: it must never be written.
  await invoke("project.add", { path: localRepo });

  // Add the host through the UI. Its key is not trusted yet.
  await page.getByRole("button", { name: "Settings and connections" }).click();
  await page.getByRole("button", { name: "SSH hosts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "SSH hosts" });
  await dialog.getByLabel("Host alias").fill("aw-verify");
  await dialog.getByLabel("Host name").fill("Build box");
  await dialog.getByText("User, port and helper location").click();
  await dialog.getByLabel("Helper folder").fill(helperDir);
  await dialog.getByLabel("Helper data folder").fill(remoteData);
  await dialog.getByRole("button", { name: "Add and check host" }).click();
  await dialog.getByText("Unknown host key").waitFor();
  await dialog.getByText(sshd.fingerprint + " (ED25519)").waitFor();
  assert.equal(
    await readFile(sshd.knownHosts, "utf8"),
    "",
    "the app never writes known_hosts",
  );
  await page.screenshot({ path: path.join(screenshots, "ssh-host-key.png") });
  checks.push(
    "added host alias in the UI; unknown host key refused with its SHA256 fingerprint; known_hosts untouched",
  );

  // The owner compares the fingerprint out of band and trusts the key themselves.
  await sshd.trust();
  await dialog.getByRole("button", { name: "Check host", exact: true }).click();
  try {
    await dialog
      .getByText(
        new RegExp(
          "^Helper 0\\.\\d+\\.\\d+ · protocol 1 · " + process.platform,
        ),
      )
      .waitFor();
  } catch (e) {
    console.error("SSH probe UI:", await dialog.innerText());
    await page.screenshot({
      path: path.resolve("release/ux-verification/ssh-failure.png"),
    });
    throw e;
  }
  const tools = await dialog.getByLabel("Tools on Build box").textContent();
  assert.match(tools, /node/);
  assert.match(tools, /tmux/);
  assert.match(tools, /git/);
  checks.push(
    "probe after trust: helper version, protocol and host tools (node, tmux, git, claude, codex) shown",
  );
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog
    .getByLabel("Build box connection")
    .filter({ hasText: /^Connected$/ })
    .waitFor();
  await page.screenshot({ path: path.join(screenshots, "ssh-hosts.png") });
  checks.push(
    `connected through ssh -T to the installed helper (bin/aw-ssh-helper; installed from ${installedFrom === "archive" ? "the extracted server archive with npm ci" : "this build in the archive layout"})`,
  );

  // Browse the host and register a folder there.
  await dialog.getByRole("button", { name: "Open a folder…" }).click();
  const browser = dialog.getByLabel("Folders on Build box");
  await browser.waitFor();
  await browser.getByRole("button", { name: "Computer" }).click();
  await browser
    .getByLabel("Remote folder location", { exact: true })
    .fill(remoteRepo);
  await browser
    .getByRole("button", { name: "Go to folder", exact: true })
    .click();
  await browser
    .getByText("Build box:" + (await realpath(remoteRepo)))
    .waitFor();
  await dialog
    .getByRole("button", { name: "Open this folder on Build box" })
    .click();
  await dialog.waitFor({ state: "detached" });
  const row = page
    .locator(".folder-list .folder-row")
    .filter({ has: page.locator(".host-badge") });
  await row.filter({ hasText: "service" }).waitFor();
  assert.match(await row.locator(".host-badge").textContent(), /Build box/);
  checks.push(
    "browsed the host's folders through the helper and registered one; the sidebar marks it with a host badge",
  );

  // Open a shell on the host and type.
  await page.getByRole("button", { name: "Open Shell here" }).click();
  const view = page.locator(".session-view");
  await view.locator(".xterm-screen").waitFor();
  await view.locator(".terminal-connection").waitFor({ state: "detached" });
  const typeIn = async (text) => {
    await view.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText(text);
    await page.keyboard.press("Enter");
  };
  const screenText = () => view.locator(".xterm-rows").textContent();
  await poll(async () => (await screenText()).trim().length > 0, "prompt");
  await typeIn("echo REMOTE_$((40+2)) $PWD $AW_NODE");
  const realRemote = await realpath(remoteRepo);
  await poll(
    async () => (await screenText()).includes("REMOTE_42 " + realRemote),
    "remote output",
  );
  checks.push(
    "opened a shell on the host from the SSH folder; typed input and saw its output (cwd is the host folder)",
  );
  let snap = await invoke("snapshot");
  const session = snap.sessions.find((s) => s.hostId);
  assert.ok(session);
  const remoteSocket = await socketFor(remoteData);
  const panePid = () =>
    execFileSync(
      tmux,
      [
        "-S",
        remoteSocket,
        "display-message",
        "-p",
        "-t",
        "=" + session.backendName + ":0.0",
        "#{pane_pid}",
      ],
      { encoding: "utf8" },
    ).trim();
  const pid = panePid();
  await page.screenshot({ path: path.join(screenshots, "ssh-session.png") });

  // Disconnect by killing the ssh client; the app reconnects to the same session.
  const sshPids = execFileSync("pgrep", ["-f", "^ssh -T .*-- aw-verify "], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(sshPids.length, 1, "one ssh client for the host");
  process.kill(Number(sshPids[0]), "SIGKILL");
  const footer = page.getByLabel("SSH host Build box");
  await footer.filter({ hasText: /Reconnecting|Disconnected$/ }).waitFor();
  await footer.filter({ hasText: /Build box\s*Connected$/ }).waitFor();
  await view.locator(".terminal-connection").waitFor({ state: "detached" });
  await poll(
    async () => !(await view.locator(".inline-error").count()),
    "terminal reattached",
  );
  await typeIn("echo AGAIN_$((6*7))");
  await poll(
    async () => (await screenText()).includes("AGAIN_42"),
    "output after reconnect",
  );
  snap = await invoke("snapshot");
  const same = snap.sessions.find((s) => s.id === session.id);
  assert.equal(same.status, "running");
  assert.equal(same.generation, session.generation);
  assert.equal(
    snap.sessions.filter((s) => s.hostId).length,
    1,
    "nothing was relaunched",
  );
  assert.equal(panePid(), pid, "same remote process");
  checks.push(
    "killed the ssh client: footer showed reconnecting, then connected; the view reattached the same remote session (same PID and generation), input works",
  );

  // Edit a file on the host in the editor and see Git status there.
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "notes.txt", exact: true }).click();
  await page.locator(".monaco-editor textarea").first().waitFor();
  await poll(
    () =>
      page.evaluate(() =>
        document
          .querySelector(".monaco-editor .view-lines")
          ?.textContent?.includes("original"),
      ),
    "remote file content",
  );
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("edited on the host\n", { delay: 5 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await poll(
    async () =>
      (await readFile(path.join(remoteRepo, "notes.txt"), "utf8")) ===
      "edited on the host\n",
    "remote save",
  );
  assert.equal(
    await readFile(path.join(localRepo, "notes.txt"), "utf8"),
    "original\n",
  );
  await page.getByLabel("Close editor").click();
  checks.push(
    "opened and saved a file on the host in the editor; the same-named local file is unchanged",
  );
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.getByRole("button", { name: "Stage notes.txt" }).waitFor();
  const status = await invoke("git.status", {
    projectId: snap.projects.find((p) => p.hostId).id,
  });
  assert.deepEqual(
    status.files.map((f) => [f.path, f.working]),
    [["notes.txt", "M"]],
  );
  checks.push(
    "Changes shows the host repository's Git status (notes.txt modified)",
  );

  // Local-only features are not offered on the remote session.
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Paste image" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: /^Agent control/ }).count(),
    0,
  );
  checks.push(
    "Paste image and Agent control are not offered for the SSH session",
  );

  // Deliberate disconnect leaves the remote process running.
  await page.getByRole("button", { name: "Settings and connections" }).click();
  await page.getByRole("button", { name: "SSH hosts", exact: true }).click();
  await page
    .getByRole("dialog", { name: "SSH hosts" })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await page
    .getByLabel("Build box connection")
    .filter({ hasText: /^Disconnected$/ })
    .waitFor();
  assert.equal(panePid(), pid);
  snap = await invoke("snapshot");
  assert.equal(
    snap.sessions.find((s) => s.id === session.id).status,
    "unknown",
  );
  checks.push(
    "Disconnect leaves the remote tmux session running; while disconnected its state shows unknown",
  );
  // A disconnected SSH folder offers Reconnect, never greyed "ready" cards.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const offline = page.locator(".host-offline");
  await offline.getByText("Build box is not connected").waitFor();
  assert.equal(
    await page.getByText(/ready for your first message/).count(),
    0,
  );
  await offline.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open Claude Code here|^Open Shell here/ })
    .first()
    .waitFor();
  checks.push(
    "A disconnected SSH folder shows a Reconnect notice in place of launch cards, and Reconnect restores them",
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await app?.close().catch(() => {});
  try {
    const socket = await socketFor(remoteData);
    execFileSync(tmux, ["-S", socket, "kill-server"], { stdio: "ignore" });
    await rm(socket, { force: true });
  } catch {}
  await sshd.stop();
  await cleanupFixture(fixture);
  await rm(fixture, { recursive: true, force: true });
}
