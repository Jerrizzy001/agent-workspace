/**
 * Dictation utility process: model installation and speech-to-text, off the
 * renderer and off the main process's event loop. It receives messages only
 * from the desktop main process. Audio arrives as in-memory PCM and is never
 * written to disk; only text is returned.
 */
import { net } from "electron";
import unbzip2 from "unbzip2-stream";
import type { Transform } from "node:stream";
import { DICTATION_MODELS, installModel, verifyModel } from "./dictation-models.js";
import { createFixtureTranscriber, createSherpaTranscriber, type Transcriber } from "./dictation-engine.js";
import { fromInt16, isDictationModelId } from "../shared/dictation.js";

const port = (process as any).parentPort;
const fixtureText = process.env.WORKSPACE_TEST_DICTATION_TEXT;
let loaded: { modelId: string; transcriber: Transcriber } | null = null;
let download: AbortController | null = null;
const reply = (id: number, result?: unknown, error?: unknown) =>
  port.postMessage({
    type: "result",
    id,
    result,
    error: error === undefined ? undefined : error instanceof Error ? error.message : "Dictation failed",
  });

port.on("message", async ({ data }: any) => {
  const id = Number(data?.id);
  try {
    const modelId: unknown = data.modelId;
    if (data.type === "download") {
      if (!isDictationModelId(modelId)) throw new Error("Unknown dictation model");
      if (download) throw new Error("A model download is already running");
      download = new AbortController();
      try {
        await installModel({
          modelsDir: data.modelsDir,
          model: DICTATION_MODELS[modelId],
          fetch: (url, init) => net.fetch(url, { ...init, redirect: "follow", cache: "no-store" } as RequestInit),
          localArchive: process.env.WORKSPACE_TEST_DICTATION_ARCHIVE || undefined,
          bunzip: () => unbzip2() as unknown as Transform,
          signal: download.signal,
          onProgress: (progress) => port.postMessage({ type: "progress", modelId, ...progress }),
        });
      } finally {
        download = null;
      }
      return reply(id, true);
    }
    if (data.type === "load") {
      if (!isDictationModelId(modelId)) throw new Error("Unknown dictation model");
      if (loaded?.modelId === modelId) return reply(id, true);
      loaded?.transcriber.close();
      loaded = null;
      const transcriber = fixtureText !== undefined
        ? createFixtureTranscriber(fixtureText)
        : createSherpaTranscriber(await verifyModel(data.modelsDir, DICTATION_MODELS[modelId]));
      loaded = { modelId, transcriber };
      return reply(id, true);
    }
    if (data.type === "transcribe") {
      if (!loaded) throw new Error("No dictation model is loaded");
      if (!(data.pcm instanceof Int16Array)) throw new Error("Invalid dictation audio");
      const text = await loaded.transcriber.transcribe(fromInt16(data.pcm));
      return reply(id, text);
    }
    if (data.type === "cancelDownload") {
      download?.abort();
      return reply(id, true);
    }
    throw new Error("Unsupported dictation request");
  } catch (error) {
    reply(id, undefined, error);
  }
});
port.postMessage({ type: "ready" });
