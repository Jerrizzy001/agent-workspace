/**
 * Desktop main-process side of local dictation. Owns the one dictation
 * utility process, the single active recording ID and the bounds on every
 * request. Reached only through the owner-checked `workspace:dictation` IPC.
 */
import crypto from "node:crypto";
import path from "node:path";
import type { DictationDownload, DictationStatus } from "../shared/contracts";
import {
  DICTATION_MODEL_IDS,
  MAX_PENDING_PHRASES,
  MAX_RECORDING_MS,
  cleanTranscript,
  isDictationModelId,
  validatePhrasePayload,
  type DictationModelId,
} from "../shared/dictation";
import {
  DICTATION_MODELS,
  MODEL_LICENSE,
  MODEL_PROVENANCE,
  modelDiskBytes,
  modelPresent,
} from "./dictation-models";

export interface WorkerHandle {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: any) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  kill(): boolean;
}
export interface DictationServiceOptions {
  modelsDir: string;
  /** Starts the dictation utility process. */
  fork: () => WorkerHandle;
  readModel: () => Promise<unknown>;
  emit: (status: DictationStatus) => void;
  engine: string;
}

const PHRASE_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 60_000;
const IDLE_EXIT_MS = 120_000;

export function createDictationService(options: DictationServiceOptions) {
  let worker: WorkerHandle | null = null;
  let workerReady: Promise<void> | null = null;
  let requestId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let recording:
    | { id: string; modelId: DictationModelId; sequence: number; inFlight: number; started: number; timer: NodeJS.Timeout }
    | null = null;
  let download: DictationDownload | null = null;
  let engineError: string | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  function ensureWorker() {
    clearTimeout(idleTimer);
    if (worker && workerReady) return workerReady;
    const child = options.fork();
    worker = child;
    workerReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Speech engine did not start")), 15000);
      child.on("message", (message: any) => {
        if (message?.type === "ready") {
          clearTimeout(timer);
          resolve();
        } else if (message?.type === "progress" && download) {
          download = {
            modelId: download.modelId,
            phase: message.phase,
            received: Number(message.received) || 0,
            total: Number(message.total) || 0,
          };
          void emitStatus();
        } else if (message?.type === "result") {
          const p = pending.get(message.id);
          if (!p) return;
          pending.delete(message.id);
          if (message.error) p.reject(new Error(String(message.error)));
          else p.resolve(message.result);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        if (worker === child) {
          worker = null;
          workerReady = null;
        }
        reject(new Error("Speech engine stopped"));
        for (const p of pending.values()) p.reject(new Error("Speech engine stopped"));
        pending.clear();
        if (recording) endRecording();
      });
    });
    workerReady.catch(() => {});
    return workerReady;
  }
  async function request<T>(message: Record<string, unknown>, timeout: number): Promise<T> {
    await ensureWorker();
    const id = ++requestId;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error("Speech recognition timed out"));
              // An overrunning engine is restarted rather than trusted.
              worker?.kill();
            }, timeout)
          : undefined;
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      worker!.postMessage({ ...message, id });
    });
  }
  function scheduleIdleExit() {
    clearTimeout(idleTimer);
    if (recording || download) return;
    idleTimer = setTimeout(() => {
      if (!recording && !download && !pending.size) {
        worker?.kill();
        worker = null;
        workerReady = null;
      }
    }, IDLE_EXIT_MS);
    idleTimer.unref?.();
  }
  async function selectedModel(): Promise<DictationModelId> {
    const value = await options.readModel().catch(() => undefined);
    return isDictationModelId(value) ? value : DICTATION_MODEL_IDS[0];
  }
  async function status(): Promise<DictationStatus> {
    return {
      models: DICTATION_MODEL_IDS.map((id) => {
        const model = DICTATION_MODELS[id];
        return {
          id,
          label: model.label,
          description: model.description,
          downloadBytes: model.archiveBytes,
          diskBytes: modelDiskBytes(model),
          installed: modelPresent(options.modelsDir, model),
          source: model.url,
          provenance: MODEL_PROVENANCE,
          license: MODEL_LICENSE,
          sha256: model.archiveSha256,
        };
      }),
      selected: await selectedModel(),
      download,
      engine: options.engine,
      engineError,
      recording: !!recording,
    };
  }
  async function emitStatus() {
    try {
      options.emit(await status());
    } catch {
      /* A later status request resynchronizes the window. */
    }
  }
  function endRecording() {
    if (!recording) return;
    clearTimeout(recording.timer);
    recording = null;
    scheduleIdleExit();
    void emitStatus();
  }

  return {
    status,
    async downloadModel(modelId: unknown) {
      if (!isDictationModelId(modelId)) throw new Error("Unknown dictation model");
      if (download && !["done", "failed"].includes(download.phase))
        throw new Error("A model download is already running");
      download = { modelId, phase: "downloading", received: 0, total: DICTATION_MODELS[modelId].archiveBytes };
      void emitStatus();
      // Runs in the background; progress and the outcome arrive as status events.
      void request(
        { type: "download", modelId, modelsDir: options.modelsDir },
        0,
      ).then(
        () => {
          download = { ...download!, phase: "done" };
        },
        (error: Error) => {
          download = { ...download!, phase: "failed", error: error.message };
        },
      ).finally(() => {
        scheduleIdleExit();
        void emitStatus();
      });
      return status();
    },
    async start() {
      // Only the owner window can start, and it records one terminal at a
      // time, so a new start supersedes a recording it lost track of (for
      // example after a reload); that recording's phrases are refused.
      if (recording) endRecording();
      const modelId = await selectedModel();
      if (options.engine !== "fixture" && !modelPresent(options.modelsDir, DICTATION_MODELS[modelId]))
        throw new Error("Download the English speech model in Voice dictation settings first");
      const id = crypto.randomBytes(12).toString("base64url");
      // Reserve the recording before loading so a second start is refused.
      recording = {
        id,
        modelId,
        sequence: 0,
        inFlight: 0,
        started: Date.now(),
        timer: setTimeout(() => endRecording(), MAX_RECORDING_MS + 60_000),
      };
      try {
        await request({ type: "load", modelId, modelsDir: options.modelsDir }, LOAD_TIMEOUT_MS);
        engineError = undefined;
      } catch (error) {
        endRecording();
        engineError = error instanceof Error ? error.message : String(error);
        void emitStatus();
        throw error;
      }
      void emitStatus();
      return { recordingId: id, modelId };
    },
    async phrase(value: unknown) {
      const phrase = validatePhrasePayload(value);
      if (!recording || recording.id !== phrase.recordingId)
        throw new Error("This dictation has ended");
      if (phrase.sequence <= recording.sequence)
        throw new Error("Dictation phrase is out of order");
      if (Date.now() - recording.started > MAX_RECORDING_MS + 60_000)
        throw new Error("Dictation reached its time limit");
      if (recording.inFlight >= MAX_PENDING_PHRASES)
        throw new Error("Speech recognition cannot keep up; dictation stopped");
      recording.sequence = phrase.sequence;
      const active = recording;
      active.inFlight++;
      try {
        const text = await request<string>({ type: "transcribe", pcm: phrase.samples }, PHRASE_TIMEOUT_MS);
        return { text: cleanTranscript(text) };
      } finally {
        active.inFlight--;
      }
    },
    async stop(recordingId: unknown) {
      if (recording && recording.id === recordingId) endRecording();
    },
    dispose() {
      clearTimeout(idleTimer);
      if (recording) clearTimeout(recording.timer);
      recording = null;
      worker?.kill();
      worker = null;
      workerReady = null;
    },
  };
}

export const defaultModelsDir = (userData: string) => path.join(userData, "models");
