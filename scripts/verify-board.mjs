import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// The live session board: cards are the running sessions. Moving, opening and
// closing a card must never restart, detach or type into the process.
const fixture = await mkdtemp(path.join(tmpdir(), "agent-board-"));
const repo = path.join(fixture, "alpha");
const bin = path.join(fixture, "bin");
const screenshots = path.resolve("docs/screenshots/desktop");
await mkdir(repo);
await mkdir(bin);
await mkdir(screenshots, { recursive: true });
await writeFile(path.join(repo, "hello.txt"), "board fixture\n");
for (const args of [
  ["init", "-q"],
  ["config", "user.name", "Fixture"],
  ["config", "user.email", "fixture@example.invalid"],
  ["add", "."],
  ["commit", "-qm", "Fixture"],
])
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
// A fixture Claude: supports --session-id/--settings, reports "needs you"
// through the hook it was given, then stays open like the real interface.
await writeFile(
  path.join(bin, "claude"),
  `#!${process.execPath}
const { execSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  process.stdout.write("Usage: fixture [options]\\n  --session-id <uuid>\\n  --settings <file-or-json>\\n");
  process.exit(0);
}
process.stdout.write("Fixture Claude " + (args.includes("--resume") ? "resumed" : "ready") + "\\n");
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
execSync(settings.hooks.Notification[0].hooks[0].command, { stdio: "ignore" });
setInterval(() => {}, 1000);
`,
  { mode: 0o700 },
);
const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";
const app = await electron.launch({
  executablePath: process.env.WORKSPACE_APP_EXECUTABLE,
  args: process.env.WORKSPACE_APP_EXECUTABLE ? [] : ["."],
  env: {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
  },
});
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
const errors = [];
const checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const invoke = (command, payload = {}) =>
  page.evaluate(
    ({ command, payload }) => window.workspace.invoke(command, payload),
    {
      command,
      payload,
    },
  );
const snapshot = () => invoke("snapshot");
const sessionById = async (id) =>
  (await snapshot()).sessions.find((s) => s.id === id);
