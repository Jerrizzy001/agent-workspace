import { _electron as electron } from "playwright";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { cleanupFixture } from "./fixture-cleanup.mjs";

const fixture = await realpath(
  await mkdtemp(path.join(tmpdir(), "aw-appearance-")),
);
const repo = path.join(fixture, "appearance-project");
const shots = path.resolve(
  process.env.WORKSPACE_SCREENSHOT_DIR || "release/appearance-verification",
);
await Promise.all([repo, shots].map((p) => mkdir(p, { recursive: true })));
await writeFile(path.join(repo, "README.md"), "Original file\n");
const env = {
  ...process.env,
  SHELL: "/bin/sh",
  WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
};
const launch = () =>
  electron.launch({
    ...(process.env.WORKSPACE_APP_EXECUTABLE
      ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
      : { args: ["."] }),
    env,
  });
let app = await launch();
let page = await app.firstWindow();
const checks = [];
const errors = [];
const dialogs = [];
const watch = () => {
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
};
watch();
const invoke = (command, payload = {}) =>
  page.evaluate(
    ({ command, payload }) => window.workspace.invoke(command, payload),
    { command, payload },
  );
const snapshot = () => invoke("snapshot");
const terminal = () => page.locator(".session-view .xterm");
const terminalText = () =>
  page.locator(".session-view .xterm-rows").textContent();
const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
const settings = () =>
  page.getByRole("dialog", { name: "Settings and connections", exact: true });
const openSettings = () =>
  page
    .getByRole("button", { name: "Appearance settings", exact: true })
    .click();
const closeSettings = () =>
  settings()
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
const chooseTheme = (name) =>
  settings().getByRole("radio", { name, exact: true }).check();
const pid = (s) =>
  execFileSync(
    process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux",
    [
      "-S",
      s.backendSocket,
      "display-message",
      "-p",
      "-t",
      "=" + s.backendName + ":0.0",
      "#{pane_pid}",
    ],
    { encoding: "utf8" },
  ).trim();
