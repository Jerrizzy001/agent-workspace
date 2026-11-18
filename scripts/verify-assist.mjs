import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron, chromium } from "playwright";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  realpath,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// Opt-in AI suggestions in the real desktop app, with a fixture `claude` on
// PATH. No real provider is called. Screenshots go to the fixture folder and,
// with WORKSPACE_SCREENSHOT_DIR, to that folder too.
const fixture = await realpath(
  await mkdtemp(path.join(tmpdir(), "workspace-assist-")),
);
const bin = path.join(fixture, "bin");
const record = path.join(fixture, "fixture");
const repo = path.join(fixture, "checkout-app");
await mkdir(bin);
await mkdir(record);
await mkdir(repo);
const checks = [];
const shots = process.env.WORKSPACE_SCREENSHOT_DIR;
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(fixture, name) });
  if (shots) await copyFile(path.join(fixture, name), path.join(shots, name));
};

const help = `Usage: claude [options] [command] [prompt]
  --disable-slash-commands  Disable all skills and commands
  --disallowedTools <tools...>  Tool names to deny
  --mcp-config <configs...>  Load MCP servers from JSON files
  --model <model>  Model for the current session
  --no-chrome  Disable Claude in Chrome integration
  --no-session-persistence  Disable session persistence
  --output-format <format>  (choices: "text", "json", "stream-json")
  --permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
  --permission-prompts <target>  (choices: "host", "none", default: "host")
  -p, --print  Print response and exit
  --restricted  Restricted mode
  --safe-mode  Start with all customizations disabled
  --session-id <uuid>  Use a specific session ID
  --settings <file-or-json>  Settings
  --strict-mcp-config  Only use MCP servers from --mcp-config
  --tools <tools...>  the built-in set. Use "" to disable all tools
`;
await writeFile(
  path.join(bin, "claude"),
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const dir = ${JSON.stringify(record)};
if (args[0] === "--help") { process.stdout.write(${JSON.stringify(help)}); process.exit(0); }
if (args[0] === "--version") { process.stdout.write("9.9.9 (Fixture)\\n"); process.exit(0); }
if (!args.includes("--print")) {
  fs.appendFileSync(dir + "/launches.jsonl", JSON.stringify({ args }) + "\\n");
  setInterval(() => {}, 1000);
  return;
}
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ args, cwd: process.cwd(), stdin, ssh: !!process.env.SSH_AUTH_SOCK }) + "\\n");
const result = stdin.includes("terminal session")
  ? "\\u001b[1mCheckout redirect fix\\u001b[0m"
  : "Keep the cart after sign-in\\n\\nRedirect back to the checkout page instead of home.";
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }));
`,
  { mode: 0o700 },
);
const calls = async () => {
  try {
    return (await readFile(path.join(record, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const git = (...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=f@example.com", ...args],
    { cwd: repo, encoding: "utf8" },
  );
git("init", "-q", "-b", "main");
await writeFile(
  path.join(repo, "cart.js"),
  "export function afterSignIn() {\n  return '/';\n}\n",
);
git("add", ".");
git("commit", "-q", "-m", "Initial cart");
const head = git("rev-parse", "HEAD").trim();

const app = await electron.launch({
  ...(process.env.WORKSPACE_APP_EXECUTABLE
    ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
    : { args: ["."] }),
  env: {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    SHELL: "/bin/sh",
    SSH_AUTH_SOCK: path.join(fixture, "agent.sock"),
    WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
  },
});
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const command = (name, payload) =>
  page.evaluate(({ name, payload }) => window.workspace.invoke(name, payload), {
    name,
    payload,
  });
let browser;
try {
  await page.setViewportSize({ width: 1480, height: 900 }).catch(() => {});
  await page.waitForFunction(() => !!window.workspace?.assist);
  const project = await command("project.add", { path: repo });
  const { session } = await command("terminal.open", {
    projectId: project.id,
    provider: "claude",
    prompt: "Fix the checkout redirect after sign-in",
    idempotencyKey: "assist-claude",
  });
  await page.getByRole("button", { name: "Open Shell here" }).waitFor();

  // The general command channel cannot reach suggestions or their consent.
  const blocked = await page.evaluate(async () => {
    const out = [];
    for (const [name, payload] of [
      ["assist.status", {}],
      ["assist.suggest", { kind: "commit" }],
      ["settings.write", { key: "assistProvider", value: "claude" }],
    ])
      out.push(
        await window.workspace.invoke(name, payload).then(
          () => "allowed",
          (e) => e.message,
        ),
      );
    out.push(
      await window.workspace.assist
        .configure({ provider: "claude", model: "", acknowledged: false })
        .then(
          () => "allowed",
          (e) => e.message,
        ),
    );
    return out;
  });
  for (const message of blocked.slice(0, 3))
    assert.match(message, /AI suggestions controls/);
  assert.match(blocked[3], /Confirm the notice/);
  assert.equal(
    (await command("settings.read", { key: "assistProvider" })).value,
    "",
  );
  checks.push(
    "off by default; the general channel cannot run suggestions or turn them on; consent is required",
  );

  // Opt in through the settings dialog.
  await page.getByRole("button", { name: "Settings and connections" }).click();
  await page.getByRole("button", { name: "AI suggestions settings" }).click();
  const settings = page.getByRole("dialog", { name: "AI suggestions" });
  await settings.getByText("Available for suggestions").waitFor();
  assert.equal(
    await settings.getByRole("radio", { name: /^Off/ }).isChecked(),
    true,
  );
  await settings.getByRole("radio", { name: /^Claude/ }).check();
  await settings
    .getByText("through your own installed", { exact: false })
    .waitFor();
  assert.equal(
    await settings.getByRole("button", { name: "Save" }).isDisabled(),
    true,
  );
  await settings.getByRole("checkbox").check();
  await shot(page, "assist-settings.png");
  await settings.getByRole("button", { name: "Save" }).click();
  await settings.waitFor({ state: "detached" });
  assert.equal(
    (await command("settings.read", { key: "assistProvider" })).value,
    "claude",
  );
  assert.equal((await calls()).length, 0);
  checks.push(
    "settings dialog shows the provider check and usage notice; Save needs the acknowledgement",
  );

  // Stage a change; preview shows exactly what would be sent; nothing runs yet.
  await writeFile(
    path.join(repo, "cart.js"),
    "export function afterSignIn(cart) {\n  return cart.items.length ? '/checkout' : '/';\n}\n",
  );
  await writeFile(path.join(repo, "notes.txt"), "UNSTAGED-NOTES\n");
  await command("git.stage", { projectId: project.id, paths: ["cart.js"] });
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.getByRole("button", { name: "Refresh files and git" }).click();
  await page.getByRole("button", { name: "Suggest message" }).click();
  const preview = page.getByRole("dialog", { name: "Suggest commit message" });
  await preview.getByText("cart.items.length", { exact: false }).waitFor();
  const sent = await preview.getByLabel("Exact text to be sent").textContent();
  assert.doesNotMatch(sent, /UNSTAGED-NOTES/);
  assert.equal((await calls()).length, 0, "preview does not call the provider");
  await shot(page, "assist-commit.png");
  await preview.getByRole("button", { name: "Generate draft" }).click();
  await preview.waitFor({ state: "detached" });
  const box = page.getByLabel("Commit message");
  assert.equal(
    await box.inputValue(),
    "Keep the cart after sign-in\n\nRedirect back to the checkout page instead of home.",
  );
  const [call] = await calls();
  assert.equal(call.stdin, sent);
  assert.ok(
    call.args.includes("--safe-mode") && call.args.includes("--restricted"),
  );
  assert.match(call.cwd, /\/aw-assist-[^/]+\/work$/);
  assert.equal(call.ssh, false);
  await page
    .getByText("AI draft from the staged changes. Edit it before committing.")
    .waitFor();
  await box.press("End");
  await box.type(" (edited)");
  assert.match(await box.inputValue(), /home\. \(edited\)$/);
  assert.equal(git("rev-parse", "HEAD").trim(), head, "nothing committed");
  assert.equal(
    git("diff", "--cached", "--name-only").trim(),
    "cart.js",
    "staging untouched",
  );
  checks.push(
    "one click generates an editable draft into the commit box from exactly the previewed text; no commit",
  );

  // Staging another file marks the draft stale.
  await command("git.stage", { projectId: project.id, paths: ["notes.txt"] });
  await page.getByRole("button", { name: "Refresh files and git" }).click();
  await page
    .getByText("The staged changes are different from when this draft was made", {
      exact: false,
    })
    .waitFor();
  await shot(page, "assist-commit-stale.png");
  assert.equal((await calls()).length, 1);
  checks.push("staging another file marks the draft stale");

  // Suggest a session name from chosen context and accept it.
  await page
    .locator(".session-row")
    .filter({ hasText: "Claude" })
    .first()
    .click();
  await page.getByRole("button", { name: "Rename session" }).click();
  await page.getByRole("button", { name: "Suggest name" }).click();
  const naming = page.getByRole("dialog", { name: "Suggest session name" });
  await naming
    .getByText("Fix the checkout redirect", { exact: false })
    .first()
    .waitFor();
  await naming.getByRole("checkbox", { name: "Folder name" }).uncheck();
  await page.waitForFunction(
    () =>
      !document
        .querySelector(".assist-input")
        ?.textContent?.includes("Folder:"),
  );
  assert.equal((await calls()).length, 1);
  await naming.getByRole("button", { name: "Generate", exact: true }).click();
  const suggested = naming.getByLabel("Suggested session name");
  await suggested.waitFor();
  assert.equal(await suggested.inputValue(), "Checkout redirect fix");
  assert.doesNotMatch((await calls())[1].stdin, /Folder:|checkout-app/);
  await shot(page, "assist-name.png");
  assert.equal(
    (await command("snapshot")).sessions.find((s) => s.id === session.id).title,
    undefined,
  );
  await naming.getByRole("button", { name: "Accept name" }).click();
  await naming.waitFor({ state: "detached" });
  await page
    .locator(".session-identity .session-title")
    .filter({ hasText: "Checkout redirect fix" })
    .waitFor();
  const renamed = (await command("snapshot")).sessions.find(
    (s) => s.id === session.id,
  );
  assert.equal(renamed.title, "Checkout redirect fix");
  assert.equal(renamed.titleRevision, 1);
  assert.equal(renamed.status, "running");
  assert.equal((await calls()).length, 2);
  checks.push(
    "name suggestion uses only ticked context; Accept saves through the revision-checked rename",
  );

  // A paired remote browser has no assist API, controls or route.
  const status = await page.evaluate((projectId) =>
    window.workspace.remote.enable({ host: "127.0.0.1", port: 0, tls: false, projectIds: [projectId] }),
    project.id,
  );
  const origin = status.url;
  const code = await page.evaluate(() =>
    window.workspace.remote.pairingSecret(),
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WORKSPACE_BROWSER
      ? { executablePath: process.env.WORKSPACE_BROWSER }
      : { channel: process.env.WORKSPACE_BROWSER_CHANNEL || "chrome" }),
  });
  const remote = await browser.newPage({
    viewport: { width: 1280, height: 860 },
  });
  await remote.goto(origin);
  await remote.getByLabel("Pairing code").fill(code);
  await remote.getByRole("button", { name: "Connect", exact: true }).click();
  await remote.waitForFunction(() => !!window.workspace);
  await remote.getByText("checkout-app").first().waitFor();
  assert.equal(
    await remote.evaluate(() => "assist" in window.workspace),
    false,
  );
  assert.equal(
    await remote
      .getByRole("button", { name: "AI suggestions settings" })
      .count(),
    0,
  );
  assert.match(
    await remote.evaluate(() =>
      window.workspace.invoke("assist.status").then(
        () => "allowed",
        (e) => e.message,
      ),
    ),
    /not available remotely/,
  );
  assert.match(
    await remote.evaluate(() =>
      window.workspace
        .invoke("settings.write", { key: "assistProvider", value: "claude" })
        .then(
          () => "allowed",
          (e) => e.message,
        ),
    ),
    /not available remotely/,
  );
  await remote.getByText("checkout-app").first().click();
  await remote
    .getByRole("button", { name: /^Changes/ })
    .first()
    .click();
  await remote.getByLabel("Commit message").waitFor();
  assert.equal(
    await remote.getByRole("button", { name: "Suggest message" }).count(),
    0,
  );
  await remote
    .locator(".session-row")
    .filter({ hasText: "Checkout redirect fix" })
    .first()
    .click();
  await remote.getByRole("button", { name: "Rename session" }).first().click();
  await remote.getByLabel("Session name").waitFor();
  assert.equal(
    await remote.getByRole("button", { name: "Suggest name" }).count(),
    0,
  );
  assert.equal((await calls()).length, 2);
  checks.push(
    "a paired remote browser has no assist API, buttons or gateway route",
  );

  assert.equal(git("rev-parse", "HEAD").trim(), head);
  assert.equal(existsSync(path.join(repo, "pwned.txt")), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fixture, checks }));
} catch (error) {
  await page
    .screenshot({ path: path.join(fixture, "failure.png") })
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
  await browser?.close().catch(() => {});
  await page.evaluate(() => window.workspace.remote.disable()).catch(() => {});
  try {
    for (const s of (await command("snapshot")).sessions) {
      try {
        await command("session.attach", {
          sessionId: s.id,
          generation: s.generation,
          viewerId: "cleanup",
        });
        await command("session.terminate", {
          sessionId: s.id,
          generation: s.generation,
          viewerId: "cleanup",
        });
      } catch {}
    }
  } catch {}
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await cleanupFixture(fixture);
}
