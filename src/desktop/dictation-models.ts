/**
 * English Whisper models for local dictation: a fixed catalog with pinned
 * addresses, sizes and SHA-256 checksums, an explicit installer and the
 * verification that runs before every model load. Nothing downloads unless
 * the owner asks for it, and nothing is used unless every file matches.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DictationModelId } from "../shared/dictation.js";

export interface ModelFile {
  /** Path inside the release archive. */
  entry: string;
  /** Name inside the installed model folder. */
  name: string;
  bytes: number;
  sha256: string;
}
export interface DictationModel {
  id: DictationModelId;
  label: string;
  description: string;
  url: string;
  archiveBytes: number;
  archiveSha256: string;
  files: { encoder: ModelFile; decoder: ModelFile; tokens: ModelFile };
}

const RELEASE =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/";
export const MODEL_PROVENANCE =
  "OpenAI Whisper English weights (MIT license), exported to ONNX with int8 " +
  "quantization by the k2-fsa sherpa-onnx project (Apache-2.0), published " +
  "in its GitHub “asr-models” release. Only the int8 encoder, decoder and " +
  "token list are kept.";
export const MODEL_LICENSE = "MIT (Whisper weights); Apache-2.0 (ONNX export tooling)";

/** Checksums were computed from the release assets on 2026-10-30. */
export const DICTATION_MODELS: Record<DictationModelId, DictationModel> = {
  "base.en": {
    id: "base.en",
    label: "English · base",
    description: "Recommended. More accurate, a little slower.",
    url: RELEASE + "sherpa-onnx-whisper-base.en.tar.bz2",
    archiveBytes: 208_576_005,
    archiveSha256: "475bc7052ce299c007f6d5d5407ba8601f819a2867f6eecee510ed17df581542",
    files: {
      encoder: {
        entry: "sherpa-onnx-whisper-base.en/base.en-encoder.int8.onnx",
        name: "encoder.int8.onnx",
        bytes: 29_120_534,
        sha256: "ef6b936f4c9b1d90a3b68634b60c4ed8576b26172b33c2535ec0e933c9edb823",
      },
      decoder: {
        entry: "sherpa-onnx-whisper-base.en/base.en-decoder.int8.onnx",
        name: "decoder.int8.onnx",
        bytes: 130_669_978,
        sha256: "f7162ad6db2dbef16cfaeaa7f945b9d7dd9c1b8d472f6aca82f2273d185e4d41",
      },
      tokens: {
        entry: "sherpa-onnx-whisper-base.en/base.en-tokens.txt",
        name: "tokens.txt",
        bytes: 835_554,
        sha256: "306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930",
      },
    },
  },
  "tiny.en": {
    id: "tiny.en",
    label: "English · tiny",
    description: "Faster and smaller; makes more mistakes.",
    url: RELEASE + "sherpa-onnx-whisper-tiny.en.tar.bz2",
    archiveBytes: 118_071_777,
    archiveSha256: "2bd6cf965c8bb3e068ef9fa2191387ee63a9dfa2a4e37582a8109641c20005dd",
    files: {
      encoder: {
        entry: "sherpa-onnx-whisper-tiny.en/tiny.en-encoder.int8.onnx",
        name: "encoder.int8.onnx",
        bytes: 12_937_772,
        sha256: "0ce578b827c94a961aacb8fa14b02f096504b337e5c94be37c36238cbe3e8bc6",
      },
      decoder: {
        entry: "sherpa-onnx-whisper-tiny.en/tiny.en-decoder.int8.onnx",
        name: "decoder.int8.onnx",
        bytes: 89_853_865,
        sha256: "06c0e6ff6348d427e51839219d1c886c18cfdf411e629e33f5e1679bff9c1527",
      },
      tokens: {
        entry: "sherpa-onnx-whisper-tiny.en/tiny.en-tokens.txt",
        name: "tokens.txt",
        bytes: 835_554,
        sha256: "306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930",
      },
    },
  },
};

export const modelFiles = (model: DictationModel) => Object.values(model.files);
export const modelDiskBytes = (model: DictationModel) =>
  modelFiles(model).reduce((n, f) => n + f.bytes, 0);
