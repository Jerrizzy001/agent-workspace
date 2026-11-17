// Right-click menus: sidebar sessions and folders get native menus with their
// actions; the terminal and text fields get the edit menu. Native menus cannot
// be clicked by Playwright, so the main process records each menu and picks
// the item named by the test.
import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const fixture = await mkdtemp(path.join(tmpdir(), "workspace-menu-"));
const repo = path.join(fixture, "menu-project");
await mkdir(repo);
await writeFile(path.join(repo, "hello.txt"), "hi\n");
for (const args of [
  ["init"],
  ["config", "user.email", "fixture@example.invalid"],
  ["config", "user.name", "Fixture"],
  ["add", "."],
  ["commit", "-m", "fixture"],
])
  execFileSync("git", args, { cwd: repo });
const app = await electron.launch({
  ...(process.env.WORKSPACE_APP_EXECUTABLE
    ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
    : { args: ["."] }),
  env: { ...process.env, WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
});
// Replace native popups: record the labels, click `pick` if given.
async function nextMenu(pick) {
  await app.evaluate(({ Menu }, pick) => {
    globalThis.__menus ??= [];
    globalThis.__realBuild ??= Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      const menu = globalThis.__realBuild(template);
      menu.popup = (options = {}) => {
        const labels = menu.items
          .filter((i) => i.type !== "separator")
          .map((i) => i.label);
        globalThis.__menus.push(labels);
        const item = menu.items.find((i) => i.label === pick);
        if (item?.click) item.click(item, undefined, {});
        options.callback?.();
      };
      return menu;
    };
  }, pick ?? null);
}
const lastMenu = () => app.evaluate(() => globalThis.__menus.at(-1));
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.error("renderer error:", e.message));
  page.on("dialog", (d) => void d.accept());
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.workspace);
  await page.evaluate(
    (p) => window.workspace.invoke("project.add", { path: p }),
    repo,
  );
  await page
    .getByRole("button", { name: "Open Shell here", exact: true })
    .click();
  await page.locator(".xterm-helper-textarea").waitFor();
  const row = () => page.locator(".sidebar .session-row").first();
  await row().waitFor();

  // Rename from the session row.
  await nextMenu("Rename…");
  await row().click({ button: "right" });
  assert.deepEqual(await lastMenu(), [
    "Open",
    "Rename…",
    "Copy folder path",
    "End session…",
  ]);
  const input = page.getByRole("textbox", { name: /^Rename / });
  await input.fill("Menu renamed");
  await input.press("Enter");
  await page
    .getByRole("button", { name: /^Menu renamed, menu-project/ })
    .waitFor();

  // Escape cancels a rename.
  await row().click({ button: "right" });
  await page.getByRole("textbox", { name: /^Rename / }).fill("Discarded");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: /^Menu renamed, menu-project/ })
    .waitFor();

  // Terminal: the edit menu (its textarea is editable).
  await nextMenu();
  await page.locator(".xterm-screen").click({ button: "right" });
  await page.waitForTimeout(300);
  const terminalMenu = await lastMenu();
  for (const label of ["Copy", "Paste", "Select All"])
    assert.ok(terminalMenu.includes(label), `terminal menu has ${label}`);

  // Folder row.
  await nextMenu("Copy folder path");
  await page.locator(".folder-row", { hasText: "menu-project" }).click({
    button: "right",
  });
  assert.deepEqual(await lastMenu(), [
    "Open",
    "New task…",
    "Copy folder path",
    "Remove from list…",
  ]);

  // End, then archive the ended session.
  await nextMenu("End session…");
  await page
    .getByRole("button", { name: /^Menu renamed, menu-project/ })
    .click({
      button: "right",
    });
  const ended = page.getByRole("button", { name: /^Ended · / });
  await ended.waitFor();
  if ((await ended.getAttribute("aria-expanded")) !== "true")
    await ended.click();
  const endedRow = page.getByRole("button", {
    name: /^Menu renamed, menu-project, /,
  });
  await endedRow.waitFor();
  await nextMenu("Archive");
  await endedRow.click({ button: "right" });
  assert.ok((await lastMenu()).includes("Archive"));
  await endedRow.waitFor({ state: "detached" });
  const archived = await page.evaluate(async () => {
    const snap = await window.workspace.invoke("snapshot");
    return snap.sessions.every((s) => s.canvasHidden);
  });
  assert.ok(archived, "archived session is hidden");
  console.log(
    JSON.stringify({
      ok: true,
      checked: [
        "session rename",
        "rename escape",
        "terminal edit menu",
        "folder menu",
        "end session",
        "archive ended",
      ],
    }),
  );
} finally {
  await app.close();
  await cleanupFixture(fixture);
}
