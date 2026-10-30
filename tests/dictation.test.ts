import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unbzip2 from "unbzip2-stream";
import type { Transform } from "node:stream";
import {
  DICTATION_SAMPLE_RATE,
  MAX_PHRASE_SAMPLES,
  cleanTranscript,
  createResampler,
  createSegmenter,
  fromInt16,
  phraseInsertion,
  sameDestination,
  toInt16,
  validatePhrasePayload,
} from "../src/shared/dictation.js";
import {
  DICTATION_MODELS,
  installModel,
  verifyModel,
  type DictationModel,
} from "../src/desktop/dictation-models.js";
import { createDictationService, type WorkerHandle } from "../src/desktop/dictation.js";
import { createSherpaTranscriber } from "../src/desktop/dictation-engine.js";

const RATE = DICTATION_SAMPLE_RATE;
const tone = (seconds: number, amplitude = 0.3, rate = RATE, hz = 220) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) =>
    amplitude * Math.sin((2 * Math.PI * hz * i) / rate) * (0.8 + 0.2 * Math.sin((2 * Math.PI * 3 * i) / rate)),
  );
const silence = (seconds: number, rate = RATE) => {
  // Low room noise, deterministic.
  let seed = 7;
  return Float32Array.from({ length: Math.round(seconds * rate) }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed / 0x7fffffff) * 2 - 1) * 0.002;
  });
};
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
/** Feeds audio in irregular chunks, as a real capture callback would. */
function segment(audio: Float32Array, options = {}) {
  const segmenter = createSegmenter(options);
  const phrases: Float32Array[] = [];
  const sizes = [1365, 128, 4096, 777];
  for (let i = 0, k = 0; i < audio.length; k++) {
    const n = sizes[k % sizes.length];
    phrases.push(...segmenter.push(audio.subarray(i, i + n)));
    i += n;
  }
  return { phrases, tail: segmenter.flush() };
}
const seconds = (samples: Float32Array) => samples.length / RATE;

test("resampler converts 48 kHz and 44.1 kHz to 16 kHz without drift at chunk boundaries", () => {
  for (const rate of [48000, 44100, 22050]) {
    const input = tone(2, 0.5, rate, 440);
    const whole = createResampler(rate)(input);
    const chunked = createResampler(rate);
    const pieces: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 1000) pieces.push(chunked(input.subarray(i, i + 1000)));
    const joined = concat(...pieces);
    assert.ok(Math.abs(whole.length - 2 * RATE) <= 2, `${rate}: ${whole.length} samples`);
    assert.ok(Math.abs(joined.length - whole.length) <= 1);
    for (let i = 0; i < Math.min(joined.length, whole.length); i++)
      assert.ok(Math.abs(joined[i] - whole[i]) < 1e-4, `${rate}: sample ${i} differs`);
    // The 440 Hz tone keeps its frequency: ~880 zero crossings per second.
    let crossings = 0;
    for (let i = 1; i < whole.length; i++) if ((whole[i - 1] < 0) !== (whole[i] < 0)) crossings++;
    assert.ok(Math.abs(crossings / 2 - 880) < 20, `${rate}: ${crossings} crossings`);
  }
  // 16 kHz passes through unchanged in length; 8 kHz is upsampled.
  assert.equal(createResampler(16000)(tone(1)).length, RATE);
  assert.ok(Math.abs(createResampler(8000)(tone(1, 0.3, 8000)).length - RATE) <= 2);
  assert.throws(() => createResampler(0));
});

test("segmenter: silence and clicks produce nothing", () => {
  assert.deepEqual(segment(silence(5)).phrases, []);
  assert.equal(segment(silence(5)).tail, null);
  // A 20 ms click and a 100 ms knock are shorter than the minimum speech.
  const click = concat(silence(1), tone(0.02, 0.8), silence(1), tone(0.1, 0.8), silence(2));
  const { phrases, tail } = segment(click);
  assert.equal(phrases.length, 0);
  assert.equal(tail, null);
});

