import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

// Local dictation in the real desktop app, with Chromium's fake microphone
// playing a synthesized English WAV. By default the real tiny.en model is
// installed through the settings dialog (from the pinned GitHub release, or
// from WORKSPACE_TEST_DICTATION_ARCHIVE, a local copy of that asset, which is
// still checked against the pinned SHA-256). WORKSPACE_VERIFY_DICTATION_FIXTURE=1
// uses the test-only fixture transcriber instead.
const fixture = await mkdtemp(path.join(tmpdir(), "workspace-dictation-"));
const repo = path.join(fixture, "repo");
await mkdir(repo);
const checks = [];
const shots = process.env.WORKSPACE_SCREENSHOT_DIR || fixture;

let espeak = true;
try {
  execFileSync("espeak-ng", ["--version"], { stdio: "ignore" });
} catch {
  espeak = false;
}
const fixtureEngine = process.env.WORKSPACE_VERIFY_DICTATION_FIXTURE === "1" || !espeak;
const PHRASES = ["Hello world.", "Please open the read me file and list every test in the project."];

/** 16-bit PCM samples of one WAV file (any rate), as floats. */
function readWav(bytes) {
  let offset = 12;
  let rate = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") rate = bytes.readUInt32LE(offset + 12);
    if (id === "data") {
      const count = Math.floor(Math.min(size, bytes.length - offset - 8) / 2);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = bytes.readInt16LE(offset + 8 + i * 2) / 32768;
      return { rate, samples: out };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("No WAV data");
}
function resample(samples, from, to) {
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const x = (i * from) / to;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (samples[j] || 0) * (1 - f) + (samples[j + 1] || 0) * f;
  }
  return out;
}
function writeWav(samples, rate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return out;
}
/** 1 s lead-in, phrase one, a 1.5 s pause, phrase two, 4 s of silence. */
async function microphoneFile() {
  const RATE = 48000;
  const parts = [new Float32Array(RATE)];
  for (const [index, text] of PHRASES.entries()) {
    let samples;
    if (espeak) {
      const file = path.join(fixture, `phrase-${index}.wav`);
      execFileSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", file, text]);
      const wav = readWav(await readFile(file));
      samples = resample(wav.samples, wav.rate, RATE);
    } else {
      // Speech-like bursts for the fixture transcriber.
      samples = Float32Array.from({ length: RATE * (1 + index * 2) }, (_, i) =>
        0.3 * Math.sin((2 * Math.PI * 180 * i) / RATE) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / RATE)),
      );
    }
    parts.push(samples, new Float32Array(index ? RATE * 4 : RATE * 1.5));
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    all.set(p, offset);
    offset += p.length;
  }
  const file = path.join(fixture, "microphone.wav");
  await writeFile(file, writeWav(all, RATE));
  return file;
}
const wav = await microphoneFile();
const env = {
  ...process.env,
  SHELL: "/bin/sh",
  WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
  WORKSPACE_TEST_FAKE_MIC: wav,
  ...(fixtureEngine ? { WORKSPACE_TEST_DICTATION_TEXT: PHRASES.join("|") } : {}),
};
const launch = () =>
  electron.launch({
    ...(process.env.WORKSPACE_APP_EXECUTABLE
      ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
      : { args: ["."] }),
    env,
  });
let app = await launch();
let page = await app.firstWindow();
page.setDefaultTimeout(20000);
const errors = [];
const watch = (p) => p.on("pageerror", (e) => errors.push(e.message));
watch(page);
const command = (name, payload) =>
  page.evaluate(({ name, payload }) => window.workspace.invoke(name, payload), { name, payload });
