import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// Agent control through awctl, end to end in the desktop app: the owner grants
// a running shell control, the shell's own process runs awctl, the results
// appear on the canvas, and after Revoke the next awctl call is refused. The
// parent shell keeps running throughout. No provider is called.
const fixture = await mkdtemp(path.join(tmpdir(), "agent-control-"));
const repo = path.join(fixture, "alpha");
const screenshots = path.resolve("docs/screenshots/desktop");
await mkdir(repo);
await mkdir(screenshots, { recursive: true });
await writeFile(path.join(repo, "hello.txt"), "agent control fixture\n");
const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";
const app = await electron.launch({
  executablePath: process.env.WORKSPACE_APP_EXECUTABLE,
  args: process.env.WORKSPACE_APP_EXECUTABLE ? [] : ["."],
  env: { ...process.env, SHELL: "/bin/sh", WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
});
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
const errors = [];
const checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const invoke = (command, payload = {}) =>
  page.evaluate(({ command, payload }) => window.workspace.invoke(command, payload), { command, payload });
const snapshot = () => invoke("snapshot");
async function poll(check, label) {
  for (let i = 0; i < 300; i++) {
    try {
      if (await check()) return;
    } catch {}
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out: " + label);
}
let socket;
const panePid = (backendName) =>
  execFileSync(tmux, ["-S", socket, "display-message", "-p", "-t", "=" + backendName + ":0.0", "#{pane_pid}"], {
    encoding: "utf8",
  }).trim();
const json = async (name) => JSON.parse(await readFile(path.join(repo, name), "utf8"));
const written = (name) =>
  poll(async () => existsSync(path.join(repo, name)) && (await readFile(path.join(repo, name), "utf8")).endsWith("\n"), name);
async function typeIn(text) {
  const scope = page.locator(".session-view");
  await scope.locator(".xterm-screen").waitFor();
  await scope.locator(".terminal-connection").waitFor({ state: "detached" });
  await poll(async () => (await scope.locator(".xterm-screen").textContent()).trim().length > 0, "terminal drawn");
  await scope.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
/** Runs awctl in the parent shell's own process; stdout and the exit code land in files. */
async function awctl(name, args) {
  await typeIn(`awctl ${args} > ${name}.json; echo $? > ${name}.code`);
  await written(name + ".code");
  await written(name + ".json");
  return { code: Number(await readFile(path.join(repo, name + ".code"), "utf8")), out: await json(name + ".json") };
}
try {
  await page.waitForFunction(() => !!window.workspace);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  socket = path.join(
    tmpdir(),
    `aw-${createHash("sha256").update(await realpath(path.join(fixture, "data"))).digest("hex").slice(0, 20)}.sock`,
  );
  const project = await invoke("project.add", { path: repo });
  await page.locator(".folder-list button").filter({ hasText: "alpha" }).click();
  await page.getByRole("button", { name: "Open Shell here" }).click();
  await typeIn(`printf '%s\\n' "$$" > pid.txt`);
  await written("pid.txt");
  const shellPid = await readFile(path.join(repo, "pid.txt"), "utf8");
  const parent = (await snapshot()).sessions[0];
  await invoke("session.rename", { sessionId: parent.id, generation: 1, title: "Parent shell", titleRevision: 0 });
  const tmuxPid = panePid(parent.backendName);
  checks.push("shell started from the folder; it reports its PID");

  // Off by default: the running shell has the launcher but no grant.
  let r = await awctl("before", "status");
  assert.equal(r.code, 1);
  assert.equal(r.out.error, "no_grant");
  checks.push("awctl in the running shell is refused before any grant (no_grant)");

  // Grant through the desktop UI: default verbs plus "Open sessions".
  await page.getByRole("button", { name: "Agent control", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Agent control" });
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel(/Read status/).isChecked(), true);
  assert.equal(await dialog.getByLabel(/Open sessions/).isChecked(), false);
  await dialog.getByLabel(/Open sessions/).check();
  await dialog.getByRole("button", { name: "Grant control" }).click();
  await dialog.getByText(/^On until/).waitFor();
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Agent control on" }).waitFor();
  const grantFile = path.join(await realpath(path.join(fixture, "data")), "control", "grants");
  checks.push("owner granted status, notes, canvas and open from the session bar; the button shows it is on");

  r = await awctl("status", "status");
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(r.out.project.id, project.id);
  assert.deepEqual(r.out.sessions.map((s) => s.id), [parent.id]);
  assert.equal(JSON.stringify(r.out).includes(fixture), false, "status has no host paths");
  assert.equal(r.out.grant.openLimit, 3);
  checks.push("awctl status from inside the already-running shell: this folder only, no host paths, default open limit 3");

  r = await awctl("note", `note create --title 'From the agent' --body 'Written by awctl' --request-id verify-note`);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  const noteId = r.out.note.id;
  r = await awctl("place", `canvas place --node ${noteId} --x 760 --y 520 --revision ${r.out.layoutRevision}`);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  r = await awctl("open", "open --provider shell --request-id verify-open");
  assert.equal(r.code, 0, JSON.stringify(r.out));
  const childId = r.out.session.id;
  await poll(async () => (await snapshot()).sessions.length === 2, "child session");
  checks.push("awctl note create, canvas place and open --provider shell succeeded");

  // The results are on the existing canvas.
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  const noteNode = page.locator(`.react-flow__node[data-id="${noteId}"]`);
  await noteNode.waitFor();
  assert.match(await noteNode.textContent(), /From the agent/);
  assert.match(await noteNode.textContent(), /AGENT NOTE/);
  assert.equal(await noteNode.getByLabel("Canvas note").inputValue(), "Written by awctl");
  await poll(
    async () => /translate\(760px,\s*520px\)/.test((await noteNode.getAttribute("style")) || ""),
    "note placed at 760,520",
  );
  await page.locator(`.react-flow__node[data-id="${childId}"]`).waitFor();
  assert.equal(await page.locator(".react-flow__node .canvas-terminal").count(), 2);
  checks.push("the agent note (labelled AGENT NOTE, inert text) sits at the placed position and the opened shell is a canvas terminal");

  // The child has no grant of its own.
  const child = (await snapshot()).sessions.find((s) => s.id === childId);
  const childEnv = execFileSync("cat", [`/proc/${panePid(child.backendName)}/environ`], { encoding: "utf8" })
    .split("\0")
    .find((line) => line.startsWith("AW_CONTROL_FILE="))
    .slice("AW_CONTROL_FILE=".length);
  assert.equal(existsSync(childEnv), false);
  checks.push("the opened shell has its own (empty) grant path: it inherited no control");

  // Recent actions and Revoke in the desktop UI.
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await page.locator(".session-tab").filter({ hasText: "Parent shell" }).click();
  await page.getByRole("button", { name: "Agent control on" }).click();
  await dialog.waitFor();
  await dialog.locator(".agent-control-audit li").nth(3).waitFor();
  const actions = await dialog.locator(".agent-control-audit li code").allTextContents();
  assert.deepEqual(actions.slice(0, 4), ["open", "canvas.place", "note.create", "grant"]);
  for (const close of await page.getByRole("button", { name: "Dismiss notification" }).all())
    await close.click().catch(() => {});
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(screenshots, "agent-control.png") });
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await dialog.getByRole("button", { name: "Grant control" }).waitFor();
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Agent control", exact: true }).waitFor();
  checks.push("the dialog lists open, canvas.place, note.create and grant; Revoke turns it off");

  r = await awctl("after", "status");
  assert.equal(r.code, 1);
  assert.equal(r.out.error, "no_grant");
  assert.deepEqual(await readdir(grantFile), [], "revoke removed the grant file");
  checks.push("after Revoke the next awctl call from the same shell is refused");

  // Neither process was restarted.
  const sessions = (await snapshot()).sessions;
  assert.equal(sessions.find((s) => s.id === parent.id).status, "running");
  assert.equal(sessions.find((s) => s.id === childId).status, "running");
  assert.equal(panePid(parent.backendName), tmuxPid);
  await typeIn(`printf '%s\\n' "$$" > pid-after.txt`);
  await written("pid-after.txt");
  assert.equal(await readFile(path.join(repo, "pid-after.txt"), "utf8"), shellPid);
  checks.push("parent shell kept running with the same tmux and shell PIDs; the opened shell is still running");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fixture, project: project.id, checks }));
} catch (error) {
  await page.screenshot({ path: path.join(fixture, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ passed: false, fixture, checks, errors, error: String(error?.stack || error) }));
  process.exitCode = 1;
} finally {
  try {
    for (const session of (await snapshot()).sessions) {
      try {
        await invoke("session.attach", { sessionId: session.id, generation: session.generation, viewerId: "cleanup" });
        await invoke("session.terminate", { sessionId: session.id, generation: session.generation, viewerId: "cleanup" });
      } catch {}
    }
  } catch {}
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await cleanupFixture(fixture);
}
