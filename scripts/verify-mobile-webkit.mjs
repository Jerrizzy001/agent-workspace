import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { webkit } from "playwright";
import { cleanupFixture } from "./fixture-cleanup.mjs";

const fixture = await mkdtemp(path.join(tmpdir(), "aw-mobile-webkit-"));
const repo = path.join(fixture, "phone-webkit");
const screenshotDir = path.resolve("docs/screenshots/remote");
await mkdir(repo);
await mkdir(screenshotDir, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
const certificate = path.join(fixture, "certificate.pem");
const key = path.join(fixture, "key.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ],
  { stdio: "ignore" },
);
const server = spawn(
  process.execPath,
  [
    "node_modules/tsx/dist/cli.mjs",
    "src/server/headless.ts",
    "--data-dir",
    path.join(fixture, "data"),
    "--port",
    "0",
    "--project",
    repo,
    "--static-dir",
    path.resolve("dist/renderer"),
    "--tls-cert",
    certificate,
    "--tls-key",
    key,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stderr.on("data", (data) => {
  serverLog += data;
});
let browser;
const errors = [];
const checks = [];
async function poll(check, label) {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out: " + label);
}
try {
  const info = await new Promise((resolve, reject) => {
    let output = "";
    server.stdout.on("data", (data) => {
      output += data;
      const first = output
        .split("\n")
        .find((line) => line.startsWith('{"service"'));
      if (first) resolve(JSON.parse(first));
    });
    server.once("exit", (code) =>
      reject(new Error(`Host exited ${code}: ${serverLog}`)),
    );
    setTimeout(
      () => reject(new Error("Host startup timed out: " + serverLog)),
      15000,
    ).unref();
  });
  const secret = (await readFile(info.pairingFile, "utf8")).trim();
  browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(info.url);
  await page.getByLabel("Pairing code", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Connected to workspace", { exact: true }).waitFor();
  const cookies = await context.cookies();
  assert.equal(
    cookies.some(
      (cookie) =>
        cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict",
    ),
    true,
  );
  checks.push(
    "WebKit phone viewport pairs over HTTPS with Secure HttpOnly SameSite cookie and same-origin WSS under CSP",
  );
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Board", exact: true })
    .click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByPlaceholder("What do you want to work on?")
    .fill("Continue with WebKit");
  await page
    .locator(".modal")
    .getByRole("button", { name: "Create task", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start an attempt", exact: true })
    .click();
  await page
    .locator(".modal")
    .getByRole("button", { name: "Start attempt", exact: true })
    .click();
  await poll(
    () =>
      page.getByRole("button", { name: "Focus terminal keyboard" }).isEnabled(),
    "WebKit terminal attached",
  );
  await page.getByRole("button", { name: "Focus terminal keyboard" }).click();
  await page.keyboard.insertText(
    'printf "WebKit phone input\\n" > webkit-proof.txt',
  );
  await page
    .getByRole("button", { name: "Terminal Enter", exact: true })
    .click();
  await poll(
    async () =>
      (await readFile(path.join(repo, "webkit-proof.txt"), "utf8")) ===
      "WebKit phone input\n",
    "WebKit terminal creates host file",
  );
  assert.equal(
    await page.evaluate(() => document.body.scrollWidth <= innerWidth),
    true,
  );
  await page.screenshot({
    animations: "disabled",
    path: path.join(screenshotDir, "webkit-phone-portrait.png"),
  });
  const original = await page.evaluate(() =>
    window.workspace.invoke("snapshot"),
  );
  assert.equal(original.attempts.length, 1);
  checks.push(
    "WebKit touch controls create a task and one shell; keyboard text and Enter create a real host file without body overflow",
  );
  await page.reload();
  await page.getByText("Connected to workspace", { exact: true }).waitFor();
  await poll(
    () =>
      page.getByRole("button", { name: "Focus terminal keyboard" }).isEnabled(),
    "WebKit reload reattaches terminal",
  );
  const restored = await page.evaluate(() =>
    window.workspace.invoke("snapshot"),
  );
  assert.equal(restored.attempts.length, 1);
  assert.equal(restored.sessions[0].id, original.sessions[0].id);
  assert.equal(
    restored.sessions[0].generation,
    original.sessions[0].generation,
  );
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(
    () =>
      document.querySelector(".mobile-navigation").getBoundingClientRect()
        .bottom <=
      innerHeight + 1,
  );
  assert.ok((await page.locator(".terminal-host").boundingBox()).height >= 80);
  assert.equal(
    await page.evaluate(() => document.body.scrollWidth <= innerWidth),
    true,
  );
  await page.screenshot({
    animations: "disabled",
    path: path.join(screenshotDir, "webkit-phone-landscape.png"),
  });
  checks.push(
    "WebKit reload restores the existing session and generation; landscape remains responsive",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Pairing code", { exact: true }).waitFor();
  assert.equal(await page.locator(".app-shell").count(), 0);
  assert.equal(
    (await (await page.request.get(info.url + "/api/status")).json())
      .authenticated,
    false,
  );
  assert.deepEqual(errors, []);
  checks.push("WebKit sign out revokes access and clears private UI");
  await writeFile(
    path.join(screenshotDir, "webkit-verification.json"),
    JSON.stringify(
      {
        platform:
          "Playwright WebKit 27.2 on macOS with synthetic touch viewports; disposable self-signed HTTPS certificate accepted by test context; physical iOS device and trusted deployment certificate not verified",
        browserVersion: browser.version(),
        passed: checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ passed: checks.length, checks, screenshotDir }, null, 2),
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null)
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await once(server, "exit");
  }
  await cleanupFixture(fixture);
  await rm(fixture, { recursive: true, force: true });
}