export const modelDir = (modelsDir: string, model: DictationModel) =>
  path.join(modelsDir, model.id);

/** Cheap presence check for status: every file exists with its exact size. */
export function modelPresent(modelsDir: string, model: DictationModel) {
  return modelFiles(model).every((file) => {
    try {
      return fs.statSync(path.join(modelDir(modelsDir, model), file.name)).size === file.bytes;
    } catch {
      return false;
    }
  });
}

async function sha256File(file: string) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/** Full verification before use: sizes and SHA-256 of every installed file. */
export async function verifyModel(modelsDir: string, model: DictationModel) {
  const dir = modelDir(modelsDir, model);
  for (const file of modelFiles(model)) {
    const target = path.join(dir, file.name);
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat || !stat.isFile() || stat.size !== file.bytes)
      throw new Error(`The ${model.label} model is missing or incomplete. Download it again.`);
    if ((await sha256File(target)) !== file.sha256)
      throw new Error(`The ${model.label} model failed its checksum. Download it again.`);
  }
  return {
    encoder: path.join(dir, model.files.encoder.name),
    decoder: path.join(dir, model.files.decoder.name),
    tokens: path.join(dir, model.files.tokens.name),
  };
}

export interface InstallProgress {
  phase: "downloading" | "verifying" | "unpacking";
  received: number;
  total: number;
}
export interface InstallOptions {
  modelsDir: string;
  model: DictationModel;
  /** Fetches the pinned URL; Electron's net.fetch in the app. */
  fetch?: (url: string, init: { signal?: AbortSignal }) => Promise<Response>;
  /** Test-only: read this local archive instead of the network. */
  localArchive?: string;
  /** Decompresses bzip2; injected so the installer has no hard dependency. */
  bunzip: () => Transform;
  onProgress?: (progress: InstallProgress) => void;
  signal?: AbortSignal;
}

/**
 * Downloads the pinned archive to a private temporary file, rejects it unless
 * its size and SHA-256 match, extracts only the three expected files into a
 * staging folder, verifies each of them, then renames the folder into place.
 * A failure at any step leaves no partial model behind.
 */
