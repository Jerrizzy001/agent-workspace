import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const fixture = await mkdtemp(path.join(tmpdir(), "workspace-ui-"));
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
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
});
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.error("renderer error:", e.message));
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.workspace);
  // Seed only repository selection; all subsequent mutations use visible controls.
  await page.evaluate(
    (p) => window.workspace.invoke("project.add", { path: p }),
    repo,
  );
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page
    .getByPlaceholder("What do you want to work on?")
    .fill("UI acceptance");
  await page
    .getByRole("button", { name: "Create task", exact: true })
    .last()
    .click();
  await page
    .getByRole("button", { name: "Start an attempt", exact: true })
    .click();
  await page.getByRole("button", { name: /Shell Your local shell/ }).click();
  await page
    .getByRole("button", { name: "Start attempt", exact: true })
    .click();
  await page.locator(".xterm-helper-textarea").waitFor();
  await page.waitForTimeout(500);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf '%s%s\\n' 'UI_VISIBLE_' '456'");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector(".xterm-screen")
      ?.textContent?.includes("UI_VISIBLE_456"),
  );
  await page.screenshot({ path: path.join(fixture, "focus.png") });
  await app.evaluate(({ app }) => {
    const core = app
      .getAppMetrics()
      .find((m) => m.name === "Agent Workspace Core");
    if (!core) throw new Error("Core PID missing");
    process.kill(core.pid, "SIGKILL");
  });
  await page.waitForTimeout(1800);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf '%s%s\\n' 'CORE_RECONNECTED_' '789'");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector(".xterm-screen")
      ?.textContent?.includes("CORE_RECONNECTED_789"),
  );
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByLabel("Status for UI acceptance").selectOption("review");
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Status for UI acceptance"]')
        ?.value === "review",
  );
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  const note = page.locator(".canvas-note textarea");
  await note.fill("UI note persists");
  await note.blur();
  await page.screenshot({ path: path.join(fixture, "canvas.png") });
  await page.getByRole("button", { name: "Focus", exact: true }).click();
  await page.getByRole("button", { name: "files", exact: true }).click();
  await page.getByRole("button", { name: "hello.txt", exact: true }).click();
  const editor = page.locator(".monaco-editor textarea").first();
  await editor.waitFor();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("after UI save\n");
  await page.waitForFunction(
    () => !document.querySelector(".editor-overlay .secondary")?.disabled,
  );
  await app.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.__originalMessageBox = dialog.showMessageBoxSync;
    dialog.showMessageBoxSync = () => 0;
    BrowserWindow.getAllWindows()[0].close();
  });
  await page.waitForTimeout(250);
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = globalThis.__originalMessageBox;
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".editor-overlay .secondary")?.disabled,
  );
  assert.equal(
    await readFile(path.join(repo, "hello.txt"), "utf8"),
    "after UI save\n",
  );
  await page.screenshot({ path: path.join(fixture, "editor.png") });
  await page.getByLabel("Close editor").click();
  await page.screenshot({ path: path.join(fixture, "ui.png") });
  console.log(
    JSON.stringify({
      passed: true,
      fixture,
      checks: [
        "task controls",
        "attempt controls",
        "terminal typing",
        "core crash reconnect",
        "dirty editor close cancelled",
        "board status",
        "canvas note",
        "offline Monaco editing/save",
      ],
    }),
  );
} finally {
  await app.close();
  const socket = path.join(
    tmpdir(),
    `aw-${createHash("sha256").update(path.join(fixture, "data")).digest("hex").slice(0, 20)}.sock`,
  );
  try {
    execFileSync("/opt/homebrew/bin/tmux", ["-S", socket, "kill-server"], {
      stdio: "ignore",
    });
  } catch {}
}
