import { _electron as electron } from "playwright";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { cleanupFixture } from "./fixture-cleanup.mjs";

// Interactive regression of the audited workflow. Only disposable files and
// fixture providers are used; no login, real model call or public listener.
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "aw-ux-")));
const repo = path.join(fixture, "audit-project");
const home = path.join(fixture, "home");
const bin = path.join(fixture, "bin");
const shots = path.resolve("release/ux-verification");
await Promise.all(
  [repo, home, bin, shots].map((p) => mkdir(p, { recursive: true })),
);
await writeFile(path.join(repo, "README.md"), "Before the editor test\n");
for (const args of [
  ["init"],
  ["config", "user.name", "UX Fixture"],
  ["config", "user.email", "fixture@example.invalid"],
  ["add", "."],
  ["commit", "-m", "Initial fixture"],
])
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
await writeFile(
  path.join(bin, "claude"),
  `#!${process.execPath}\nrequire(${JSON.stringify(path.resolve("scripts/claude-fixture.cjs"))});\n`,
  { mode: 0o700 },
);
const env = {
  ...process.env,
  HOME: home,
  SHELL: "/bin/sh",
  PATH: bin + path.delimiter + process.env.PATH,
  WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
  CLAUDE_FIXTURE_LOG: path.join(fixture, "starts.jsonl"),
};
delete env.CLAUDE_CONFIG_DIR;
const app = await electron.launch({
  timeout: 30000,
  ...(process.env.WORKSPACE_APP_EXECUTABLE
    ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
    : { args: ["."] }),
  env,
});
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
const errors = [];
const checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const invoke = (command, payload = {}) =>
  page.evaluate(
    ({ command, payload }) => window.workspace.invoke(command, payload),
    { command, payload },
  );
