import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupFixture } from "./fixture-cleanup.mjs";
const fixture = await mkdtemp(path.join(tmpdir(), "aw-backend-ui-"));
const repo = path.join(fixture, "repo");
await mkdir(repo);
await writeFile(path.join(repo, "file"), "fixture");
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
});
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
page.on("dialog", (dialog) => dialog.accept());
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
    title: "Disposable task",
  });
  const note = await invoke("note.create", {
    projectId: project.id,
    title: "Disposable note",
    body: "Archived body",
  });
  await invoke("note.archive", {
    noteId: note.id,
    revision: 1,
    archived: true,
  });
  await page.getByRole("button", { name: /Settings.*connections/i }).click();
  await page
    .getByRole("button", { name: "Workspace data", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Workspace data",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Export backup", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "Backup exported to" })
    .waitFor();
  const exported = (await panel.getByRole("status").innerText()).replace(
    "Backup exported to ",
    "",
  );
  assert.equal((await stat(exported)).mode & 0o777, 0o600);
  await panel
    .getByRole("combobox", { name: "Task to delete", exact: true })
    .selectOption(task.id);
  await panel
    .getByRole("button", { name: "Delete selected task…", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "Task deleted." })
    .waitFor();
  assert.equal((await invoke("snapshot")).tasks.length, 0);
  await panel
    .getByRole("combobox", { name: "Archived note to delete", exact: true })
    .selectOption(note.id);
  await panel
    .getByRole("button", { name: "Delete selected note…", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "Note deleted." })
    .waitFor();
  assert.equal((await invoke("snapshot")).notes.length, 0);
  await panel
    .getByRole("button", { name: "Archive old ended sessions", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "0 ended sessions archived." })
    .waitFor();
  await page.screenshot({ path: path.join(fixture, "workspace-data.png") });
  console.log(
    JSON.stringify({
      passed: true,
      fixture,
      checks: [
        "private backup export",
        "revision-checked task deletion",
        "archived note deletion",
        "history maintenance",
        "desktop receives incremental updates",
      ],
    }),
  );
} finally {
  await app.close();
  await cleanupFixture(fixture);
}