const screen = () => page.evaluate(() => document.querySelector(".xterm-rows")?.textContent || "");
const microphone = () => page.evaluate(() => document.body.dataset.dictationMicrophone || "");
const status = () => page.evaluate(() => window.workspace.dictation.status());
const shortcut = process.platform === "darwin" ? "Meta+Shift+Space" : "Control+Shift+Space";
const count = (text, word) => text.toLowerCase().split(word).length - 1;
const result = { engine: fixtureEngine ? "fixture" : "sherpa-onnx tiny.en", transcript: "" };
const openShell = async () => {
  await page.getByRole("button", { name: "Shell", exact: true }).click();
  await page.locator(".xterm-helper-textarea").waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".session-actions button")].some(
      (b) => b.textContent?.includes("Dictate") && !b.disabled,
    ),
  );
};
try {
  await page.waitForFunction(() => !!window.workspace?.dictation);
  let initial = await status();
  assert.deepEqual(initial.models.map((m) => m.id), ["base.en", "tiny.en"]);
  assert.equal(initial.selected, "base.en");
  assert.equal(initial.recording, false);
  if (!fixtureEngine) assert.equal(initial.models.some((m) => m.installed), false);
  assert.equal(await microphone(), "");
  checks.push("dictation API present for the desktop owner; no model installed or downloaded by default");

  // A foreign window can load the preload but cannot use the dictation channel
  // or open a microphone; the app window cannot open a camera.
  // A file: page is a secure context, so getUserMedia reaches the permission handler.
  const foreignPage = path.join(fixture, "foreign.html");
  await writeFile(foreignPage, "<!doctype html><title>foreign</title>");
  const foreign = await app.evaluate(async ({ app, BrowserWindow }, file) => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload: `${app.getAppPath()}/dist/desktop/preload.cjs`, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await w.loadFile(file);
      return await w.webContents.executeJavaScript(`Promise.all([
        () => window.workspace.dictation.status(),
        () => window.workspace.dictation.start(),
        () => window.workspace.dictation.downloadModel("tiny.en"),
        () => window.workspace.dictation.phrase({ recordingId: "abcdefgh12345678", sequence: 1, pcm: new Int16Array(10) }),
        () => navigator.mediaDevices.getUserMedia({ audio: true }),
      ].map(f => Promise.resolve().then(f).then(() => 'unexpected success', e => e.name + ': ' + e.message)))`);
    } finally { w.destroy(); }
  }, foreignPage);
  for (const message of foreign.slice(0, 4)) assert.match(message, /Invalid sender/);
  assert.match(foreign[4], /NotAllowedError/);
  const camera = await page.evaluate(() =>
    navigator.mediaDevices.getUserMedia({ video: true }).then(
      (s) => { s.getTracks().forEach((t) => t.stop()); return "unexpected camera"; },
      (e) => e.name,
    ),
  );
  assert.equal(camera, "NotAllowedError");
  assert.equal((await status()).models.some((m) => m.installed) && fixtureEngine, false);
  checks.push("foreign window: every dictation action and its microphone are refused; the app window cannot open a camera");

  // Malformed owner requests are rejected by main and the core.
  const malformed = await page.evaluate(async () => {
    const d = window.workspace.dictation;
    const out = [];
    for (const p of [
      d.phrase({ recordingId: "abcdefgh12345678", sequence: 1, pcm: new Int16Array(16000 * 31) }),
      d.phrase({ recordingId: "abcdefgh12345678", sequence: 1, pcm: new Float32Array(16) }),
      d.phrase({ recordingId: "abcdefgh12345678", sequence: 1, pcm: new Int16Array(16) }),
      d.downloadModel("../../etc"),
      window.workspace.invoke("settings.write", { key: "dictationModel", value: "large-v3" }),
    ])
      out.push(await p.then(() => "unexpected success", (e) => e.message));
    return out;
  });
  assert.match(malformed[0], /longer than 30 seconds/);
  assert.match(malformed[1], /16-bit PCM/);
  assert.match(malformed[2], /has ended/);
  assert.match(malformed[3], /Unknown dictation model/);
  assert.match(malformed[4], /Unknown dictation model/);
  checks.push("oversized, non-PCM, unowned phrases and unknown models are rejected");

  await command("project.add", { path: repo });
  await page.getByRole("button", { name: "Open Shell here" }).waitFor();
  await openShell();
  const [first] = (await command("snapshot")).sessions;

  if (!fixtureEngine) {
    // No model: the microphone button explains and offers the download.
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Voice dictation" });
    await dialog.waitFor();
    await dialog.getByText("Dictation needs the English speech model").waitFor();
    assert.equal(await microphone(), "", "no microphone opened without a model");
    await dialog.getByText("English · tiny").click();
    const download = dialog.getByRole("button", { name: /Download English speech model \(~118 MB\)/ });
    await download.waitFor();
    await dialog.getByText("github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2").waitFor();
    await dialog.getByText("License: MIT (Whisper weights)", { exact: false }).waitFor();
    await page.screenshot({ path: path.join(shots, "dictation-settings.png") });
    const started = Date.now();
    await download.click();
    await dialog.getByRole("status").waitFor();
    await dialog.getByText(/^Ready\./).waitFor({ timeout: 600_000 });
    result.installSeconds = Math.round((Date.now() - started) / 1000);
    const files = await readdir(path.join(fixture, "data", "models", "tiny.en"));
    assert.deepEqual(files.sort(), ["decoder.int8.onnx", "encoder.int8.onnx", "tokens.txt"]);
    assert.deepEqual((await readdir(path.join(fixture, "data", "models"))).sort(), ["tiny.en"], "no partial download left");
    assert.equal((await command("settings.read", { key: "dictationModel" })).value, "tiny.en");
    await page.screenshot({ path: path.join(shots, "dictation-model-ready.png") });
    await dialog.getByRole("button", { name: "Close" }).first().click();
    checks.push(`consented download of tiny.en verified and installed (${result.installSeconds}s, ${process.env.WORKSPACE_TEST_DICTATION_ARCHIVE ? "local copy of the release asset" : "network"})`);
  }

  // Type a prefix, then dictate with the keyboard shortcut from inside the terminal.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo ");
  await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("echo"));
  await page.keyboard.press(shortcut);
  const indicator = page.locator(".dictation-indicator");
  await indicator.locator(".dictation-time").waitFor({ timeout: 60_000 });
  result.capture = await microphone();
  assert.ok(["worklet", "script-processor"].includes(result.capture));
  await page.getByRole("button", { name: "Stop dictation" }).first().waitFor();
  await page.waitForFunction(() => /0:0[1-9]/.test(document.querySelector(".dictation-time")?.textContent || ""));
  await page.screenshot({ path: path.join(shots, "dictation-listening.png") });
  // Both phrases are typed as the speaker pauses.
  await page.waitForFunction(
    () => /file/i.test(document.querySelector(".xterm-rows")?.textContent || "") &&
      /project/i.test(document.querySelector(".xterm-rows")?.textContent || ""),
    null,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(800);
  let text = await screen();
  const line = text.slice(text.toLowerCase().indexOf("echo"));
  result.transcript = line.replace(/^echo\s*/i, "").trim();
  assert.match(text, /world/i);
  assert.equal(count(text, "project"), 1, "typed once and not executed: no echo output yet");
  checks.push(`type-as-you-talk: both phrases typed at the prompt, nothing executed (${JSON.stringify(result.transcript)})`);
  await page.screenshot({ path: path.join(shots, "dictation-typed.png") });

  await indicator.getByRole("button", { name: "Stop dictation" }).click();
  await indicator.waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.body.dataset.dictationMicrophone);
  assert.equal((await status()).recording, false);
  checks.push("Stop removes the indicator, releases the microphone tracks and ends the recording");

  // Enter is the user's: only now does the shell run the line.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => ((document.querySelector(".xterm-rows")?.textContent || "").toLowerCase().split("project").length - 1) === 2,
  );
  text = await screen();
  assert.match(text, /world/i);
  checks.push("pressing Enter runs the dictated line exactly once (shell echoed it)");

  // Button starts, shortcut stops (focus outside the terminal), mic released.
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await indicator.locator(".dictation-time").waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop dictation" }).first().getAttribute("aria-pressed"), "true");
  await page.locator(".session-meta").click();
  await page.keyboard.press(shortcut);
  await indicator.waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.body.dataset.dictationMicrophone);
  checks.push("mic button starts and the shortcut stops dictation outside the terminal; tracks released");

  // Losing the window stops listening.
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await indicator.locator(".dictation-time").waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await indicator.waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.body.dataset.dictationMicrophone);
  checks.push("window blur stops dictation and releases the microphone");

  // Canvas terminal headers carry the same control.
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  const card = page.locator(".canvas-terminal").first();
  await card.locator(".xterm-rows").waitFor();
  await card.getByRole("button", { name: "Dictate" }).click();
  await card.locator(".dictation-indicator.compact .dictation-time").waitFor();
  await page.screenshot({ path: path.join(shots, "dictation-canvas.png") });
  await card.getByRole("button", { name: "Stop dictation" }).click();
  await card.locator(".dictation-indicator").waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.body.dataset.dictationMicrophone);
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  checks.push("canvas terminal header starts and stops dictation");

  // A fresh launch replays the microphone file: switch sessions mid-phrase.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  watch(page);
  await page.waitForFunction(() => !!window.workspace?.dictation);
  await page.locator(".xterm-helper-textarea").waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".session-actions button")].some((b) => b.textContent?.includes("Dictate") && !b.disabled),
  );
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+U");
  await page.keyboard.type("clear");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !/world/i.test(document.querySelector(".xterm-rows")?.textContent || ""));
  await page.keyboard.type("echo ");
  await page.keyboard.press(shortcut);
  await page.locator(".dictation-indicator .dictation-time").waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => /world/i.test(document.querySelector(".xterm-rows")?.textContent?.split("echo").pop() || ""), null, { timeout: 60_000 });
  // Phrase two is being spoken now; open another session, detaching this view.
  await page.waitForTimeout(2300);
  await openShell();
  const leftover = page.locator(".dictation-notice").filter({ hasText: "Dictated text not typed" });
  await leftover.waitFor({ timeout: 60_000 });
  const leftoverText = (await leftover.locator(".dictation-leftover").textContent()).trim();
  result.leftover = leftoverText;
  assert.ok(leftoverText.length > 0);
  await page.waitForFunction(() => !document.body.dataset.dictationMicrophone);
  assert.equal(await page.locator(".dictation-indicator").count(), 0);
  // The new terminal received nothing.
  await page.waitForTimeout(500);
  assert.equal(/please|project/i.test(await screen()), false);
  await page.screenshot({ path: path.join(shots, "dictation-untyped.png") });
  await leftover.getByRole("button", { name: "Copy" }).click();
  await page.waitForFunction(
    async (expected) => (await navigator.clipboard.readText().catch(() => "")) === expected,
    leftoverText,
  ).catch(async () => {
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), leftoverText);
  });
  await leftover.getByRole("button", { name: "Dismiss untyped text" }).click();
  await leftover.waitFor({ state: "detached" });
  // The original terminal did not receive phrase two either.
  await page.locator(".session-tab:not(.active):not(.new-tab)").click();
  await page.waitForFunction(() => /world/i.test(document.querySelector(".xterm-rows")?.textContent || ""));
  const original = await screen();
  assert.equal(count(original.slice(original.lastIndexOf("echo")), "project"), 0);
  assert.equal((await command("snapshot")).sessions.find((s) => s.id === first.id).generation, first.generation);
  checks.push(`session switch mid-phrase stops dictation; untyped text shown with Copy, typed nowhere (${JSON.stringify(leftoverText)})`);

  // Audio is memory-only: nothing audio-like was written to the app's data folder.
  const written = (await readdir(path.join(fixture, "data"), { recursive: true })).map(String);
  assert.deepEqual(written.filter((f) => /\.(wav|pcm|raw|webm|ogg|mp3|f32|s16)$/i.test(f)), []);
  checks.push(`no audio file in the app data folder (${written.length} entries checked)`);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fixture, ...result, checks }));
} catch (error) {
  await page.screenshot({ path: path.join(fixture, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ passed: false, fixture, ...result, checks, error: String(error?.stack || error) }));
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