async function poll(fn, label) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out: " + label);
}
let original;
let originalPid;
try {
  await page.waitForFunction(() => !!window.workspace);
  await invoke("project.add", { path: repo });
  await page.getByRole("button", { name: "Shell", exact: true }).click();
  await poll(
    () =>
      page.getByRole("button", { name: "Interrupt", exact: true }).isEnabled(),
    "terminal attached",
  );
  original = (await snapshot()).sessions[0];
  originalPid = pid(original);
  const originalTerminal = await terminal().elementHandle();
  await page.locator(".session-view .xterm-helper-textarea").focus();
  await page.keyboard.type("echo PRESERVED_INPUT");
  await poll(
    async () => (await terminalText()).includes("PRESERVED_INPUT"),
    "draft at prompt",
  );
  const initialWidth = (await terminal().boundingBox()).width;
  await page
    .getByRole("button", { name: "Collapse folders and sessions", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Folders and sessions", exact: true })
    .waitFor({ state: "hidden" });
  const sidebarCollapsedWidth = (await terminal().boundingBox()).width;
  assert.ok(sidebarCollapsedWidth > initialWidth + 200);
  assert.equal(
    await page
      .getByRole("button", { name: "Show folders and sessions", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page
    .getByRole("button", { name: "Collapse files panel", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Files and changes", exact: true })
    .waitFor({ state: "hidden" });
  assert.ok(
    (await terminal().boundingBox()).width > sidebarCollapsedWidth + 250,
  );
  assert.equal(
    await originalTerminal.evaluate(
      (el) =>
        el.isConnected && el === document.querySelector(".session-view .xterm"),
    ),
    true,
  );
  assert.equal((await terminalText()).split("PRESERVED_INPUT").length - 1, 1);
  await page
    .getByRole("button", { name: "Show folders and sessions", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Toggle files panel", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Files and changes", exact: true })
    .waitFor();
  checks.push(
    "Both panel headers collapse; restore controls stay reachable; terminal expands without remounting or submitting its input",
  );

  await openSettings();
  await chooseTheme("Light");
  assert.equal(await theme(), "light");
  assert.equal(
    await page
      .locator(".terminal-host .xterm-viewport")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 255, 255)",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(
    await theme(),
    "light",
    "explicit Light overrides the system setting",
  );
  await chooseTheme("Dark");
  assert.equal(await theme(), "dark");
  await chooseTheme("System");
  assert.equal(await theme(), "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await poll(
    async () => (await theme()) === "light",
    "system mode follows OS changes",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await poll(
    async () => (await theme()) === "dark",
    "system mode returns to dark",
  );
  await chooseTheme("Light");
  await page.screenshot({
    path: path.join(shots, "light-appearance-settings.png"),
  });
  await closeSettings();
  assert.equal(
    await originalTerminal.evaluate(
      (el) =>
        el.isConnected && el === document.querySelector(".session-view .xterm"),
    ),
    true,
  );
  assert.equal((await terminalText()).split("PRESERVED_INPUT").length - 1, 1);
  assert.equal(pid(original), originalPid);
  checks.push(
    "Light and Dark update the existing terminal; System follows media changes; typed input and process identity are preserved",
  );

  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await page.locator(".monaco-editor .view-lines").waitFor();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+a" : "Control+a",
  );
  await page.keyboard.type("PRESERVED_EDITOR_DRAFT\n");
  const save = () => page.getByRole("button", { name: "Save", exact: true });
  await poll(() => save().isEnabled(), "editor dirty");
  await page
    .getByRole("button", { name: "Collapse files panel", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Files and changes", exact: true })
    .waitFor({ state: "hidden" });
  assert.deepEqual(
    dialogs,
    [],
    "collapsing a dirty editor must not ask to discard it",
  );
  await page
    .getByRole("button", { name: "Toggle files panel", exact: true })
    .click();
  await page.locator(".monaco-editor .view-lines").waitFor();
  assert.match(
    await page.locator(".monaco-editor .view-lines").textContent(),
    /PRESERVED_EDITOR_DRAFT/,
  );
  assert.equal(
    await readFile(path.join(repo, "README.md"), "utf8"),
    "Original file\n",
  );
  await openSettings();
  await chooseTheme("Dark");
  await closeSettings();
  await poll(
    () =>
      page
        .locator(".monaco-editor.vs-dark")
        .count()
        .then((n) => n > 0),
    "editor dark theme",
  );
  await openSettings();
  await chooseTheme("Light");
  await closeSettings();
  await poll(
    () =>
      page
        .locator(".monaco-editor.vs")
        .count()
        .then((n) => n > 0),
    "editor light theme",
  );
  assert.match(
    await page.locator(".monaco-editor .view-lines").textContent(),
    /PRESERVED_EDITOR_DRAFT/,
  );
  await page
    .getByRole("button", { name: "Expand editor", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Collapse folders and sessions", exact: true })
    .click();
  assert.equal(
    Math.round((await page.locator(".editor-expanded").boundingBox()).x),
    16,
  );
  await page.screenshot({
    path: path.join(shots, "light-expanded-editor.png"),
  });
  await save().click();
  await poll(
    async () =>
      (await readFile(path.join(repo, "README.md"), "utf8")).includes(
        "PRESERVED_EDITOR_DRAFT",
      ),
    "explicit save writes draft",
  );
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  checks.push(
    "Collapsing and restoring preserves unsaved editor text without a discard prompt; Monaco follows the theme; expanded editor uses the freed sidebar space",
  );

  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.locator(".react-flow.light .canvas-terminal .xterm").waitFor();
  await poll(
    () => page.locator(".canvas-terminal .dictation-toggle").isEnabled(),
    "canvas terminal attached",
  );
  await poll(
    () =>
      page
        .locator(".canvas-terminal .xterm-rows")
        .textContent()
        .then((text) => text.includes("PRESERVED_INPUT")),
    "canvas output restored",
  );
  const canvasTerminal = await page
    .locator(".canvas-terminal .xterm")
    .elementHandle();
  await page.screenshot({ path: path.join(shots, "light-canvas.png") });
  await openSettings();
  await chooseTheme("Dark");
  await closeSettings();
  await page.locator(".react-flow.dark").waitFor();
  assert.equal(await canvasTerminal.evaluate((el) => el.isConnected), true);
  await openSettings();
  await chooseTheme("Light");
  await closeSettings();
  checks.push(
    "Canvas, its controls and embedded terminals follow appearance without restarting their terminal views",
  );

  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await poll(
    () =>
      page.getByRole("button", { name: "Interrupt", exact: true }).isEnabled(),
    "terminal attached after Canvas",
  );
  assert.equal((await terminalText()).split("PRESERVED_INPUT").length - 1, 1);
  await page.locator(".session-view .xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
  await poll(
    async () =>
      (await terminalText()).split("PRESERVED_INPUT").length - 1 === 2,
    "draft executes once after explicit Enter",
  );
  await page
    .getByRole("button", { name: "Collapse files panel", exact: true })
    .click();
  await page.screenshot({
    path: path.join(shots, "light-panels-collapsed.png"),
  });
  await app.evaluate(({ app }) => app.exit(0));
  app = await launch();
  page = await app.firstWindow();
  watch();
  await page.waitForFunction(() => !!window.workspace);
  await page
    .getByRole("button", { name: "Show folders and sessions", exact: true })
    .waitFor();
  assert.equal(await theme(), "light");
  await page
    .getByRole("complementary", { name: "Folders and sessions", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("complementary", { name: "Files and changes", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(pid(original), originalPid);
  assert.equal((await snapshot()).sessions[0].generation, original.generation);
  checks.push(
    "Appearance and both collapsed-panel choices survive quit/reopen; the same shell PID and generation remain alive",
  );

  const native = await app.browserWindow(page);
  await native.evaluate((w) => {
    w.setMinimumSize(320, 480);
    w.setContentSize(390, 780);
  });
  await page.waitForFunction(() => innerWidth === 390);
  await page
    .getByRole("button", { name: "Open folders and sessions", exact: true })
    .click();
  await poll(
    async () =>
      (
        await page
          .getByRole("complementary", {
            name: "Folders and sessions",
            exact: true,
          })
          .boundingBox()
      ).x >= 0,
    "mobile drawer opens despite desktop collapse preference",
  );
  await page.locator(".drawer-close").click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await page
    .locator(".mobile-navigation")
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Collapse files panel", exact: true })
    .click();
  await page.locator(".session-view").waitFor();
  await page.screenshot({ path: path.join(shots, "light-mobile-layout.png") });
  checks.push(
    "The narrow layout still opens its folder drawer and returns from Files to Terminal when desktop panels were saved collapsed",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(dialogs, []);
  console.log(JSON.stringify({ passed: true, fixture, checks }));
} catch (error) {
  await page
    .screenshot({ path: path.join(shots, "failure.png") })
    .catch(() => {});
  console.error(
    JSON.stringify({
      passed: false,
      fixture,
      checks,
      error: String(error?.stack || error),
    }),
  );
  process.exitCode = 1;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await cleanupFixture(fixture);
}