async function poll(check, label) {
  for (let i = 0; i < 200; i++) {
    try {
      if (await check()) return;
    } catch {}
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out: " + label);
}
let socket;
const panePid = (backendName) =>
  execFileSync(
    tmux,
    [
      "-S",
      socket,
      "display-message",
      "-p",
      "-t",
      "=" + backendName + ":0.0",
      "#{pane_pid}",
    ],
    {
      encoding: "utf8",
    },
  ).trim();
const readText = (name) => readFile(path.join(repo, name), "utf8");
const fileWritten = (name) =>
  poll(
    async () =>
      existsSync(path.join(repo, name)) &&
      (await readText(name)).endsWith("\n"),
    name,
  );
const card = (title) =>
  page.locator(".session-card").filter({ hasText: title });
const lane = (id) => page.locator(`.lane[data-lane="${id}"]`);
const liveCard = () => page.getByRole("dialog", { name: /^Live card/ });
async function typeIn(scope, text) {
  await scope.locator(".xterm-screen").waitFor();
  await scope.locator(".terminal-connection").waitFor({ state: "detached" });
  // Typing before tmux has redrawn the attached pane can be lost; wait for the prompt.
  await poll(
    async () =>
      (await scope.locator(".xterm-screen").textContent()).trim().length > 0,
    "terminal drawn",
  );
  await scope.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
try {
  await page.waitForFunction(() => !!window.workspace);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 900),
  );
  socket = path.join(
    tmpdir(),
    `aw-${createHash("sha256")
      .update(await realpath(path.join(fixture, "data")))
      .digest("hex")
      .slice(0, 20)}.sock`,
  );
  const project = await invoke("project.add", { path: repo });
  await page
    .locator(".folder-list button")
    .filter({ hasText: "alpha" })
    .click();

  // Two sessions started the ordinary way, each reporting its own PID.
  await page.getByRole("button", { name: "Open Shell here" }).click();
  await typeIn(
    page.locator(".session-view"),
    `printf 'PID=%s\\n' "$$" > first-pid.txt`,
  );
  await fileWritten("first-pid.txt");
  const firstPid = await readText("first-pid.txt");
  let first = (await snapshot()).sessions[0];
  await invoke("session.rename", {
    sessionId: first.id,
    generation: 1,
    title: "First shell",
    titleRevision: 0,
  });
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByRole("button", { name: "Open Shell here" }).click();
  await page.locator(".session-view").waitFor();
  await poll(
    async () => (await snapshot()).sessions.length === 2,
    "second session",
  );
  const second = (await snapshot()).sessions.find((s) => s.id !== first.id);
  await invoke("session.rename", {
    sessionId: second.id,
    generation: 1,
    title: "Second shell",
    titleRevision: 0,
  });
  const tmuxPid = panePid(first.backendName);
  checks.push("two shells started from the folder; each reports its PID");

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.locator(".lanes").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Sessions", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.deepEqual(await page.locator(".lane-name").allTextContents(), [
    "Ready",
    "In progress",
    "In review",
    "Done",
  ]);
  await card("First shell").waitFor();
  assert.equal(await lane("working").locator(".session-card").count(), 2);
  assert.equal(
    (await snapshot()).sessions.every((s) => s.lane === undefined),
    true,
    "default lanes are not written",
  );
  checks.push(
    "Sessions is the default board mode; four default lanes; open sessions show in In progress without writing a lane",
  );

  await card("First shell").dragTo(lane("review"));
  await poll(
    async () => (await sessionById(first.id)).lane === "review",
    "drag to Review",
  );
  first = await sessionById(first.id);
  assert.equal(first.generation, 1);
  assert.equal(first.placementRevision, 1);
  assert.equal(first.status, "running");
  assert.equal(panePid(first.backendName), tmuxPid);
  await lane("review")
    .locator(".session-card")
    .filter({ hasText: "First shell" })
    .waitFor();
  // The terminals view still drives the same shell after the move.
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await page.locator(".session-tab").filter({ hasText: "First shell" }).click();
  await typeIn(
    page.locator(".session-view"),
    `printf 'PID=%s\\n' "$$" > after-drag.txt`,
  );
  await fileWritten("after-drag.txt");
  assert.equal(await readText("after-drag.txt"), firstPid);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  checks.push(
    "drag to Review is metadata only: same tmux PID, shell PID and generation; terminal still accepts input",
  );

  await page.getByRole("button", { name: "Move to… (Second shell)" }).click();
  await card("Second shell").getByRole("menuitem", { name: "Ready" }).click();
  await poll(
    async () => (await sessionById(second.id)).lane === "next",
    "Move to Ready",
  );
  await lane("next")
    .locator(".session-card")
    .filter({ hasText: "Second shell" })
    .waitFor();
  assert.equal((await sessionById(second.id)).generation, 1);
  checks.push("Move to… menu files a card in another lane");

  await lane("review").locator(".lane-name").dblclick();
  await page.getByLabel("Lane name", { exact: true }).fill("QA");
  await page.getByLabel("Lane name", { exact: true }).press("Enter");
  await poll(
    async () =>
      (await snapshot()).boardLanes[0]?.lanes.find((l) => l.id === "review")
        ?.name === "QA",
    "lane rename",
  );
  await lane("review")
    .locator(".lane-name")
    .filter({ hasText: "QA" })
    .waitFor();
  checks.push("rename a lane inline (revisioned per-folder record)");

  await card("First shell").locator(".session-card-open").click();
  await liveCard().waitFor();
  await typeIn(liveCard(), `printf 'PID=%s\\n' "$$" > live-pid.txt`);
  await fileWritten("live-pid.txt");
  assert.equal(await readText("live-pid.txt"), firstPid);
  await liveCard().getByRole("button", { name: "Rename session" }).click();
  await liveCard().getByLabel("Session name").fill("First live");
  await liveCard().getByLabel("Session name").press("Enter");
  await poll(
    async () => (await sessionById(first.id)).title === "First live",
    "rename in live card",
  );
  await liveCard().getByLabel("Lane", { exact: true }).selectOption("done");
  await poll(
    async () => (await sessionById(first.id)).lane === "done",
    "lane picker",
  );
  await page.screenshot({
    path: path.join(screenshots, "board-live-card.png"),
  });
  await liveCard().getByRole("button", { name: "Close live card" }).click();
  await liveCard().waitFor({ state: "detached" });
  first = await sessionById(first.id);
  assert.equal(first.status, "running");
  assert.equal(first.generation, 1);
  assert.equal(panePid(first.backendName), tmuxPid);
  // Escape outside the terminal closes the card too; still the same process.
  await card("First live").locator(".session-card-open").click();
  await liveCard()
    .locator(".terminal-connection")
    .waitFor({ state: "detached" });
  await liveCard().getByRole("button", { name: "Close live card" }).focus();
  await page.keyboard.press("Escape");
  await liveCard().waitFor({ state: "detached" });
  assert.equal(panePid(first.backendName), tmuxPid);
  checks.push(
    "live card attaches the real terminal (typed input reaches the same shell), renames, changes lane; closing (button or Esc) only detaches",
  );

  await page.getByRole("button", { name: "Start a session in QA" }).click();
  await lane("review").getByRole("menuitem", { name: "Shell" }).click();
  await poll(
    async () => (await snapshot()).sessions.length === 3,
    "lane + shell",
  );
  const third = (await snapshot()).sessions.find(
    (s) => ![first.id, second.id].includes(s.id),
  );
  await poll(
    async () => (await sessionById(third.id)).lane === "review",
    "new shell placed in QA",
  );
  assert.equal((await sessionById(third.id)).status, "running");
  assert.equal(
    await page.locator(".lanes").isVisible(),
    true,
    "launching from a lane stays on the board",
  );
  await lane("review").locator(".session-card").first().waitFor();
  checks.push(
    "+ in a lane starts a shell through the normal launch and files it in that lane",
  );

  await page.getByRole("button", { name: "Start a session in Ready" }).click();
  await lane("next").getByRole("menuitem", { name: "Claude" }).click();
  await poll(
    async () =>
      (await snapshot()).sessions.some(
        (s) => s.provider === "claude" && s.lane === "next",
      ),
    "claude in Up next",
  );
  let claude = (await snapshot()).sessions.find((s) => s.provider === "claude");
  await poll(
    async () => (await sessionById(claude.id)).activity === "needs",
    "claude needs you",
  );
  await lane("next").locator(".session-card.tone-needs").waitFor();
  checks.push("Claude started in Ready; its Needs you card is highlighted");

  // End it from the live card (existing confirmation), then resume from the card.
  await lane("next")
    .locator(".session-card.tone-needs .session-card-open")
    .click();
  await liveCard()
    .locator(".terminal-connection")
    .waitFor({ state: "detached" });
  page.once("dialog", (dialog) => dialog.accept());
  await liveCard().getByRole("button", { name: "End", exact: true }).click();
  await poll(
    async () => (await sessionById(claude.id)).status === "exited",
    "claude ended",
  );
  await liveCard().getByRole("button", { name: "Close live card" }).click();
  const endedCard = page.locator(
    `.session-card[data-session-id="${claude.id}"]`,
  );
  await endedCard.locator(".session-card-open").waitFor();
  assert.match(await endedCard.getAttribute("class"), /is-ended/);
  await endedCard.getByRole("button", { name: "New here" }).waitFor();
  await endedCard.getByRole("button", { name: "Resume" }).click();
  await poll(
    async () =>
      (await snapshot()).sessions.some((s) => s.resumedFrom === claude.id),
    "resume",
  );
  const resumed = (await snapshot()).sessions.find(
    (s) => s.resumedFrom === claude.id,
  );
  assert.equal(resumed.conversationId, claude.conversationId);
  await poll(
    async () => (await sessionById(resumed.id)).lane === "next",
    "resumed card keeps the lane",
  );
  await liveCard().waitFor();
  await liveCard().getByRole("button", { name: "Close live card" }).click();
  // An ended shell offers only a fresh start.
  await invoke("session.attach", {
    sessionId: third.id,
    generation: 1,
    viewerId: "verify-end",
  });
  await invoke("session.terminate", {
    sessionId: third.id,
    generation: 1,
    viewerId: "verify-end",
  });
  const endedShell = page.locator(
    `.session-card[data-session-id="${third.id}"]`,
  );
  await endedShell.getByRole("button", { name: "New here" }).waitFor();
  assert.equal(
    await endedShell.getByRole("button", { name: "Resume" }).count(),
    0,
  );
  checks.push(
    "ended cards are dimmed with Resume (Claude conversation) and New here; Resume keeps the lane and opens the new live card",
  );

  assert.equal(panePid(first.backendName), tmuxPid);
  assert.equal((await sessionById(first.id)).generation, 1);
  await poll(
    async () => (await sessionById(resumed.id)).activity === "needs",
    "resumed claude needs you",
  );
  await lane("next").locator(".session-card.tone-needs").waitFor();
  for (const close of await page
    .getByRole("button", { name: "Dismiss notification" })
    .all())
    await close.click().catch(() => {});
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(screenshots, "board-sessions.png") });
  // Tasks mode is still the task board.
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).waitFor();
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.locator(".lanes").waitFor();
  checks.push(
    "Sessions | Tasks switch keeps the task board; first shell unchanged at the end",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, fixture, project: project.id, checks }),
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(fixture, "failure.png") })
    .catch(() => {});
  console.error(
    JSON.stringify({
      passed: false,
      fixture,
      checks,
      errors,
      error: String(error?.stack || error),
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    for (const session of (await snapshot()).sessions) {
      try {
        await invoke("session.attach", {
          sessionId: session.id,
          generation: session.generation,
          viewerId: "cleanup",
        });
        await invoke("session.terminate", {
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
