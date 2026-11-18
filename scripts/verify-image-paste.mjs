import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";

// Screenshot paste and manual session naming in the real desktop app.
const fixture = await mkdtemp(path.join(tmpdir(), "workspace-image-paste-"));
const repo = path.join(fixture, "repo folder");
await mkdir(repo);
const checks = [];
/** A real RGBA PNG; the app must decode and re-encode it. */
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++)
      row.set([(x * 255) / width, (y * 255) / height, 160, 255], 1 + x * 4);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const app = await electron.launch({
  ...(process.env.WORKSPACE_APP_EXECUTABLE
    ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
    : { args: ["."] }),
  env: {
    ...process.env,
    SHELL: "/bin/sh",
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
const screen = () =>
  page.evaluate(() => document.querySelector(".xterm-screen")?.textContent || "");
const setClipboardImage = (bytes) =>
  app.evaluate(async ({ clipboard, ClipboardItem }, b64) => {
    const data = Buffer.from(b64, "base64");
    await clipboard.write([
      new ClipboardItem({ "image/png": new Blob([data], { type: "image/png" }) }),
    ]);
  }, bytes.toString("base64"));
try {
  await page.waitForFunction(() => !!window.workspace);
  await command("project.add", { path: repo });
  await page.getByRole("button", { name: "Open Shell here" }).waitFor();
  await page.getByRole("button", { name: "Open Shell here", exact: true }).click();
  await page.locator(".xterm-helper-textarea").waitFor();
  const pasteButton = page.getByRole("button", { name: "Paste image" });
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".session-actions button")].some(
      (b) => b.textContent?.includes("Paste image") && !b.disabled,
    ),
  );
  const [session] = (await command("snapshot")).sessions;

  // An empty clipboard says so instead of opening anything.
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await pasteButton.click();
  await page.getByText("The clipboard has no image to paste.").waitFor();
  await page.getByRole("button", { name: "Dismiss" }).click();
  checks.push("no image on the clipboard is reported, nothing saved");

  const original = png(640, 360);
  await setClipboardImage(original);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf '<%s>\\n' ");
  await pasteButton.click();
  const dialog = page.getByRole("dialog", { name: "Paste image as a file path" });
  await dialog.waitFor();
  await dialog.getByText("640 × 360").waitFor();
  await dialog
    .getByText("Saved privately on this computer; only its path is typed into the terminal", { exact: false })
    .waitFor();
  assert.ok(
    (await dialog.locator("img").getAttribute("src")).startsWith("data:image/png;base64,"),
  );
  await page.screenshot({ path: path.join(fixture, "image-preview.png") });
  await dialog.getByRole("button", { name: "Paste path" }).click();
  await dialog.waitFor({ state: "detached" });
  checks.push("Paste image previews size and privacy notice before saving");

  const folder = path.join(fixture, "data", "attachments", session.id);
  const [name] = await readdir(folder);
  assert.match(name, /^screenshot-\d{8}T\d{6}-[0-9a-f]{12}\.png$/);
  const saved = path.join(await realpath(folder), name);
  await page.waitForFunction(
    (name) => document.querySelector(".xterm-screen")?.textContent?.includes(name),
    name,
  );
  // Typed, not submitted: no output line for the printf yet.
  await page.waitForTimeout(400);
  assert.equal((await screen()).includes("<" + saved + ">"), false);
  await page.keyboard.press("Enter");
  // The shell reads the escaped path back as one exact word.
  await page.waitForFunction(
    (saved) => document.querySelector(".xterm-screen")?.textContent?.includes("<" + saved + ">"),
    saved,
  );
  const bytes = await readFile(saved);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(bytes.readUInt32BE(16), 640);
  assert.equal(bytes.readUInt32BE(20), 360);
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  checks.push("confirm saves a private 0600 PNG and types its escaped path without Enter");

  // An image-only paste event opens the same preview; text paste is untouched.
  await setClipboardImage(png(32, 16));
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([1])], "image.png", { type: "image/png" }));
    document
      .querySelector(".xterm-helper-textarea")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await dialog.waitFor();
  await dialog.getByText("32 × 16").waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).first().click();
  await dialog.waitFor({ state: "detached" });
  assert.equal((await readdir(folder)).length, 1);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "echo TEXT_PASTE_OK");
    document
      .querySelector(".xterm-helper-textarea")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() =>
    document.querySelector(".xterm-screen")?.textContent?.includes("echo TEXT_PASTE_OK"),
  );
  assert.equal(await dialog.count(), 0);
  checks.push("image-only paste opens preview, cancel saves nothing, text paste unchanged");

  // Manual naming: pencil and double-click, Enter saves, Escape cancels.
  await page.getByRole("button", { name: "Rename session" }).click();
  const input = page.getByLabel("Session name");
  await input.fill("Screenshot\u0007 run");
  await input.press("Enter");
  await page.locator(".session-identity .session-title").filter({ hasText: "Screenshot run" }).waitFor();
  await page.locator(".session-row strong").filter({ hasText: "Screenshot run" }).waitFor();
  await page.locator(".session-tab").filter({ hasText: "Screenshot run" }).waitFor();
  await page.screenshot({ path: path.join(fixture, "renamed.png") });
  await page.locator(".session-identity .session-title").dblclick();
  await input.fill("Discarded");
  await input.press("Escape");
  await input.waitFor({ state: "detached" });
  let state = await command("snapshot");
  assert.equal(state.sessions[0].title, "Screenshot run");
  assert.equal(state.sessions[0].titleRevision, 1);
  await page.reload();
  await page.waitForFunction(() => !!window.workspace);
  await page.locator(".session-row strong").filter({ hasText: "Screenshot run" }).click();
  await page.locator(".session-identity .session-title").filter({ hasText: "Screenshot run" }).waitFor();
  state = await command("snapshot");
  assert.equal(state.sessions[0].status, "running");
  assert.equal(state.sessions[0].generation, session.generation);
  checks.push("rename via pencil persists across reload; Escape cancels; session keeps running");

  // The owner channel rejects malformed saves and expired tokens.
  const rejected = await page.evaluate(async (target) => {
    const out = [];
    for (const value of [
      { ...target, token: "forged" },
      { ...target, token: "x", extra: 1 },
      { ...target, token: "x", generation: 0 },
    ])
      out.push(await window.workspace.clipboardImage.save(value).then(() => "saved", (e) => e.message));
    return out;
  }, { sessionId: session.id, generation: session.generation });
  assert.match(rejected[0], /expired/);
  assert.match(rejected[1], /Invalid image save request/);
  assert.match(rejected[2], /Invalid image save request/);
  assert.equal((await readdir(folder)).length, 1);
  checks.push("forged tokens and unexpected fields are rejected by main");

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fixture, checks }));
} catch (error) {
  await page.screenshot({ path: path.join(fixture, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ passed: false, fixture, checks, error: String(error?.stack || error) }));
  process.exitCode = 1;
} finally {
  try {
    for (const session of (await command("snapshot")).sessions) {
      try {
        await command("session.attach", { sessionId: session.id, generation: session.generation, viewerId: "cleanup" });
        await command("session.terminate", { sessionId: session.id, generation: session.generation, viewerId: "cleanup" });
      } catch {}
    }
  } catch {}
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await cleanupFixture(fixture);
}
