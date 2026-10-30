import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const fixture = await mkdtemp(path.join(tmpdir(), "agent-workflows-"));
const checks = [];
async function repository(name) {
  const dir = path.join(fixture, name);
  await mkdir(dir);
  await writeFile(path.join(dir, "hello.txt"), "base\n");
  await writeFile(path.join(dir, "second.txt"), "second\n");
  for (const args of [
    ["init"],
    ["config", "user.name", "Fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["add", "."],
    ["commit", "-m", "Fixture"],
  ])
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  return dir;
}
const repo = await repository("alpha");
const repo2 = await repository("beta");
const app = await electron.launch({
  executablePath: process.env.WORKSPACE_APP_EXECUTABLE,
  args: process.env.WORKSPACE_APP_EXECUTABLE ? [] : ["."],
  env: { ...process.env, WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
});
const page = await app.firstWindow();
page.setDefaultTimeout(18000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const command = (name, payload) =>
  page.evaluate(({ name, payload }) => window.workspace.invoke(name, payload), {
    name,
    payload,
  });
const snapshot = () => command("snapshot");
const waitFor = async (fn, arg) => page.waitForFunction(fn, arg);
try {
  await page.waitForFunction(() => !!window.workspace);
  const p1 = await command("project.add", { path: repo });
  const p2 = await command("project.add", { path: repo2 });
  await page.locator(".folder-list button").filter({ hasText: "alpha" }).click();
  // Tasks are optional planning on the board; the folder itself needs none.
  await page.getByRole("button", { name: "Open Shell here" }).waitFor();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  // The board opens on live sessions; tasks are the second mode.
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByPlaceholder("What do you want to work on?")
    .fill("Build workflow");
  await page
    .getByPlaceholder("Add context, constraints, or an intended outcome.")
    .fill("A disposable verification task");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByPlaceholder("What do you want to work on?")
    .fill("Verified workflow");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await page
    .getByRole("heading", { name: "Verified workflow", exact: true })
    .waitFor();
  await page.getByLabel("Task workflow status").selectOption("in_progress");
  assert.equal((await snapshot()).tasks[0].status, "in_progress");
  checks.push("create and edit task with revision; task sheet status");
  await page.getByLabel("Status for Verified workflow").selectOption("ready");
  // The async status write moves the card between columns; finish it before dragging.
  await waitFor(() => document.querySelector('select[aria-label="Status for Verified workflow"]')?.closest(".board-column")?.querySelector("header strong")?.textContent === "Ready");
  await page.getByRole("button", { name: "Close task details" }).click();
  const card = page.locator(".board-card");
  const target = page.locator(".board-column").filter({
    has: page.locator("header strong").filter({ hasText: "In review" }),
  });
  await card.dragTo(target);
  await waitFor(
    () =>
      document.querySelector(
        'select[aria-label="Status for Verified workflow"]',
      )?.value === "review",
  );
  checks.push("board select and drag moves");
  await page
    .getByRole("button", { name: "Verified workflow", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start an attempt", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start attempt", exact: true })
    .click();
  await page.locator(".xterm-helper-textarea").waitFor();
  await page.locator(".terminal-connection").waitFor({ state: "detached" });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf '%s%s\\n' 'IMMEDIATE_' 'INPUT'");
  await page.keyboard.press("Enter");
  await waitFor(() =>
    document
      .querySelector(".xterm-screen")
      ?.textContent?.includes("IMMEDIATE_INPUT"),
  );
  checks.push("terminal immediate input and output");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 760),
  );
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf '%s%s\\n' 'RESIZED_' 'OK'");
  await page.keyboard.press("Enter");
  await waitFor(() =>
    document
      .querySelector(".xterm-screen")
      ?.textContent?.includes("RESIZED_OK"),
  );
  checks.push("terminal resize and typing");
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.getByLabel("Canvas note").fill("Persisted verification note");
  await page.getByLabel("Canvas note").blur();
  await page.waitForTimeout(300);
  const node = page
    .locator(".react-flow__node")
    .filter({ has: page.locator(".canvas-note") });
  const before = await node.getAttribute("style");
  const handle = node.locator("header");
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 50, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 100, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const moved = await node.getAttribute("style");
  assert.notEqual(moved, before);
  await page.getByRole("button", { name: "↶ Undo move", exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(await node.getAttribute("style"), before);
  await page.getByRole("button", { name: "↷ Redo", exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(await node.getAttribute("style"), moved);
  await page.screenshot({ path: path.join(fixture, "canvas.png") });
  checks.push("canvas note persistence; drag; undo; redo");
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "hello.txt", exact: true }).click();
  await page.locator(".monaco-editor textarea").first().waitFor();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("edited in offline Monaco\n", { delay: 8 });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator(".folder-list button").filter({ hasText: "beta" }).click();
  assert.equal(await page.locator(".editor-overlay").count(), 1);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".editor-overlay .secondary")?.disabled,
  );
  assert.equal(
    await readFile(path.join(repo, "hello.txt"), "utf8"),
    "edited in offline Monaco\n",
  );
  checks.push("offline Monaco save; unsaved project navigation cancel");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("local conflict\n");
  await writeFile(path.join(repo, "hello.txt"), "external conflict\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "File conflict" }).waitFor();
  assert.equal(
    await readFile(path.join(repo, "hello.txt"), "utf8"),
    "external conflict\n",
  );
  checks.push("external write conflict refuses stale save");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Reload file from disk").click();
  await page.waitForFunction(() =>
    document
      .querySelector(".monaco-editor .view-lines")
      ?.textContent?.replaceAll("\u00a0", " ")
      .includes("external conflict"),
  );
  assert(
    await page.getByRole("button", { name: "Save", exact: true }).isDisabled(),
  );
  checks.push(
    "explicit reload resolves external conflict with on-disk content",
  );
  await page.getByLabel("Close editor").click();
  await page.getByLabel("Dismiss error").click();
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.getByLabel("Refresh files and git").click();
  await page
    .locator(".file-row")
    .filter({ hasText: "hello.txt" })
    .locator("button")
    .first()
    .click();
  await page.locator(".editor-overlay").waitFor();
  await page.getByLabel("Close editor").click();
  await page.getByLabel("Stage hello.txt", { exact: true }).click();
  await page.getByLabel("Unstage hello.txt", { exact: true }).waitFor();
  await page
    .locator(".file-row")
    .filter({ hasText: "hello.txt" })
    .locator("button")
    .first()
    .click();
  await page.locator(".monaco-editor textarea").first().waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".monaco-editor .view-lines")
      ?.textContent?.replaceAll("\u00a0", " ")
      .includes("external conflict"),
  );
  await page.getByLabel("Close editor").click();
  await page.getByLabel("Unstage hello.txt", { exact: true }).click();
  await page.getByLabel("Stage hello.txt", { exact: true }).waitFor();
  await page.getByLabel("Stage hello.txt", { exact: true }).click();
  await page.getByLabel("Unstage hello.txt", { exact: true }).waitFor();
  await page.getByLabel("Commit message").fill("Verified UI commit");
  await page
    .getByRole("button", { name: "Commit staged changes", exact: true })
    .click();
  await page.getByText("Working tree is clean", { exact: true }).waitFor();
  assert.equal(
    execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
    "Verified UI commit",
  );
  checks.push("unstaged/staged diff; stage; unstage; commit");
  await writeFile(path.join(repo, "untracked.txt"), "new file\n");
  await page.getByLabel("Refresh files and git").click();
  await page
    .locator(".file-row")
    .filter({ hasText: "untracked.txt" })
    .locator("button")
    .first()
    .click();
  await page.locator(".monaco-editor textarea").first().waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".monaco-editor .view-lines")
      ?.textContent?.replaceAll("\u00a0", " ")
      .includes("new file"),
  );
  await page.getByLabel("Close editor").click();
  checks.push("untracked content preview");
  await page.getByRole("button", { name: "Worktrees", exact: true }).click();
  await page.getByPlaceholder("feature/my-change").fill("verify/isolated");
  await page
    .getByRole("button", { name: "Create worktree", exact: true })
    .click();
  await page.getByText("verify/isolated", { exact: true }).waitFor();
  checks.push("worktree creation and listing");
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page
    .getByRole("button", { name: "Start an attempt", exact: true })
    .click();
  await page
    .getByLabel("Working directory")
    .selectOption({ label: "verify/isolated" });
  const tree = (await command("worktree.list", { projectId: p1.id })).find(
    (t) => t.branch === "verify/isolated",
  );
  await rename(tree.path, tree.path + "-unavailable");
  await page
    .getByRole("button", { name: "Start attempt", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check same launch", exact: true })
    .waitFor();
  assert.equal((await snapshot()).attempts.length, 1);
  await rename(tree.path + "-unavailable", tree.path);
  await page
    .getByRole("button", { name: "Check same launch", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start an attempt" })
    .waitFor({ state: "detached" });
  await page.getByLabel("Dismiss error").click();
  checks.push(
    "failed launch retries same immutable request after directory recovery; no duplicate attempt",
  );
  await page.locator(".terminal-connection").waitFor({ state: "detached" });
  let state = await snapshot();
  assert.equal(state.attempts.length, 2);
  assert.notEqual(state.attempts[0].sessionId, state.attempts[1].sessionId);
  assert.notEqual(
    state.attempts[0].worktreePath,
    state.attempts[1].worktreePath,
  );
  for (const attemptLabel of ["#1", "#2"]) {
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.locator(".attempt-row").filter({ hasText: attemptLabel }).click();
    await page.locator(".session-view").waitFor();
    await page.locator(".terminal-connection").waitFor({ state: "detached" });
  }
  assert.equal((await snapshot()).sessions.filter((s) => s.status === "running").length, 2);
  checks.push(
    "second attempt bound to isolated worktree; attempt switching preserves distinct sessions",
  );

  await page.locator(".folder-list button").filter({ hasText: "beta" }).click();
  await page.getByText("Open an agent or a shell here", { exact: true }).waitFor();
  await page.locator(".folder-list button").filter({ hasText: "alpha" }).click();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByLabel("Canvas note").waitFor();
  assert.equal(
    await page.getByLabel("Canvas note").inputValue(),
    "Persisted verification note",
  );
  checks.push("multiple-project switching; persisted notes and layout");
  await page.waitForFunction(()=>document.querySelectorAll(".terminal-connection").length===0);
  await page.screenshot({ path: path.join(fixture, "final.png") });
  const plain = path.join(fixture, "plain-folder");
  await mkdir(plain);
  await writeFile(
    path.join(plain, "plain.txt"),
    "plain directory editor works\n",
  );
  await command("project.add", { path: plain });
  await page
    .locator(".folder-list button")
    .filter({ hasText: "plain-folder" })
    .click();
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await page.getByText("No Git", { exact: true }).waitFor();
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page
    .getByText(
      "This folder isn't a Git repository. Files and terminals work normally; run git init in a Shell here to review changes.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "plain.txt", exact: true }).click();
  await page.locator(".monaco-editor textarea").first().waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".monaco-editor .view-lines")
      ?.textContent?.replaceAll("\u00a0", " ")
      .includes("plain directory editor works"),
  );
  await page.screenshot({ path: path.join(fixture, "plain-folder.png") });
  await page.getByLabel("Close editor").click();
  checks.push(
    "non-Git folder clearly reports unavailable git; file browsing/editor works",
  );

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fixture, checks }));
} catch (error) {
  await page.screenshot({ path: path.join(fixture, "failure.png") });
  console.error(
    JSON.stringify({ passed: false, fixture, checks, error: String(error) }),
  );
  process.exitCode = 1;
} finally {
  try {
    const state = await snapshot();
    for (const session of state.sessions) {
      try {
        await command("session.attach", {
          sessionId: session.id,
          generation: session.generation,
          viewerId: "cleanup",
        });
        await command("session.terminate", {
          sessionId: session.id,
          generation: session.generation,
          viewerId: "cleanup",
        });
      } catch {}
    }
  } catch {}
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await cleanupFixture(fixture);
}