export async function installModel(options: InstallOptions) {
  const { model, modelsDir } = options;
  await fsp.mkdir(modelsDir, { recursive: true, mode: 0o700 });
  const tag = crypto.randomBytes(6).toString("hex");
  const archive = path.join(modelsDir, `.download-${model.id}-${tag}.tar.bz2`);
  const staging = path.join(modelsDir, `.staging-${model.id}-${tag}`);
  const report = (phase: InstallProgress["phase"], received: number) =>
    options.onProgress?.({ phase, received, total: model.archiveBytes });
  try {
    // 1. Download with a hard size limit, hashing as it streams.
    let source: Readable;
    if (options.localArchive) source = fs.createReadStream(options.localArchive);
    else {
      if (!options.fetch) throw new Error("No download method");
      const response = await options.fetch(model.url, { signal: options.signal });
      if (!response.ok || !response.body)
        throw new Error(`The model download failed (HTTP ${response.status})`);
      const declared = Number(response.headers.get("content-length"));
      if (declared && declared !== model.archiveBytes)
        throw new Error("The model download has an unexpected size");
      source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    }
    const hash = crypto.createHash("sha256");
    let received = 0;
    let lastReport = 0;
    report("downloading", 0);
    await pipeline(
      source,
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          if (received > model.archiveBytes)
            return done(new Error("The model download is larger than expected"));
          hash.update(chunk);
          if (received - lastReport > 1 << 20) {
            lastReport = received;
            report("downloading", received);
          }
          done(null, chunk);
        },
      }),
      fs.createWriteStream(archive, { mode: 0o600, flags: "wx" }),
      { signal: options.signal },
    );
    report("verifying", received);
    if (received !== model.archiveBytes || hash.digest("hex") !== model.archiveSha256)
      throw new Error("The downloaded model failed its checksum and was discarded");

    // 2. Extract only the expected entries.
    report("unpacking", 0);
    await fsp.mkdir(staging, { mode: 0o700 });
    const wanted = new Map(modelFiles(model).map((f) => [f.entry, f]));
    let unpacked = 0;
    const written = await extractTar(
      fs.createReadStream(archive).pipe(options.bunzip()),
      (name, size) => {
        const file = wanted.get(name);
        if (!file) return null;
        if (size !== file.bytes) throw new Error("The model archive has an unexpected file size");
        return path.join(staging, file.name);
      },
      (bytes) => {
        unpacked += bytes;
        if (unpacked - lastReport > 4 << 20 || unpacked < lastReport) {
          lastReport = unpacked;
          report("unpacking", unpacked);
        }
      },
      options.signal,
    );
    if (written.size !== wanted.size)
      throw new Error("The model archive is missing expected files");

    // 3. Verify each unpacked file, then move the folder into place.
    for (const file of modelFiles(model))
      if ((await sha256File(path.join(staging, file.name))) !== file.sha256)
        throw new Error("An unpacked model file failed its checksum and was discarded");
    const target = modelDir(modelsDir, model);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(staging, target);
  } finally {
    await fsp.rm(archive, { force: true });
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Minimal streaming ustar reader. `choose` names the destination for an entry
 * or returns null to skip it; only regular files are ever written, each to a
 * caller-chosen path, so archive names cannot escape the staging folder.
 */
export async function extractTar(
  input: Readable,
  choose: (name: string, size: number) => string | null,
  onBytes?: (bytes: number) => void,
  signal?: AbortSignal,
) {
  const written = new Set<string>();
  let buffer: Buffer = Buffer.alloc(0);
  let state:
    | { kind: "header" }
    | { kind: "body"; remaining: number; padding: number; out: fs.WriteStream | null; name: string } = {
    kind: "header",
  };
  let longName: string | null = null;
  let ended = false;
  const closeOut = (out: fs.WriteStream) =>
    new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  await pipeline(
    input,
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        void (async () => {
          buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
          onBytes?.(chunk.length);
          while (!ended) {
            if (state.kind === "header") {
              if (buffer.length < 512) break;
              const header = buffer.subarray(0, 512);
              buffer = buffer.subarray(512);
              if (header.every((b) => b === 0)) {
                ended = true;
                break;
              }
              const field = (start: number, length: number) =>
                header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
              const size = parseInt(field(124, 12).trim() || "0", 8);
              if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid model archive");
              const sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
              if (sum !== parseInt(field(148, 8).trim(), 8)) throw new Error("Invalid model archive");
              const type = String.fromCharCode(header[156] || 48);
              const prefix = field(345, 155);
              let name = (prefix ? prefix + "/" : "") + field(0, 100);
              if (longName !== null) {
                name = longName;
                longName = null;
              }
              const padding = (512 - (size % 512)) % 512;
              let out: fs.WriteStream | null = null;
              if (type === "0" || type === "7") {
                const target = choose(name.replace(/^\.\//, ""), size);
                if (target) {
                  if (written.has(target)) throw new Error("Invalid model archive");
                  written.add(target);
                  out = fs.createWriteStream(target, { mode: 0o600, flags: "wx" });
                }
              }
              if (type === "L") longName = "";
              state = { kind: "body", remaining: size, padding, out, name: type === "L" ? "\0L" : name };
            } else {
              if (state.remaining > 0) {
                if (!buffer.length) break;
                const take = Math.min(state.remaining, buffer.length);
                const piece = buffer.subarray(0, take);
                buffer = buffer.subarray(take);
                state.remaining -= take;
                if (state.name === "\0L") longName = (longName ?? "") + piece.toString("utf8");
                else if (state.out && !state.out.write(piece))
                  await new Promise<void>((r) => state.kind === "body" && state.out!.once("drain", () => r()));
                continue;
              }
              if (buffer.length < state.padding) break;
              buffer = buffer.subarray(state.padding);
              if (state.name === "\0L") longName = (longName ?? "").replace(/\0.*$/s, "");
              if (state.out) await closeOut(state.out);
              state = { kind: "header" };
            }
          }
        })().then(() => done(), done);
      },
      final(done) {
        if (state.kind === "body" && (state.remaining > 0 || state.out))
          done(new Error("The model archive ended early"));
        else done();
      },
      destroy(error, done) {
        if (state.kind === "body" && state.out) state.out.destroy();
        done(error);
      },
    }),
    { signal },
  );
  return written;
}
