import { _electron as electron } from "playwright";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { cleanupFixture } from "./fixture-cleanup.mjs";

// Recipient-first Claude -> Codex sharing. Both CLIs are disposable fixtures;
// the Codex fixture executes the real awctl reader only after Enter is sent.
const fixture = await realpath(
  await mkdtemp(path.join(tmpdir(), "aw-connect-")),
);
const repo = path.join(fixture, "project");
const otherRepo = path.join(fixture, "other-project");
const home = path.join(fixture, "home");
const bin = path.join(fixture, "bin");
const shots = path.resolve(
  process.env.WORKSPACE_SCREENSHOT_DIR || "release/connect-verification",
);
const submissionsFile = path.join(fixture, "codex-submissions.jsonl");
await Promise.all(
  [repo, otherRepo, home, bin, shots].map((p) => mkdir(p, { recursive: true })),
);
await writeFile(submissionsFile, "");
await writeFile(
  path.join(bin, "claude"),
  `#!${process.execPath}\nrequire(${JSON.stringify(path.resolve("scripts/claude-fixture.cjs"))});\n`,
  { mode: 0o700 },
);
await writeFile(
  path.join(bin, "codex"),
  `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--help')) { console.log('codex --model <model>'); process.exit(0); }
console.log('CODEX_FIXTURE_READY');
require('node:readline').createInterface({input:process.stdin}).on('line', (line) => {
  const link = line.match(/awctl transcript read --link ([a-f0-9-]+)/)?.[1];
  let response;
  if (link) {
    const result = spawnSync(process.env.AWCTL || 'awctl', ['transcript','read','--link',link], {encoding:'utf8'});
    response = {code:result.status, output:result.stdout, error:result.stderr};
    console.log('READ_RESULT ' + result.stdout);
  }
  fs.appendFileSync(process.env.AW_CONNECT_SUBMISSIONS, JSON.stringify({line,response})+'\\n');
  console.log('CODEX_FIXTURE_READY');
});
`,
  { mode: 0o700 },
);
const env = {
  ...process.env,
  HOME: home,
  SHELL: "/bin/sh",
  PATH: bin + path.delimiter + process.env.PATH,
  WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
  AW_CONNECT_SUBMISSIONS: submissionsFile,
};
delete env.CLAUDE_CONFIG_DIR;
const app = await electron.launch({
  ...(process.env.WORKSPACE_APP_EXECUTABLE
    ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
    : { args: ["."] }),
  env,
});
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const invoke = (command, payload = {}) =>
  page.evaluate(
    ({ command, payload }) => window.workspace.invoke(command, payload),
    { command, payload },
  );
