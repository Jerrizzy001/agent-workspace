import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const fixture = await mkdtemp(path.join(tmpdir(), "agent-lifecycle-ui-"));
const repo = path.join(fixture, "repo");
await mkdir(repo);
await writeFile(path.join(repo, "fixture"), "fixture");
for (const a of [
  ["init"],
  ["config", "user.name", "Fixture"],
  ["config", "user.email", "fixture@example.invalid"],
  ["add", "."],
  ["commit", "-m", "Fixture"],
])
  execFileSync("git", a, { cwd: repo, stdio: "ignore" });
const launch = () =>
  electron.launch({
    executablePath: process.env.WORKSPACE_APP_EXECUTABLE,
    args: process.env.WORKSPACE_APP_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
    },
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
try {
  await page.waitForFunction(() => !!window.workspace);
  const project = await invoke("project.add", { path: repo });
  const task = await invoke("task.create", {
    projectId: project.id,
    title: "Session lifecycle",
  });
  await invoke("attempt.start", {
    taskId: task.id,
    provider: "shell",
    idempotencyKey: "natural",
  });
  await page
    .locator(".session-row")
    .filter({ hasText: "Session lifecycle" })
    .click();
  await page.locator(".terminal-connection").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  const runningState = await invoke("snapshot");
  const unknownState = structuredClone(runningState);
  unknownState.sessions[0].status = "unknown";
  unknownState.attempts[0].status = "unknown";
  await app.evaluate(({ BrowserWindow }, snapshot) => {
    BrowserWindow.getAllWindows()[0].webContents.send("workspace:event", {
      type: "snapshot",
      snapshot,
    });
  }, unknownState);
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await page.getByText("Session state is unknown.", { exact: false }).waitFor();
  assert.equal(await page.locator(".terminal-connection").count(), 0);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.locator(".terminal-connection").waitFor({ state: "detached" });
  await page
    .getByText("Session state is unknown.", { exact: false })
    .waitFor({ state: "detached" });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(
    `printf '%s%s\\n' 'RECONNECTED_' 'SAME_PROCESS_135'`,
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector(".xterm-screen")
      ?.textContent?.includes("RECONNECTED_SAME_PROCESS_135"),
  );
  assert.equal((await invoke("snapshot")).sessions.length, 1);
  assert.equal(await page.locator(".terminal-wrap [role='alert']").count(), 0);
  await app.evaluate(({ BrowserWindow }, snapshot) => {
    BrowserWindow.getAllWindows()[0].webContents.send("workspace:event", {
      type: "snapshot",
      snapshot,
    });
  }, runningState);
  checks.push(
    "injected unknown-state UI reconnects to the same actual live shell without a new attempt",
  );
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(
    `printf '%s%s\\n' 'FINAL_' 'OUTPUT_246'; exit`,
  );
  await page.keyboard.press("Enter");
  await page.locator(".session-ended").waitFor();
  assert.equal(await page.locator(".terminal-connection").count(), 0);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await page.locator(".session-ended").waitFor();
  // The ended process left its final screen; a fresh view shows it read-only.
  await page.waitForFunction(() =>
    document
      .querySelector(".xterm-screen")
      ?.textContent?.includes("FINAL_OUTPUT_246"),
  );
  assert.equal(await page.locator(".terminal-connection").count(), 0);
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByRole("checkbox", { name: "Show ended" }).check();
  await page.locator(".terminal-ended").waitFor();
  assert.equal(await page.locator(".terminal-connection").count(), 0);
  checks.push(
    "natural shell exit, terminal and canvas remount show ended state and saved final screen without spinner",
  );
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page
    .getByRole("button", { name: "Session lifecycle", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start an attempt", exact: true })
    .click();
  // Models are not assumed: blank inherits each CLI's own configured default.
  await page
    .getByRole("button", { name: /^Claude/ })
    .last()
    .click();
  assert.equal(
    await page.getByPlaceholder("CLI default when blank").inputValue(),
    "",
  );
  await page.getByPlaceholder("CLI default when blank").fill("custom-claude");
  await page
    .getByRole("button", { name: /^Codex/ })
    .last()
    .click();
  assert.equal(
    await page.getByPlaceholder("CLI default when blank").inputValue(),
    "",
  );
  await page.getByPlaceholder("CLI default when blank").fill("gpt-6.1-sol");
  await page
    .getByRole("button", { name: /^Claude/ })
    .last()
    .click();
  assert.equal(
    await page.getByPlaceholder("CLI default when blank").inputValue(),
    "custom-claude",
  );
  await page
    .getByRole("button", { name: /^Codex/ })
    .last()
    .click();
  assert.equal(
    await page.getByPlaceholder("CLI default when blank").inputValue(),
    "gpt-6.1-sol",
  );
  await page.screenshot({ path: path.join(fixture, "model-defaults.png") });
  checks.push(
    "provider-specific model fields start at the CLI default; independent custom values per provider",
  );
  await page
    .getByRole("button", { name: "Shell Your local shell", exact: true })
    .click();
  assert.equal(
    await page.getByPlaceholder("CLI default when blank").count(),
    0,
  );
  await page
    .getByRole("button", { name: "Start attempt", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start an attempt" })
    .waitFor({ state: "detached" });
  await page.locator(".terminal-connection").waitFor({ state: "detached" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "End", exact: true }).click();
  await page.locator(".session-ended").waitFor();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await page.locator(".session-ended").waitFor();
  assert.equal(await page.locator(".terminal-connection").count(), 0);
  await page.screenshot({ path: path.join(fixture, "ended.png") });
  checks.push(
    "explicit terminate and remount show ended state without spinner",
  );
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.evaluate(() => {
    window.__noteTrail = [];
    window.workspace.subscribe((e) => {
      if (e.type === "snapshot")
        window.__noteTrail.push(
          e.snapshot.notes.map((n) => ({ body: n.body, revision: n.revision })),
        );
    });
  });
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  const note = page.getByLabel("Canvas note");
  await note.fill("Autosave while this note remains focused");
  await page.waitForFunction(async () => {
    const state = await window.workspace.invoke("snapshot");
    return state.notes[0]?.body === "Autosave while this note remains focused";
  });
  assert(await note.evaluate((element) => element === document.activeElement));
  checks.push("canvas note autosaves without blur");
  await app.evaluate(({ dialog }) => {
    globalThis.__noteClosePrompts = 0;
    dialog.showMessageBoxSync = () => {
      globalThis.__noteClosePrompts++;
      return 0;
    };
  });
  await note.fill("Newest focused note survives closing and reopening");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await page.waitForFunction(async () => {
    const state = await window.workspace.invoke("snapshot");
    return (
      state.notes[0]?.body ===
      "Newest focused note survives closing and reopening"
    );
  });
  assert.equal(await app.evaluate(() => globalThis.__noteClosePrompts), 1);
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  assert.equal(
    await note.inputValue(),
    "Newest focused note survives closing and reopening",
  );
  // Native close cancellation may reset DOM focus. A user can tap the retained
  // note and continue typing; verify that path without replacing its content.
  await note.focus();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
  );
  await page.keyboard.type("; continued after cancel");
  await page.waitForFunction(async () => {
    const state = await window.workspace.invoke("snapshot");
    return (
      state.notes[0]?.body ===
      "Newest focused note survives closing and reopening; continued after cancel"
    );
  });
  assert.equal(
    await note.inputValue(),
    "Newest focused note survives closing and reopening; continued after cancel",
  );
  await page.screenshot({ path: path.join(fixture, "focused-note-saved.png") });
  // A core snapshot can precede the renderer's save acknowledgement. Wait until
  // its actual unload guard settles before asking the app to quit for real.
  await page.waitForFunction(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return !event.defaultPrevented;
  });
  await Promise.race([
    app.close(),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Settled note did not permit app quit")),
        15000,
      ).unref();
    }),
  ]);
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => !!window.workspace);
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  assert.equal(
    await page.getByLabel("Canvas note").inputValue(),
    "Newest focused note survives closing and reopening; continued after cancel",
  );
  await page.screenshot({
    path: path.join(fixture, "focused-note-reopened.png"),
  });
  checks.push(
    "immediate focused-note close flushes, protects pending text, and persists through app restart",
  );
  console.log(JSON.stringify({ passed: true, fixture, checks }));
} catch (error) {
  await page.screenshot({ path: path.join(fixture, "failure.png") });
  console.error(
    JSON.stringify({
      passed: false,
      fixture,
      checks,
      error: String(error.stack || error),
      trail: await page.evaluate(() => window.__noteTrail),
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    const state = await invoke("snapshot");
    for (const s of state.sessions.filter((s) => s.status === "running")) {
      const p = {
        sessionId: s.id,
        generation: s.generation,
        viewerId: "cleanup",
      };
      await invoke("session.attach", p);
      await invoke("session.terminate", p);
    }
  } catch {}
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await cleanupFixture(fixture);
}