const snapshot = () => invoke("snapshot");
async function poll(fn, label) {
  for (let i = 0; i < 200; i++) {
    try {
      if (await fn()) return;
    } catch {}
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out: " + label);
}
const capture = async (name) =>
  page.screenshot({ path: path.join(shots, name + ".png") });
async function type(text) {
  await poll(
    () =>
      page.getByRole("button", { name: "Interrupt", exact: true }).isEnabled(),
    "terminal attached",
  );
  const input = page.locator(".session-view .xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
async function settings(name) {
  await page
    .getByRole("button", { name: "Settings and connections", exact: true })
    .click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function focusCheck(dialog) {
  await poll(
    () => dialog.evaluate((el) => el.contains(document.activeElement)),
    "dialog initial focus",
  );
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
      true,
      "focus remains inside dialog",
    );
  }
}
let project, source, receiver;
try {
  await page.waitForFunction(() => !!window.workspace);
  await page.getByLabel("Folder location", { exact: true }).fill(repo);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page
    .getByRole("button", { name: "Open this folder", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Shell here", exact: true })
    .click();
  await type("printf 'UX_SHELL_READY\\n'");
  await page.waitForFunction(() =>
    document
      .querySelector(".session-view .xterm-screen")
      ?.textContent?.includes("UX_SHELL_READY"),
  );
  project = (await snapshot()).projects[0];
  receiver = (await snapshot()).sessions[0];
  await page.getByRole("button", { name: "Rename session" }).click();
  await page.getByRole("textbox", { name: "Session name" }).fill("Receiver");
  await page.keyboard.press("Enter");
  checks.push(
    "Folder path navigation and one-click shell; typed output; persistent session rename",
  );

  await page.getByRole("button", { name: "README.md", exact: true }).click();
  const editor = page.locator(".monaco-editor textarea");
  await editor.waitFor();
  await page.locator(".monaco-editor .view-lines").click();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(mod + "+A");
  await page.keyboard.type("Saved using the keyboard\n");
  await poll(
    () => page.getByRole("button", { name: "Save", exact: true }).isEnabled(),
    "editor dirty",
  );
  await page.keyboard.press(mod + "+S");
  await poll(
    async () =>
      (await readFile(path.join(repo, "README.md"), "utf8")) ===
      "Saved using the keyboard\n",
    "keyboard save",
  );
  await page.getByRole("button", { name: "Expand editor" }).click();
  assert.ok((await page.locator(".editor-overlay").boundingBox()).width > 700);
  await capture("01-expanded-editor");
  await page.getByRole("button", { name: "Close editor" }).click();
  checks.push("Command/Ctrl-S writes the file; editor expands; Saved feedback");

  assert.equal((await snapshot()).capabilities.find(c => c.name === "claude").detail, path.join(bin, "claude"), "only the fixture provider may be launched");
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await page.locator('.session-view[aria-label="Claude session"]').waitFor();
  source = (await snapshot()).sessions.find((s) => s.provider === "claude");
  await type("A context example for the connected agent");
  await poll(
    async () =>
      (await snapshot()).sessions.find((s) => s.id === source.id)?.activity ===
      "done",
    "fixture Claude turn",
  );
  await type("/fixture-error");
  await page
    .locator(".session-view")
    .getByText("Turn failed", { exact: true })
    .waitFor();
  await page.getByText("More actions", { exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Branch", exact: true }).isEnabled(),
    true,
  );
  await capture("02a-failed-turn-recovery");
  await page.getByText("More actions", { exact: true }).click();
  await type("Continue with the shared context example");
  await poll(
    async () =>
      (await snapshot()).sessions.find((s) => s.id === source.id)?.activity ===
      "done",
    "recovery after failed turn",
  );
  for (const close of await page
    .getByRole("button", { name: "Dismiss notification" })
    .all())
    await close.click();
  checks.push(
    "A failed Claude turn visibly reports Turn failed, permits branching, and returns to Ready after another fixture turn",
  );
  await invoke("layout.save", { projectId: project.id, positions: { [receiver.id]: { x: 0, y: 500 }, [source.id]: { x: 680, y: 500 } } });
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.waitForFunction(() => {
    const view = document.querySelector(".canvas-flow")?.getBoundingClientRect();
    const nodes = [...document.querySelectorAll(".react-flow__node")];
    return view && nodes.length === 2 && nodes.every(n => { const b = n.getBoundingClientRect(); return b.top >= view.top && b.bottom <= view.bottom + 1; });
  });
  checks.push("An existing saved canvas layout is fitted after the flow initializes; cards start within the visible canvas");
  await page
    .getByRole("button", { name: "Connect agents", exact: true })
    .click();
  const choose = page.getByRole("dialog", { name: "Choose source agent" });
  await focusCheck(choose);
  await choose.getByRole("button", { name: "Claude", exact: true }).click();
  const links = page.getByRole("dialog", {
    name: "Connect agents",
    exact: true,
  });
  await focusCheck(links);
  await links.getByRole("button", { name: "Preview transcript" }).click();
  await links.getByLabel("Give to", { exact: true }).selectOption(receiver.id);
  assert.equal(
    await links
      .getByRole("button", { name: "Connect", exact: true })
      .isDisabled(),
    true,
  );
  await links.getByLabel(/Allow the recipient to read snapshots/).check();
  await links.getByRole("button", { name: "Connect", exact: true }).click();
  await links
    .getByText("Snapshot connected to Receiver", { exact: true })
    .waitFor();
  const connected = (
    await invoke("transcript.list", { sessionId: source.id })
  )[0];
  const grant = await page.evaluate(
    (id) => window.workspace.agentControl.list({ sessionId: id }),
    receiver.id,
  );
  assert.deepEqual(grant.grant.verbs, ["transcript.read"]);
  await links
    .getByRole("button", { name: "Open recipient with instructions" })
    .click();
  await poll(
    () => page.getByRole("button", { name: "Insert instructions" }).isEnabled(),
    "recipient ready for instructions",
  );
  await page.getByRole("button", { name: "Insert instructions" }).click();
  await page
    .getByRole("region", { name: "Shared context instructions" })
    .waitFor({ state: "hidden" });
  assert.equal(
    (await invoke("transcript.list", { sessionId: source.id }))[0].reads,
    0,
    "insertion does not submit the command",
  );
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.locator(".react-flow__edge").waitFor();
  await page.getByRole("button", { name: /Snapshot · not read yet/ }).waitFor();
  await poll(
    () =>
      page
        .getByText("Connecting terminal…", { exact: true })
        .count()
        .then((n) => n === 0),
    "canvas terminals attached",
  );
  await page.waitForFunction(() => {
    const view = document.querySelector(".canvas-flow")?.getBoundingClientRect();
    return view && [...document.querySelectorAll(".react-flow__node")].every(n => { const b = n.getBoundingClientRect(); return b.top >= view.top && b.bottom <= view.bottom + 1; });
  });
  await capture("02-connected-canvas");
  await page.evaluate(
    (id) => window.workspace.agentControl.revoke({ sessionId: id }),
    receiver.id,
  );
  await page.getByRole("button", { name: /Reading paused/ }).click();
  await links.getByRole("button", { name: "Enable recipient reading" }).click();
  await links.getByText(/Reading enabled for Receiver/).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Snapshot · not read yet/ }).waitFor();
  assert.equal(
    (await invoke("transcript.list", { sessionId: source.id })).length,
    1,
    "renewing read access does not duplicate the snapshot",
  );

  checks.push(
    "Canvas source chooser → preview → explicit consent → directed connection; minimal read permission; instructions insert without submitting; keyboard focus containment",
  );

  await page
    .getByRole("button", {
      name: "Receiver audit-project Running",
      exact: true,
    })
    .click();
  await poll(
    () =>
      page.getByRole("button", { name: "Interrupt", exact: true }).isEnabled(),
    "recipient reattached",
  );
  await page.locator(".session-view .xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
  await poll(
    async () =>
      (await invoke("transcript.list", { sessionId: source.id }))[0].reads > 0,
    "recipient reads snapshot",
  );
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByText(/Snapshot · read [1-9]/).waitFor();
  await page.getByRole("button", { name: /Snapshot · read [1-9]/ }).click();
  await links.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.keyboard.press("Escape");
  await poll(
    () =>
      page
        .locator(".react-flow__edge")
        .count()
        .then((n) => n === 0),
    "revoked edge removed",
  );
  checks.push(
    "Recipient reads only its linked snapshot; Canvas shows reads; revocation removes connection",
  );

  await page.getByRole("button", { name: "Add note", exact: true }).click();
  const note = page.getByRole("textbox", { name: "Canvas note" });
  await note.fill("A durable planning note");
  await note.press("Tab");
  await poll(
    async () =>
      (await snapshot()).notes.some(
        (n) => n.body === "A durable planning note",
      ),
    "note save",
  );
  await page
    .getByRole("button", { name: "Actions for Note", exact: true })
    .click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Card name" }).fill("Plan");
  await page.getByRole("button", { name: "Save name" }).click();
  await page
    .getByRole("button", { name: "Actions for Plan", exact: true })
    .click();
  await page.getByRole("button", { name: "Archive note" }).click();
  await poll(
    async () => (await snapshot()).notes[0].archived === true,
    "note archived",
  );
  await page.getByRole("button", { name: "Undo removal" }).click();
  await note.waitFor();
  assert.equal(await note.inputValue(), "A durable planning note");
  await page.getByRole("button", { name: "Actions for Plan", exact: true }).click();
  for (let i=0; i<5; i++) await page.getByRole("button", { name: "Up", exact: true }).click();
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.getByRole("button", { name: "Actions for Plan", exact: true }).click();
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll(".react-flow__node")].map(n => ({ n, b: n.getBoundingClientRect() }));
    const note = cards.find(c => c.n.querySelector(".canvas-note"));
    return note && cards.filter(c => c !== note).every(c => note.b.bottom <= c.b.top || note.b.top >= c.b.bottom || note.b.right <= c.b.left || note.b.left >= c.b.right);
  });
  await capture("03-canvas-note-restored");
  checks.push(
    "Canvas note editing, rename, archive, undo and keyboard move controls preserve the body",
  );

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Task name" })
    .fill("Use the existing agent");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page
    .getByLabel("Attach existing session", { exact: true })
    .selectOption(receiver.id);
  await page
    .getByRole("button", { name: "Attach session", exact: true })
    .click();
  await poll(
    async () =>
      !!(await snapshot()).sessions.find((s) => s.id === receiver.id)
        ?.attemptId,
    "existing session attached",
  );
  assert.equal((await snapshot()).sessions.length, 2);
  await capture("04-attached-task");
  checks.push(
    "Task attaches existing session without launching another process",
  );

  await settings("Claude profiles");
  const profiles = page.getByRole("dialog", { name: "Claude profiles" });
  await focusCheck(profiles);
  await profiles.getByRole("button", { name: "Check default account" }).click();
  await profiles.getByText(/fixture@example.invalid/).waitFor();
  assert.equal(
    (await profiles.innerText()).includes("NEVER_RETURN_FIXTURE_TOKEN"),
    false,
  );
  await capture("05-account-readiness");
  await page.keyboard.press("Escape");
  checks.push(
    "Owner-only account check shows allowlisted identity; no extra credential fields",
  );

  for (const name of [
    "Voice dictation settings",
    "AI suggestions settings",
    "SSH hosts",
    "Team",
  ]) {
    await settings(name);
    const dialog = page.getByRole("dialog");
    await focusCheck(dialog);
    const bounds = await dialog.boundingBox();
    const height = await page.evaluate(() => innerHeight);
    assert.ok(
      bounds.y >= 0 && bounds.y + bounds.height <= height + 1,
      name + " fits viewport",
    );
    if (name === "Voice dictation settings") {
      await page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = async () => {
          throw new Error("Fixture permission refusal");
        };
      });
      await dialog.getByRole("button", { name: "Test microphone" }).click();
      await dialog.getByText(/Microphone unavailable/).waitFor();
    }
    await capture("06-" + name.toLowerCase().replaceAll(" ", "-"));
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
  checks.push(
    "Settings dialogs initialize/contain keyboard focus, close with Escape, fit the window; microphone refusal has a recovery message",
  );

  const extra = path.join(fixture, "unshared");
  await mkdir(extra);
  const excluded = await invoke("project.add", { path: extra });
  await settings("Remote access settings");
  const remote = page.getByRole("dialog", {
    name: "Remote access",
    exact: true,
  });
  await focusCheck(remote);
  assert.equal(
    await remote
      .getByRole("button", { name: "Enable remote access" })
      .isDisabled(),
    true,
  );
  await remote
    .getByRole("checkbox", { name: "audit-project", exact: true })
    .check();
  await remote
    .getByRole("radio", { name: "Browser on this computer only", exact: true })
    .check();
  await remote.getByText("Advanced network settings", { exact: true }).click();
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
  });
  await remote.getByLabel("Remote port", { exact: true }).fill(String(port));
  await remote.getByRole("button", { name: "Enable remote access" }).click();
  await remote.getByRole("button", { name: "Stop remote access" }).waitFor();
  const remoteStatus = await page.evaluate(() =>
    window.workspace.remote.status(),
  );
  assert.deepEqual(
    remoteStatus.sharedProjects.map((p) => p.id),
    [project.id],
  );
  assert.ok(!remoteStatus.sharedProjects.some((p) => p.id === excluded.id));
  await remote.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const footer = await remote.locator("footer").boundingBox();
  assert.ok(
    footer.y + footer.height <= (await page.evaluate(() => innerHeight)) + 1,
  );
  await capture("07-scoped-remote-access");
  await remote.getByRole("button", { name: "Stop remote access" }).click();
  await page.keyboard.press("Escape");
  checks.push(
    "Remote access defaults off, requires folder choice, shares only selected local folders, and keeps footer reachable",
  );

  await page.getByRole("button", { name: /Search and commands/ }).click();
  await page
    .getByRole("textbox", { name: "Search folders, sessions and commands" })
    .fill("connect");
  await page
    .getByRole("button", { name: /Connect agents · share context/ })
    .waitFor();
  await capture("08-command-search");
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "Command palette" })
    .waitFor({ state: "hidden" });
  checks.push(
    "Search discovers Connect agents and connection settings; Escape dismisses the palette",
  );

  // Finish the fixture shell naturally and observe final output without re-opening.
  const state = await snapshot();
  receiver = state.sessions.find((s) => s.id === receiver.id);
  const title = "Receiver";
  await page
    .getByRole("button", {
      name: `${title} audit-project Running`,
      exact: true,
    })
    .click();
  await type("printf 'UX_FINAL_OUTPUT\\n'; exit");
  await page.waitForFunction(() =>
    document.querySelector(".session-view")?.textContent?.includes("has ended"),
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".session-view .xterm-screen")
      ?.textContent?.includes("UX_FINAL_OUTPUT"),
  );
  assert.equal(await page.locator(".session-view .inline-error").count(), 0);
  await capture("09-final-output");
  checks.push(
    "Final output appears immediately on exit without switching views or stale attach errors",
  );
  await page.getByRole("button", { name: "Worktrees", exact: true }).click();
  await page.getByLabel("New worktree branch").fill("ux/isolated");
  await page
    .getByRole("button", { name: "Create worktree", exact: true })
    .click();
  const treeCard = page
    .locator(".worktree-card")
    .filter({ hasText: "ux/isolated" });
  await treeCard
    .getByRole("button", { name: "Open Shell here", exact: true })
    .click();
  await poll(
    async () => (await snapshot()).sessions.length === 3,
    "worktree shell created",
  );
  const worktreeSession = (await snapshot()).sessions.find(
    (s) => s.id !== source.id && s.id !== receiver.id,
  );
  assert.equal(worktreeSession.worktreePath, worktreeSession.cwd);
  assert.notEqual(worktreeSession.cwd, repo);
  await type("printf 'WORKTREE_READY\\n'");
  await page.waitForFunction(() =>
    document
      .querySelector(".session-view .xterm-screen")
      ?.textContent?.includes("WORKTREE_READY"),
  );
  await capture("10-worktree-launch");
  checks.push(
    "Direct worktree launch starts in the chosen isolated folder and preserves its review location",
  );
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    fixture,
    checks,
    version: await app.evaluate(({ app }) => app.getVersion()),
  };
  await writeFile(
    path.join(shots, "verification.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  await page
    .screenshot({ path: path.join(shots, "failure.png") })
    .catch(() => {});
  console.error(
    JSON.stringify({
      passed: false,
      fixture,
      checks,
      errors,
      error: String(error.stack || error),
    }),
  );
  process.exitCode = 1;
} finally {
  await app.close();
  await cleanupFixture(fixture);
}