test("segmenter: a pause of ~700 ms ends a phrase; shorter pauses do not", () => {
  const audio = concat(silence(1), tone(1.2), silence(0.3), tone(0.8), silence(1.2), tone(1.5), silence(1.5));
  const { phrases, tail } = segment(audio);
  assert.equal(phrases.length, 2, "two phrases split at the long pause only");
  // First phrase: 1.2 s + 0.3 s pause + 0.8 s, plus pre-roll and kept trailing quiet.
  assert.ok(seconds(phrases[0]) > 2.3 && seconds(phrases[0]) < 3.0, `first ${seconds(phrases[0])}`);
  assert.ok(seconds(phrases[1]) > 1.5 && seconds(phrases[1]) < 2.2, `second ${seconds(phrases[1])}`);
  assert.equal(tail, null);
  // Speech with no trailing pause is returned by flush() on Stop.
  const cut = segment(concat(silence(0.5), tone(2)));
  assert.equal(cut.phrases.length, 0);
  assert.ok(cut.tail && seconds(cut.tail) > 1.9);
});

test("segmenter: continuous speech is cut at the 15 s cap and every phrase fits the IPC bound", () => {
  const { phrases, tail } = segment(concat(silence(0.5), tone(40), silence(1)));
  assert.equal(phrases.length, 3);
  for (const p of phrases) assert.ok(p.length <= MAX_PHRASE_SAMPLES);
  assert.ok(Math.abs(seconds(phrases[0]) - 15) < 0.1, `capped at ${seconds(phrases[0])}`);
  assert.ok(Math.abs(seconds(phrases[1]) - 15) < 0.1);
  assert.equal(tail, null);
  const total = phrases.reduce((n, p) => n + seconds(p), 0);
  assert.ok(total > 39.5 && total < 41.5, `total ${total}`);
});

test("segmenter: a steady noise floor does not count as speech", () => {
  const hum = tone(6, 0.008, RATE, 60);
  assert.equal(segment(hum).phrases.length, 0);
  const speechOverHum = concat(hum, tone(1.5, 0.25), tone(2, 0.008, RATE, 60));
  assert.equal(segment(speechOverHum).phrases.length, 1);
});

test("16-bit conversion round-trips within one step and clips", () => {
  const x = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]);
  const y = fromInt16(toInt16(x));
  for (let i = 0; i < 5; i++) assert.ok(Math.abs(x[i] - y[i]) < 1 / 16384);
  assert.deepEqual(Array.from(toInt16(Float32Array.from([2, -2]))), [32767, -32768]);
});

test("transcripts drop Whisper non-speech tokens and never contain control bytes", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO] "), "");
  assert.equal(cleanTranscript("(music)"), "");
  assert.equal(cleanTranscript("[ Silence ]"), "");
  assert.equal(cleanTranscript("[Music] ♪ ♪"), "");
  assert.equal(cleanTranscript("*laughs* Hello there. (applause)"), "Hello there.");
  assert.equal(cleanTranscript(">> Open the README file."), "Open the README file.");
  assert.equal(cleanTranscript("line one\r\nline two\nthree\u2028four\tfive"), "line one line two three four five");
  assert.equal(cleanTranscript("rm -rf /\r"), "rm -rf /");
  assert.equal(cleanTranscript("a\u001b[31mred\u001b[0m\u0007 b\u009b c\u202e d"), "a[31mred[0m b c d");
  assert.equal(cleanTranscript(undefined), "");
  assert.equal(cleanTranscript(42), "");
  // Random strings full of controls: nothing that could submit, escape or reorder.
  let seed = 1;
  for (let n = 0; n < 2000; n++) {
    let s = "";
    for (let i = 0; i < 40; i++) {
      seed = (seed * 48271) % 0x7fffffff;
      s += String.fromCharCode(seed % 0x300);
    }
    const out = cleanTranscript(s);
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(out), false, JSON.stringify(out));
    const typed = phraseInsertion(s, true);
    assert.equal(/[\r\n\u001b]/.test(typed), false);
  }
});

test("phrases are joined with a single space and empty phrases type nothing", () => {
  assert.equal(phraseInsertion("Hello world.", false), "Hello world.");
  assert.equal(phraseInsertion("  Next   phrase  ", true), " Next phrase");
  assert.equal(phraseInsertion("[BLANK_AUDIO]", true), "");
  assert.equal(phraseInsertion("\r\n", true), "");
});

test("insertion requires the same session, generation and attached viewer", () => {
  const fixed = { sessionId: "s1", generation: 2, viewerId: "v1" };
  assert.equal(sameDestination(fixed, { sessionId: "s1", generation: 2, viewerId: "v1" }), true);
  assert.equal(sameDestination(fixed, { sessionId: "s1", generation: 2, viewerId: "v2" }), false, "reattached viewer");
  assert.equal(sameDestination(fixed, { sessionId: "s1", generation: 3, viewerId: "v1" }), false, "restarted process");
  assert.equal(sameDestination(fixed, { sessionId: "s2", generation: 2, viewerId: "v1" }), false, "other session");
  assert.equal(sameDestination(fixed, { sessionId: "s1", generation: 2, viewerId: null }), false, "detached");
  assert.equal(sameDestination(fixed, null), false, "view closed");
});

