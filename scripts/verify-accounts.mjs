import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// Claude profiles, conversation branches and transcript links (roadmap
// section 3), end to end in the desktop app with a fixture `claude` that
// honours CLAUDE_CONFIG_DIR, writes a JSONL transcript and fires its hooks.
// Nothing here runs the real Claude CLI or signs in to any account.
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "accounts-")));
const repo = path.join(fixture, "alpha");
const home = path.join(fixture, "home");
const bin = path.join(fixture, "bin");
const log = path.join(fixture, "claude.jsonl");
const screenshots = path.resolve(process.env.WORKSPACE_SCREENSHOT_DIR || "docs/screenshots/desktop");
await mkdir(repo);
await mkdir(home);
await mkdir(bin);
await mkdir(screenshots, { recursive: true });
await writeFile(path.join(repo, "README.md"), "accounts fixture\n");
await writeFile(
  path.join(bin, "claude"),
  `#!${process.execPath}\nrequire(${JSON.stringify(path.resolve("scripts/claude-fixture.cjs"))});\n`,
  { mode: 0o700 },
);
// The owner's global Claude files, which must not change.
await mkdir(path.join(home, ".claude"));
await writeFile(path.join(home, ".claude.json"), '{"global":true}\n');
const globalHash = () =>
  createHash("sha256")
    .update(readFileSync(path.join(home, ".claude.json")))
    .digest("hex");
const globalBefore = globalHash();
const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";
const env = {
  ...process.env,
  SHELL: "/bin/sh",
  HOME: home,
  PATH: bin + path.delimiter + process.env.PATH,
  CLAUDE_FIXTURE_LOG: log,
};
delete env.CLAUDE_CONFIG_DIR;
const app = await electron.launch({
  executablePath: process.env.WORKSPACE_APP_EXECUTABLE,
  args: process.env.WORKSPACE_APP_EXECUTABLE ? [] : ["."],
  env: { ...env, WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data") },
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
const profilesList = () =>
  page.evaluate(() => window.workspace.profiles.list());
const snapshot = () => invoke("snapshot");
async function poll(check, label, tries = 300) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await check()) return;
    } catch {}
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out: " + label);
}
let socket;
const panePid = (s) =>
  execFileSync(
    tmux,
    [
      "-S",
      socket,
      "display-message",
      "-p",
      "-t",
      "=" + s.backendName + ":0.0",
      "#{pane_pid}",
    ],
    { encoding: "utf8" },
  ).trim();
