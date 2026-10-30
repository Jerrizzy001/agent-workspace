import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const fixture = await mkdtemp(path.join(tmpdir(), "agent-terminal-modes-"));
const repo = path.join(fixture, "repo");
await mkdir(repo);
await writeFile(
  path.join(repo, "fixture.txt"),
  "Disposable terminal verification",
);
for (const args of [
  ["init"],
  ["config", "user.name", "Fixture"],
  ["config", "user.email", "fixture@example.invalid"],
  ["add", "."],
  ["commit", "-m", "Fixture"],
])
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
const app = await electron.launch({
  executablePath: process.env.WORKSPACE_APP_EXECUTABLE,
  args: process.env.WORKSPACE_APP_EXECUTABLE ? [] : ["."],
  env: { ...process.env, WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
});
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
const checks = [];
const invoke = (command, payload = {}) =>
  page.evaluate(
    ({ command, payload }) => window.workspace.invoke(command, payload),
    { command, payload },
  );
async function screenIncludes(text) {
  await page.waitForFunction(
    (value) =>
      [...document.querySelectorAll(".xterm-screen")].some((node) =>
        node.textContent?.includes(value),
      ),
    text,
  );
}
async function type(command) {
  await page.bringToFront();
  await page.locator(".xterm-helper-textarea").first().focus();
  assert(await page.locator(".xterm-helper-textarea").first().evaluate((element) => element === document.activeElement));
  await page.keyboard.type(command, { delay: 1 });
  await page.keyboard.press("Enter");
}
try {
  await page.waitForFunction(() => !!window.workspace);
  const project = await invoke("project.add", { path: repo });
  const task = await invoke("task.create", {
    projectId: project.id,
    title: "Terminal modes fixture",
  });
  await invoke("attempt.start", {
    taskId: task.id,
    provider: "shell",
    idempotencyKey: "terminal-mode-fixture",
  });
  await page
    .locator(".session-row")
    .filter({ hasText: "Terminal modes fixture" })
    .click();
  await page.locator(".terminal-connection").waitFor({ state: "detached" });
  await type(
    `python3 -c 'import sys; sys.stdout.write("\\033[?1049h\\033[2J\\033[4;6H" + "ALT_" + "SCREEN_654" + " \\u4e16\\u754c \\u03bb"); sys.stdout.flush(); input(); sys.stdout.write("\\033[?1049l"); sys.stdout.flush()'`,
  );
  await screenIncludes("ALT_SCREEN_654 世界 λ");
  checks.push("Unicode render and explicit ANSI alternate screen");
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await screenIncludes("ALT_SCREEN_654 世界 λ");
  await page.screenshot({ path: path.join(fixture, "alternate-canvas.png") });
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await screenIncludes("ALT_SCREEN_654 世界 λ");
  checks.push("alternate-screen redraw across board/canvas/terminals");
  await page.locator(".xterm-helper-textarea").first().focus();
  await page.keyboard.press("Enter");
  await type(`python3 -c 'print("NORMAL_" + "BUFFER_987")'`);
  await screenIncludes("NORMAL_BUFFER_987");
  checks.push("alternate screen exit restores usable normal buffer");
  await type(
    `python3 -c 'import sys; [sys.stdout.write("line %05d\\n" % i) for i in range(10000)]; print("BURST_"+"COMPLETE_321"); sys.stdout.flush()'`,
  );
  await screenIncludes("BURST_COMPLETE_321");
  await page.waitForTimeout(300);
  const state = await invoke("snapshot");
  const session = state.sessions[0];
  const captured = (
    await invoke("session.capture", {
      sessionId: session.id,
      generation: session.generation,
    })
  ).data;
  const rendered = await page.locator(".xterm-screen").innerText();
  await writeFile(path.join(fixture, "burst-capture.txt"), captured);
  await writeFile(path.join(fixture, "burst-rendered.txt"), rendered);
  await page.screenshot({
    path: path.join(fixture, "burst-before-followup.png"),
  });
  const actual = [...rendered.matchAll(/line\s+(\d{5})/g)].map((match) =>
    Number(match[1]),
  );
  const expected = [...captured.matchAll(/line\s+(\d{5})/g)].map((match) =>
    Number(match[1]),
  );
  assert(actual.length > 10, "Expected more than ten visible burst lines");
  assert.equal(
    new Set(actual).size,
    actual.length,
    "Visible lines must be distinct",
  );
  assert.deepEqual(
    actual,
    expected.slice(-actual.length),
    "Visible terminal rows must equal final tmux rows in order",
  );
  checks.push(
    "burst visible rows are distinct, sequential, and match tmux capture",
  );

  await type(`printf '%s%s\\n' 'POST_BURST_' 'USABLE_789'`);
  await screenIncludes("POST_BURST_USABLE_789");
  checks.push("10000 line burst drains and subsequent typing works");
  await page.screenshot({ path: path.join(fixture, "burst.png") });
  await page.evaluate(() => {
    globalThis.__resyncs = 0;
    window.workspace.subscribe((event) => {
      if (event.type === "terminal.resync") globalThis.__resyncs++;
    });
  });
  await type(
    `printf '%s%s\\n' 'SLOW_FIXTURE_' 'STARTED'; python3 -c 'import sys,time; [(sys.stdout.write("line %05d " % i + "x"*200 + "\\n"),sys.stdout.flush(),time.sleep(0.0005)) for i in range(10000)]; print("RESYNC_"+"COMPLETE_765")'`,
  );
  await screenIncludes("SLOW_FIXTURE_STARTED");
  await page.evaluate(() => {
    const until = Date.now() + 8500;
    while (Date.now() < until) {}
  });
  await screenIncludes("RESYNC_COMPLETE_765");
  await page.waitForTimeout(200);
  const afterCapture = (
    await invoke("session.capture", {
      sessionId: session.id,
      generation: session.generation,
    })
  ).data;
  const afterRender = await page.locator(".xterm-screen").innerText();
  await writeFile(path.join(fixture, "resync-capture.txt"), afterCapture);
  await writeFile(path.join(fixture, "resync-rendered.txt"), afterRender);
  await page.screenshot({ path: path.join(fixture, "resync.png") });
  const visible = [...afterRender.matchAll(/line\s+(\d{5})/g)].map((m) =>
    Number(m[1]),
  );
  const backend = [...afterCapture.matchAll(/line\s+(\d{5})/g)].map((m) =>
    Number(m[1]),
  );
  assert(visible.length > 4);
  assert.equal(new Set(visible).size, visible.length);
  assert.deepEqual(visible, backend.slice(-visible.length));
  const resyncs = await page.evaluate(() => globalThis.__resyncs);
  assert(resyncs > 0, "Slow viewer fixture must trigger an actual resync");
  assert.equal(await page.locator(".terminal-wrap [role='alert']").count(), 0, "Recovered terminal must not retain a stream error");
  assert.equal(await page.locator(".terminal-connection").count(), 0, "Recovered terminal must finish connecting");
  await type(`printf '%s%s\\n' 'POST_RESYNC_' 'USABLE_654'`);
  await screenIncludes("POST_RESYNC_USABLE_654");
  assert.equal(await page.locator(".terminal-wrap [role='alert']").count(), 0);
  await page.screenshot({ path: path.join(fixture, "resync-usable.png") });
  checks.push(
    "blocked renderer triggers real bounded-stream resync; visible rows match tmux; no error/spinner; subsequent typing works",
  );
  await page.locator(".xterm-helper-textarea").first().evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", `printf '%s%s\\n' 'PASTED_' 'COMMAND_258'`);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press("Enter");
  await screenIncludes("PASTED_COMMAND_258");
  checks.push("terminal clipboard paste handler accepts a complete command after resync");

  console.log(JSON.stringify({ passed: true, fixture, checks }));
} catch (error) {
  await page.screenshot({ path: path.join(fixture, "failure.png") });
  console.error(
    JSON.stringify({ passed: false, fixture, checks, error: String(error) }),
  );
  process.exitCode = 1;
} finally {
  try {
    const state = await invoke("snapshot");
    for (const s of state.sessions) {
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