test("phrase IPC payloads are bounded and strictly shaped", () => {
  const ok = { recordingId: "abcdefgh12345678", sequence: 1, pcm: new Int16Array(16000) };
  assert.equal(validatePhrasePayload(ok).samples.length, 16000);
  const bytes = new Uint8Array(new Int16Array([1, -1, 300]).buffer);
  assert.deepEqual(Array.from(validatePhrasePayload({ ...ok, pcm: bytes }).samples), [1, -1, 300]);
  const bad: [unknown, RegExp][] = [
    [null, /Invalid dictation phrase/],
    [[], /Invalid dictation phrase/],
    [{ ...ok, extra: 1 }, /Invalid dictation phrase/],
    [{ ...ok, recordingId: "../x" }, /recording/],
    [{ ...ok, sequence: 0 }, /sequence/],
    [{ ...ok, sequence: 1.5 }, /sequence/],
    [{ ...ok, pcm: new Float32Array(10) }, /16-bit/],
    [{ ...ok, pcm: [1, 2, 3] }, /16-bit/],
    [{ ...ok, pcm: new Uint8Array(3) }, /16-bit/],
    [{ ...ok, pcm: new Int16Array(0) }, /16-bit/],
    [{ ...ok, pcm: new Int16Array(MAX_PHRASE_SAMPLES + 1) }, /30 seconds/],
  ];
  for (const [value, message] of bad) assert.throws(() => validatePhrasePayload(value), message);
  assert.doesNotThrow(() => validatePhrasePayload({ ...ok, pcm: new Int16Array(MAX_PHRASE_SAMPLES) }));
});