const snapshot = () => invoke("snapshot");
const submissions = async () =>
  (await readFile(submissionsFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((x) => JSON.parse(x));
async function poll(fn, label) {
  for (let i = 0; i < 240; i++) {
    if (await fn()) return;
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out: " + label);
}
async function source(projectId, title, text) {
  const { session } = await invoke("terminal.open", {
    projectId,
    provider: "claude",
    idempotencyKey: title,
  });
  await invoke("session.rename", {
    sessionId: session.id,
    generation: session.generation,
    title,
    titleRevision: 0,
  });
  const identity = {
    sessionId: session.id,
    generation: session.generation,
    viewerId: "test-source-" + session.id,
  };
  await invoke("session.attach", { ...identity, cols: 100, rows: 30 });
  await invoke("session.input", { ...identity, data: text + "\r" });
  await poll(
    async () =>
      (await snapshot()).sessions.find((s) => s.id === session.id)?.activity ===
      "done",
    title + " wrote its transcript",
  );
  await invoke("session.detach", identity);
  return session;
}
const dialog = page.getByRole("dialog", {
  name: "Connect agents",
  exact: true,
});
const close = () =>
  dialog.getByRole("button", { name: "Close", exact: true }).click();
const open = () =>
  page.getByRole("button", { name: "Connect agents", exact: true }).click();
try {
  await page.waitForFunction(() => !!window.workspace?.agentControl);
  const capabilities = (await snapshot()).capabilities;
  for (const name of ["claude", "codex"])
    assert.equal(
      capabilities.find((c) => c.name === name).detail,
      path.join(bin, name),
      "only the fixture CLI can run",
    );
  const project = await invoke("project.add", { path: repo });
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await poll(
    async () => (await snapshot()).sessions.some((s) => s.provider === "codex"),
    "Codex launched",
  );
  const recipient = (await snapshot()).sessions.find(
    (s) => s.provider === "codex",
  );
  await page.locator('.session-view[aria-label="Codex session"]').waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".xterm-rows")
      ?.textContent?.includes("CODEX_FIXTURE_READY"),
  );
  await open();
  await dialog
    .getByText(/No Claude conversation is available in this folder yet/)
    .waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "Preview transcript" }).count(),
    0,
  );
  await close();
  checks.push(
    "Codex can open Connect agents before a source exists; the empty state explains how to create a Claude conversation",
  );

  const alpha = await source(
    project.id,
    "Claude Alpha",
    "ALPHA_CONTEXT private-alpha",
  );
  await open();
  assert.equal(
    await dialog
      .getByLabel("Claude conversation", { exact: true })
      .inputValue(),
    alpha.id,
  );
  await dialog.getByText("Receiving session: Codex", { exact: true }).waitFor();
  assert.equal(
    (await invoke("transcript.list", { sessionId: recipient.id })).length,
    0,
  );
  assert.equal(
    (
      await page.evaluate(
        (id) => window.workspace.agentControl.list({ sessionId: id }),
        recipient.id,
      )
    ).grant,
    null,
  );
  await close();
  checks.push(
    "A single local Claude source is preselected and Codex stays the recipient; selecting a source creates no link or permission",
  );

  const beta = await source(
    project.id,
    "Claude Beta",
    "BETA_CONTEXT private-beta",
  );
  const elsewhere = await invoke("project.add", { path: otherRepo });
  const outside = await source(
    elsewhere.id,
    "Outside folder",
    "OUTSIDE_CONTEXT",
  );
  await open();
  const picker = dialog.getByLabel("Claude conversation", { exact: true });
  assert.equal(await picker.inputValue(), "");
  const options = await picker
    .locator("option")
    .evaluateAll((nodes) => nodes.map((n) => n.value));
  assert.deepEqual(new Set(options), new Set(["", alpha.id, beta.id]));
  assert.equal(options.includes(outside.id), false);
  await picker.selectOption(alpha.id);
  await dialog.getByRole("button", { name: "Preview transcript" }).click();
  await dialog.getByText("Raw transcript and precise redaction").click();
  const raw = dialog.getByLabel("Transcript preview");
  assert.match(await raw.inputValue(), /ALPHA_CONTEXT/);
  const text = await raw.inputValue();
  const at = text.indexOf("private-alpha");
  await raw.evaluate((el, at) => {
    el.focus();
    el.setSelectionRange(at, at + 13);
  }, at);
  await dialog.getByRole("button", { name: "Redact selection" }).click();
  await dialog.getByLabel(/Allow the recipient to read snapshots/).check();
  await picker.selectOption(beta.id);
  await dialog.getByRole("button", { name: "Preview transcript" }).waitFor();
  assert.equal(await dialog.getByLabel("Transcript preview").count(), 0);
  await dialog.getByRole("button", { name: "Preview transcript" }).click();
  await dialog.getByText("Raw transcript and precise redaction").click();
  assert.match(await raw.inputValue(), /BETA_CONTEXT/);
  assert.doesNotMatch(await raw.inputValue(), /ALPHA_CONTEXT/);
  assert.equal(await dialog.locator(".redaction-list button").count(), 0);
  assert.equal(
    await dialog
      .getByLabel(/Allow the recipient to read snapshots/)
      .isChecked(),
    false,
  );
  assert.equal(
    await dialog.getByLabel("Give to", { exact: true }).inputValue(),
    recipient.id,
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "Connect", exact: true })
      .isDisabled(),
    true,
  );
  await page.screenshot({ path: path.join(shots, "codex-choose-claude.png") });
  checks.push(
    "Multiple sources are labeled by name, state and time; only this folder is listed; switching source clears the previous preview, redactions and consent",
  );

  await dialog.getByLabel(/Allow the recipient to read snapshots/).check();
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog
    .getByText("Snapshot connected to Codex", { exact: true })
    .waitFor();
  const [link] = await invoke("transcript.list", { sessionId: recipient.id });
  assert.equal(link.source.sessionId, beta.id);
  assert.equal(link.recipient.sessionId, recipient.id);
  assert.equal(link.reads, 0);
  const access = await page.evaluate(
    (id) => window.workspace.agentControl.list({ sessionId: id }),
    recipient.id,
  );
  assert.deepEqual(access.grant.verbs, ["transcript.read"]);
  await dialog
    .getByRole("button", { name: "Open recipient with instructions" })
    .click();
  await poll(
    () => page.getByRole("button", { name: "Insert instructions" }).isEnabled(),
    "recipient attached",
  );
  await page.getByRole("button", { name: "Insert instructions" }).click();
  await page
    .getByRole("region", { name: "Shared context instructions" })
    .waitFor({ state: "hidden" });
  await page.waitForFunction(
    (id) => document.querySelector(".xterm-rows")?.textContent?.includes(id),
    link.id,
  );
  assert.equal((await submissions()).length, 0);
  assert.equal(
    (await invoke("transcript.list", { sessionId: recipient.id }))[0].reads,
    0,
  );
  await page.screenshot({
    path: path.join(shots, "codex-instructions-ready.png"),
  });
  checks.push(
    "Connecting from Codex grants only transcript.read; instructions insert into the same Codex process without submitting or reading",
  );

  await page.locator(".session-view .xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
  await poll(
    async () => (await submissions()).length === 1,
    "Codex fixture executed the inserted read command",
  );
  const [sent] = await submissions();
  assert.equal(sent.response.code, 0, JSON.stringify(sent));
  assert.match(sent.response.output, /BETA_CONTEXT/);
  assert.doesNotMatch(sent.response.output, /ALPHA_CONTEXT|OUTSIDE_CONTEXT/);
  assert.equal(
    (await invoke("transcript.list", { sessionId: recipient.id }))[0].reads,
    1,
  );
  await open();
  await dialog
    .locator(".link-row")
    .filter({ hasText: "From Claude Beta" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await dialog.locator(".link-row.revoked").waitFor();
  await close();
  await page.locator(".session-view .xterm-helper-textarea").focus();
  await page.keyboard.type(sent.line);
  await page.keyboard.press("Enter");
  await poll(
    async () => (await submissions()).length === 2,
    "revoked read answered",
  );
  const denied = (await submissions())[1];
  assert.notEqual(denied.response.code, 0);
  assert.match(denied.response.output, /revoked/);
  checks.push(
    "After Enter the Codex fixture reads only the selected Claude snapshot through real awctl; revocation blocks its next read",
  );
  assert.deepEqual(errors, []);
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