const paneEnv = (s) => {
  const row = starts().find((r) => r.pid === Number(panePid(s)));
  assert.ok(row, "Fixture reported its environment");
  return row.env;
};
const starts = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
async function typeIn(text) {
  const scope = page.locator(".session-view");
  await scope.locator(".xterm-screen").waitFor();
  await scope.locator(".terminal-connection").waitFor({ state: "detached" });
  await poll(
    async () =>
      (await scope.locator(".xterm-screen").textContent()).trim().length > 0,
    "terminal drawn",
  );
  await scope.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
const written = (name) =>
  poll(
    async () =>
      existsSync(path.join(repo, name)) &&
      (await readFile(path.join(repo, name), "utf8")).endsWith("\n"),
    name,
  );
let runs = 0;
async function awctl(args) {
  const name = `awctl-${++runs}`;
  await typeIn(`awctl ${args} > ${name}.json; echo $? > ${name}.code`);
  await written(name + ".code");
  return {
    code: Number(await readFile(path.join(repo, name + ".code"), "utf8")),
    out: JSON.parse(await readFile(path.join(repo, name + ".json"), "utf8")),
  };
}
async function quiet() {
  for (const close of await page
    .getByRole("button", { name: "Dismiss notification" })
    .all())
    await close.click().catch(() => {});
  await page.mouse.move(0, 0);
}
async function launchClaude(profile) {
  await page.getByRole("button", { name: "Launch options" }).click();
  const options = page.getByRole("dialog", { name: "Launch options" });
  await options.getByLabel("Claude profile").selectOption(profile.id);
  await page.keyboard.press("Escape");
  const before = (await snapshot()).sessions.length;
  await page.locator(".launch-bar .launch-claude").click();
  await poll(
    async () => (await snapshot()).sessions.length > before,
    "claude session for " + profile.label,
  );
  return (await snapshot()).sessions.at(-1);
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
  // Safety: the core must resolve `claude` to the fixture, never an installed CLI.
  await poll(
    async () =>
      (await snapshot()).capabilities.find((c) => c.name === "claude")
        ?.detail === path.join(bin, "claude"),
    "fixture claude on PATH",
  );
  checks.push(
    "the core resolves claude to the fixture CLI (no real Claude is run)",
  );

  // Profiles: created in the panel, private folders under the app data folder.
  await page.getByRole("button", { name: "Settings and connections" }).click();
  await page.getByRole("button", { name: "Claude profiles" }).click();
  const panel = page.getByRole("dialog", { name: "Claude profiles" });
  await panel.waitFor();
  for (const label of ["Work", "Personal"]) {
    await panel.getByLabel("New profile").fill(label);
    await panel.getByRole("button", { name: "Add profile" }).click();
    await panel
      .locator(".profile-row strong")
      .filter({ hasText: new RegExp(`^${label}$`) })
      .waitFor();
  }
  let { profiles } = await profilesList();
  const work = profiles.find((p) => p.label === "Work");
  const personal = profiles.find((p) => p.label === "Personal");
  for (const p of [work, personal]) {
    assert.ok(p.location.startsWith(path.join(fixture, "data", "profiles")));
    assert.equal(statSync(p.location).mode & 0o777, 0o700);
  }
  checks.push(
    "two profiles created from the Claude profiles panel; each has its own 0700 folder in the app's data folder",
  );

  // Set up opens the unmodified CLI with that profile's folder.
  await panel
    .locator(".profile-row")
    .filter({ hasText: "Work" })
    .getByRole("button", { name: "Set up" })
    .click();
  await panel.waitFor({ state: "detached" });
  await poll(() => starts().some((s) => s.args.length === 0), "setup terminal");
  const setupStart = starts().find((s) => s.args.length === 0);
  assert.equal(setupStart.env.CLAUDE_CONFIG_DIR, work.location);
  await page
    .locator(".session-view .profile-chip")
    .filter({ hasText: "Sign-in · Work" })
    .waitFor();
  checks.push(
    "Set up opened Claude with no arguments and CLAUDE_CONFIG_DIR set to the Work folder; the session is labelled Sign-in · Work",
  );
  await page.getByRole("button", { name: "Settings and connections" }).click();
  await page.getByRole("button", { name: "Claude profiles" }).click();
  await panel
    .locator(".profile-row")
    .filter({ hasText: "Work" })
    .locator(".state-ready")
    .waitFor();
  await quiet();
  await page.screenshot({ path: path.join(screenshots, "profiles.png") });
  await panel.getByRole("button", { name: "Close" }).click();

  // One Claude session per profile from the launch bar.
  const a = await launchClaude(work);
  const b = await launchClaude(personal);
  assert.equal(a.profileId, work.id);
  assert.equal(b.profileId, personal.id);
  await poll(
    () =>
      starts().some((r) => r.pid === Number(panePid(a))) &&
      starts().some((r) => r.pid === Number(panePid(b))),
    "provider environment reported",
  );
  assert.equal(paneEnv(a).CLAUDE_CONFIG_DIR, work.location);
  assert.equal(paneEnv(b).CLAUDE_CONFIG_DIR, personal.location);
  assert.equal(paneEnv(a).HOME, home);
  const global = execFileSync(tmux, ["-S", socket, "show-environment", "-g"], {
    encoding: "utf8",
  });
  assert.equal(global.includes("CLAUDE_CONFIG_DIR"), false);
  await page
    .locator(".session-view .profile-chip")
    .filter({ hasText: /^Personal$/ })
    .waitFor();
  checks.push(
    "Launch options' profile picker opened one Claude session per profile; each pane has only its own CLAUDE_CONFIG_DIR and the shared HOME; tmux's global environment has none",
  );

  // A turn in the Work session, then Branch from the session bar.
  await page
    .locator(".session-tab")
    .filter({ hasText: "Claude" })
    .nth(1)
    .click();
  await page
    .locator(".session-view .profile-chip")
    .filter({ hasText: /^Work$/ })
    .waitFor();
  await invoke("session.rename", {
    sessionId: a.id,
    generation: 1,
    title: "Work planning",
    titleRevision: 0,
  });
  await typeIn("remember the codename alpha");
  await poll(
    async () =>
      (await snapshot()).sessions.find((s) => s.id === a.id).activity ===
      "done",
    "turn done",
  );
  const parentPid = panePid(a);
  const before = starts().length;
  await page.getByText("More actions", { exact: true }).click();
  await page.getByRole("button", { name: "Branch", exact: true }).click();
  await poll(
    async () =>
      (await snapshot()).sessions.some(
        (s) =>
          s.forkedFrom?.sessionId === a.id && s.conversationState === "known",
      ),
    "branch",
  );
  const child = (await snapshot()).sessions.find(
    (s) => s.forkedFrom?.sessionId === a.id,
  );
  const branchStart = starts()
    .slice(before)
    .find((s) => s.args.includes("--fork-session"));
  assert.deepEqual(branchStart.args.slice(0, 3), [
    "--resume",
    a.conversationId,
    "--fork-session",
  ]);
  assert.equal(branchStart.env.CLAUDE_CONFIG_DIR, work.location);
  assert.equal(child.profileId, work.id);
  assert.notEqual(child.conversationId, a.conversationId);
  assert.ok(
    existsSync(
      path.join(
        work.location,
        "projects",
        repo.replace(/[^A-Za-z0-9]/g, "-"),
        child.conversationId + ".jsonl",
      ),
    ),
  );
  assert.equal(panePid(a), parentPid);
  assert.equal(
    (await snapshot()).sessions.find((s) => s.id === a.id).status,
    "running",
  );
  const chip = page.locator(".session-view .lineage-chip");
  await chip.filter({ hasText: /^Branch$/ }).waitFor();
  assert.match(
    await chip.getAttribute("title"),
    /^Branch of Work planning\. A separate conversation/,
  );
  await quiet();
  await page.screenshot({ path: path.join(screenshots, "branch.png") });
  checks.push(
    "Branch ran --resume <id> --fork-session with the Work profile; the child's new ID came from its SessionStart hook and names its transcript; the parent kept its PID and kept running",
  );

  // A shell receives the context: grant it Read linked context.
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByRole("button", { name: "Open Shell here" }).click();
  await poll(
    async () => (await snapshot()).sessions.some((s) => s.provider === "shell"),
    "shell",
  );
  const shell = (await snapshot()).sessions.find((s) => s.provider === "shell");
  await page.getByText("More actions", { exact: true }).click();
  await page
    .getByRole("button", { name: "Agent control", exact: true })
    .click();
  const control = page.getByRole("dialog", { name: "Agent control" });
  await control.getByLabel(/Read linked context/).check();
  await control.getByRole("button", { name: "Grant control" }).click();
  await control.getByText(/^On until/).waitFor();
  await control.getByRole("button", { name: "Close" }).click();
  let r = await awctl("transcript read");
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.deepEqual(r.out.links, []);
  checks.push(
    "a shell granted Read linked context lists no links: links start empty",
  );

  // Link context from the Work session: preview, redact, cross-profile consent, link.
  await page
    .locator(".session-tab")
    .filter({ hasText: "Work planning" })
    .click();
  await page.getByRole("button", { name: "Connect agents" }).click();
  const links = page.getByRole("dialog", { name: "Connect agents" });
  await links.getByRole("button", { name: "Preview transcript" }).click();
  await links.getByText("Raw transcript and precise redaction").click();
  const area = links.getByLabel("Transcript preview");
  await area.waitFor();
  assert.match(await area.inputValue(), /remember the codename alpha/);
  const shown = await area.inputValue();
  const first = shown.indexOf("alpha");
  const second = shown.indexOf("alpha", first + 1);
  assert.ok(
    first >= 0 && second > first,
    "the turn and its reply both mention the secret",
  );
  for (const at of [second, first]) {
    await area.evaluate((el, at) => {
      el.focus();
      el.setSelectionRange(at, at + 5);
    }, at);
    await links.getByRole("button", { name: "Redact selection" }).click();
  }
  await links.locator(".redaction-list button").nth(1).waitFor();
  await links.getByLabel("Give to").selectOption(shell.id);
  await links.getByLabel(/Allow the recipient to read snapshots/).check();
  await links.getByText(/Its agent may send this context/).waitFor();
  assert.equal(
    await links
      .getByRole("button", { name: "Connect", exact: true })
      .isDisabled(),
    true,
  );
  await links
    .getByRole("checkbox", { name: /This session uses profile/ })
    .check();
  await quiet();
  await page.screenshot({
    path: path.join(screenshots, "transcript-link.png"),
  });
  await links.getByRole("button", { name: "Connect", exact: true }).click();
  await links.locator(".link-row").filter({ hasText: "To Shell" }).waitFor();
  checks.push(
    "Link context previewed the Work transcript, redacted both mentions of the secret, required cross-profile consent for the shell, then linked it",
  );
  await links.getByRole("button", { name: "Close" }).click();

  // The shell's own process reads it through awctl.
  await page.locator(".session-tab").filter({ hasText: "Shell" }).click();
  r = await awctl("transcript read");
  assert.equal(r.out.links.length, 1);
  const linkId = r.out.links[0].link;
  r = await awctl(`transcript read --link ${linkId}`);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.match(r.out.text, /remember the codename \[redacted\]/);
  assert.equal(r.out.text.includes("alpha"), false);
  assert.equal(r.out.export.complete, false);
  assert.equal(
    JSON.stringify(r.out).includes(work.location),
    false,
    "no profile paths reach the agent",
  );
  checks.push(
    "awctl transcript read in the shell returned the redacted export (partial: the source still runs), with no profile paths",
  );

  // Revoke from the receiving session's panel; the next read is refused.
  await page.getByRole("button", { name: "Connect agents" }).click();
  await links
    .locator(".link-row")
    .filter({ hasText: "From Work planning" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await links.locator(".link-row.revoked").waitFor();
  await links.getByRole("button", { name: "Close" }).click();
  r = await awctl(`transcript read --link ${linkId}`);
  assert.equal(r.code, 1);
  assert.equal(r.out.error, "revoked");
  checks.push(
    "Revoke in the receiving session's Link context panel; the next awctl read is refused (revoked)",
  );

  // Nothing changed globally; both profile sessions and the parent still run.
  assert.equal(globalHash(), globalBefore);
  assert.equal(
    existsSync(path.join(home, ".claude", "projects")),
    false,
    "no profile session wrote to the default folder",
  );
  const final = (await snapshot()).sessions;
  for (const s of [a, b, child])
    assert.equal(final.find((x) => x.id === s.id).status, "running");
  assert.equal(panePid(a), parentPid);
  checks.push(
    "the global ~/.claude.json is unchanged and nothing was written to the default ~/.claude; all profile sessions still run",
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