const hasTar = (() => {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    execFileSync("bzip2", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const sha = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");
/** A fixture "model" archive laid out like the real release asset. */
function fixtureModel(tmp: string, extra: Record<string, string> = {}) {
  const root = path.join(tmp, "src");
  const dir = path.join(root, "sherpa-onnx-whisper-tiny.en");
  fs.mkdirSync(dir, { recursive: true });
  const content = {
    "tiny.en-encoder.int8.onnx": "encoder-bytes".repeat(500),
    "tiny.en-decoder.int8.onnx": "decoder-bytes".repeat(900),
    "tiny.en-tokens.txt": "tokens\n".repeat(50),
    "tiny.en-decoder.onnx": "unused fp32 decoder",
  };
  for (const [name, data] of Object.entries(content)) fs.writeFileSync(path.join(dir, name), data);
  for (const [name, data] of Object.entries(extra)) fs.writeFileSync(path.join(root, name), data);
  const archive = path.join(tmp, "model.tar.bz2");
  execFileSync("tar", ["-cjf", archive, "-C", root, ...fs.readdirSync(root)]);
  const bytes = fs.readFileSync(archive);
  const file = (name: keyof typeof content, as: string) => ({
    entry: "sherpa-onnx-whisper-tiny.en/" + name,
    name: as,
    bytes: Buffer.byteLength(content[name]),
    sha256: sha(content[name]),
  });
  const model: DictationModel = {
    ...DICTATION_MODELS["tiny.en"],
    url: "https://example.invalid/model.tar.bz2",
    archiveBytes: bytes.length,
    archiveSha256: sha(bytes),
    files: {
      encoder: file("tiny.en-encoder.int8.onnx", "encoder.int8.onnx"),
      decoder: file("tiny.en-decoder.int8.onnx", "decoder.int8.onnx"),
      tokens: file("tiny.en-tokens.txt", "tokens.txt"),
    },
  };
  return { archive, bytes, model };
}
const bunzip = () => unbzip2() as unknown as Transform;
const listing = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test("model install verifies the archive checksum, unpacks only expected files and verifies them", { skip: !hasTar && "tar/bzip2 unavailable" }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-dictation-model-"));
  try {
    const { archive, bytes, model } = fixtureModel(tmp, { "evil.txt": "outside" });
    const modelsDir = path.join(tmp, "models");
    const phases = new Set<string>();
    // Served through the injected fetch, as Electron's net.fetch would.
    await installModel({
      modelsDir,
      model,
      fetch: async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
      bunzip,
      onProgress: (p) => phases.add(p.phase),
    });
    assert.deepEqual([...phases], ["downloading", "verifying", "unpacking"]);
    assert.deepEqual(listing(modelsDir), ["tiny.en"], "no temporary archive or staging folder left");
    assert.deepEqual(listing(path.join(modelsDir, "tiny.en")), ["decoder.int8.onnx", "encoder.int8.onnx", "tokens.txt"]);
    for (const name of listing(path.join(modelsDir, "tiny.en")))
      assert.equal(fs.statSync(path.join(modelsDir, "tiny.en", name)).mode & 0o777, 0o600);
    const files = await verifyModel(modelsDir, model);
    assert.equal(files.encoder, path.join(modelsDir, "tiny.en", "encoder.int8.onnx"));

    // A changed byte in an installed file is caught before use.
    fs.appendFileSync(files.tokens, "x");
    await assert.rejects(verifyModel(modelsDir, model), /missing or incomplete/);
    fs.writeFileSync(files.tokens, "tokens\n".repeat(49) + "tokenX\n");
    await assert.rejects(verifyModel(modelsDir, model), /failed its checksum/);

    // A tampered archive is rejected before anything is unpacked.
    const corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 10] ^= 0xff;
    const other = path.join(tmp, "models-2");
    await assert.rejects(
      installModel({ modelsDir: other, model, fetch: async () => new Response(corrupted), bunzip }),
      /failed its checksum and was discarded/,
    );
    assert.deepEqual(listing(other), [], "nothing kept after a checksum failure");

    // A wrong pinned file checksum rejects the unpacked files too.
    const wrongFile = { ...model, files: { ...model.files, decoder: { ...model.files.decoder, sha256: "0".repeat(64) } } };
    await assert.rejects(
      installModel({ modelsDir: other, model: wrongFile, localArchive: archive, bunzip }),
      /unpacked model file failed its checksum/,
    );
    assert.deepEqual(listing(other), []);

    // Size limit: a server sending more than the pinned size is cut off.
    const larger = Buffer.concat([bytes, Buffer.alloc(1024)]);
    await assert.rejects(
      installModel({ modelsDir: other, model, fetch: async () => new Response(larger), bunzip }),
      /larger than expected/,
    );
    await assert.rejects(
      installModel({
        modelsDir: other,
        model,
        fetch: async () => new Response(larger, { headers: { "content-length": String(larger.length) } }),
        bunzip,
      }),
      /unexpected size/,
    );
    await assert.rejects(
      installModel({ modelsDir: other, model, fetch: async () => new Response("nope", { status: 404 }), bunzip }),
      /HTTP 404/,
    );
    assert.deepEqual(listing(other), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** A fake dictation utility process that answers like the real one. */
function fakeWorker(texts: string[], log: string[]) {
  const emitter = new EventEmitter();
  const handle: WorkerHandle = {
    postMessage(message: any) {
      log.push(message.type);
      setImmediate(() => {
        if (message.type === "load") emitter.emit("message", { type: "result", id: message.id, result: true });
        else if (message.type === "transcribe") {
          assert.ok(message.pcm instanceof Int16Array);
          emitter.emit("message", { type: "result", id: message.id, result: texts.shift() ?? "" });
        } else emitter.emit("message", { type: "result", id: message.id, error: "unsupported" });
      });
    },
    on(event: string, listener: (...args: any[]) => void) {
      emitter.on(event, listener);
    },
    kill() {
      log.push("kill");
      emitter.emit("exit", 0);
      return true;
    },
  } as WorkerHandle;
  setImmediate(() => emitter.emit("message", { type: "ready" }));
  return handle;
}

test("dictation service: one recording at a time, ordered bounded phrases, cleaned text, refused after stop", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-dictation-service-"));
  const log: string[] = [];
  const texts = ["  Hello world. [BLANK_AUDIO]", "(music)", "line\r\nbreak\u001b[A"];
  let forks = 0;
  const service = createDictationService({
    modelsDir: path.join(tmp, "models"),
    engine: "sherpa-onnx",
    fork: () => {
      forks++;
      return fakeWorker(texts, log);
    },
    readModel: async () => "tiny.en",
    emit: () => {},
  });
  try {
    await assert.rejects(service.start(), /Download the English speech model/);
    // Install the selected model's files (sizes only matter for presence).
    const model = DICTATION_MODELS["tiny.en"];
    fs.mkdirSync(path.join(tmp, "models", "tiny.en"), { recursive: true });
    for (const file of Object.values(model.files)) {
      const fd = fs.openSync(path.join(tmp, "models", "tiny.en", file.name), "w");
      fs.ftruncateSync(fd, file.bytes);
      fs.closeSync(fd);
    }
    const status = await service.status();
    assert.equal(status.selected, "tiny.en");
    assert.equal(status.models.find((m) => m.id === "tiny.en")?.installed, true);
    assert.match(status.models[0].source, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/asr-models\//);
    assert.match(status.models[0].sha256, /^[0-9a-f]{64}$/);

    const stale = await service.start();
    const pcm = new Int16Array(1600);
    const { recordingId, modelId } = await service.start();
    assert.equal(modelId, "tiny.en");
    assert.notEqual(recordingId, stale.recordingId);
    await assert.rejects(service.phrase({ recordingId: stale.recordingId, sequence: 1, pcm }), /has ended/, "superseded recording");
    assert.deepEqual(await service.phrase({ recordingId, sequence: 1, pcm }), { text: "Hello world." });
    assert.deepEqual(await service.phrase({ recordingId, sequence: 2, pcm }), { text: "" });
    await assert.rejects(service.phrase({ recordingId, sequence: 2, pcm }), /out of order/);
    await assert.rejects(service.phrase({ recordingId: "x".repeat(16), sequence: 3, pcm }), /has ended/);
    const third = await service.phrase({ recordingId, sequence: 5, pcm });
    assert.equal(third.text, "line break[A");
    assert.equal(/[\r\n\u001b]/.test(third.text), false);
    await service.stop(recordingId);
    await assert.rejects(service.phrase({ recordingId, sequence: 6, pcm }), /has ended/);
    assert.equal((await service.status()).recording, false);
    assert.equal(forks, 1);
    assert.deepEqual(log, ["load", "load", "transcribe", "transcribe", "transcribe"]);
    await assert.rejects(service.downloadModel("large-v3"), /Unknown dictation model/);
  } finally {
    service.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Opt-in: downloads the real tiny.en model (118 MB) unless
// WORKSPACE_TEST_DICTATION_ARCHIVE points at a local copy of the release asset,
// then transcribes a clip synthesized with espeak-ng.
const realEngine = process.env.WORKSPACE_TEST_REAL_DICTATION === "1";
test("real engine: tiny.en transcribes synthesized English locally", { skip: !realEngine && "set WORKSPACE_TEST_REAL_DICTATION=1", timeout: 900_000 }, async () => {
  const modelsDir = process.env.WORKSPACE_TEST_DICTATION_MODELS || fs.mkdtempSync(path.join(os.tmpdir(), "aw-dictation-real-"));
  const model = DICTATION_MODELS["tiny.en"];
  try {
    await verifyModel(modelsDir, model);
  } catch {
    await installModel({
      modelsDir,
      model,
      fetch: (url, init) => fetch(url, init),
      localArchive: process.env.WORKSPACE_TEST_DICTATION_ARCHIVE || undefined,
      bunzip,
    });
  }
  const files = await verifyModel(modelsDir, model);
  const wav = path.join(os.tmpdir(), `aw-dictation-${process.pid}.wav`);
  try {
    execFileSync("espeak-ng", ["-v", "en-us", "-s", "140", "-w", wav, "Hello world. Please open the readme file."]);
    const data = fs.readFileSync(wav);
    // espeak-ng writes 22.05 kHz 16-bit mono PCM after a 44-byte header.
    const rate = data.readUInt32LE(24);
    const pcm = new Int16Array(data.buffer.slice(data.byteOffset + 44, data.byteOffset + data.length - ((data.length - 44) % 2)));
    const samples = createResampler(rate)(fromInt16(pcm));
    const transcriber = createSherpaTranscriber(files);
    const started = Date.now();
    const text = cleanTranscript(await transcriber.transcribe(samples));
    console.log(`real engine (${Date.now() - started} ms): ${JSON.stringify(text)}`);
    // espeak-ng's robotic "hello" is sometimes heard as "the low"; the rest is stable.
    assert.match(text.toLowerCase(), /world/);
    assert.match(text.toLowerCase(), /please open the (readme|read me) file/);
  } finally {
    fs.rmSync(wav, { force: true });
  }
});
