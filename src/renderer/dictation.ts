/**
 * Renderer side of local dictation ("type as I talk"). Captures the
 * microphone, resamples to 16 kHz, cuts phrases at pauses and sends each
 * phrase's PCM to the desktop main process, which transcribes it locally.
 * Each phrase's text is typed into the terminal fixed at start, through the
 * terminal's paste path, without Enter. If that terminal is no longer the
 * attached one, dictation stops and the text is kept for copying instead.
 */
import { useSyncExternalStore } from "react";
import type { DictationStatus } from "../shared/contracts";
import {
  MAX_PENDING_PHRASES,
  MAX_RECORDING_MS,
  createResampler,
  createSegmenter,
  phraseInsertion,
  sameDestination,
  toInt16,
  type DictationDestination,
} from "../shared/dictation";

export interface DictationTarget extends DictationDestination {
  /** The terminal's current identity; null once its viewer detached. */
  current(): { sessionId: string; generation: number; viewerId: string | null } | null;
  /** Types text through the terminal's paste path; never adds Enter. */
  paste(text: string): void;
}
export interface DictationLeftover {
  id: number;
  text: string;
  reason: string;
}
export interface DictationState {
  phase: "idle" | "starting" | "listening" | "finishing";
  sessionId?: string;
  viewerId?: string;
  startedAt?: number;
  error?: string;
  leftovers: DictationLeftover[];
  status: DictationStatus | null;
  settingsOpen: boolean;
  settingsNotice?: string;
}

let state: DictationState = { phase: "idle", leftovers: [], status: null, settingsOpen: false };
const listeners = new Set<() => void>();
function set(patch: Partial<DictationState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
export const dictationAvailable = () => !!window.workspace?.dictation;
export function useDictation() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
export const dictationShortcutLabel = isMac ? "⌘⇧Space" : "Ctrl+Shift+Space";
/** Cmd+Shift+Space on macOS, Ctrl+Shift+Space elsewhere; nothing else is taken. */
export const isDictationShortcut = (event: KeyboardEvent | React.KeyboardEvent) =>
  event.code === "Space" &&
  event.shiftKey &&
  !event.altKey &&
  (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

let statusSubscribed = false;
export async function refreshDictationStatus() {
  const api = window.workspace.dictation;
  if (!api) return null;
  if (!statusSubscribed) {
    statusSubscribed = true;
    api.onStatus((status) => set({ status }));
  }
  const status = await api.status();
  set({ status });
  return status;
}
export const openDictationSettings = (notice?: string) => {
  set({ settingsOpen: true, settingsNotice: notice });
  void refreshDictationStatus().catch(() => {});
};
export const closeDictationSettings = () => set({ settingsOpen: false, settingsNotice: undefined });
let leftoverId = 0;
export const dismissLeftover = (id: number) =>
  set({ leftovers: state.leftovers.filter((item) => item.id !== id) });
export const clearDictationError = () => set({ error: undefined });

interface Microphone {
  close(): void;
}
/** Opens the microphone (audio only) and streams 16 kHz mono samples. */
async function openMicrophone(onSamples: (samples: Float32Array) => void): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  let context: AudioContext | null = null;
  const close = () => {
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => {});
    context = null;
    delete document.body.dataset.dictationMicrophone;
  };
  try {
    context = new AudioContext();
    const resample = createResampler(context.sampleRate);
    const source = context.createMediaStreamSource(stream);
    // A silent sink keeps the capture node in the rendered graph.
    const sink = context.createGain();
    sink.gain.value = 0;
    sink.connect(context.destination);
    let node: AudioNode;
    let kind = "worklet";
    try {
      await context.audioWorklet.addModule(new URL("dictation-worklet.js", document.baseURI).href);
      const worklet = new AudioWorkletNode(context, "dictation-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      worklet.port.onmessage = (event) => onSamples(resample(event.data as Float32Array));
      node = worklet;
    } catch {
      // Fallback for contexts where the worklet module cannot load.
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) =>
        onSamples(resample(new Float32Array(event.inputBuffer.getChannelData(0))));
      node = processor;
      kind = "script-processor";
    }
    source.connect(node);
    node.connect(sink);
    if (context.state === "suspended") await context.resume();
    // Marks live capture (and which capture path) for accessibility tooling and tests.
    document.body.dataset.dictationMicrophone = kind;
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}

/** The one active recording (dictation is one terminal at a time). */
type Recording = {
  target: DictationTarget;
  recordingId: string | null;
  microphone: Microphone | null;
  segmenter: ReturnType<typeof createSegmenter>;
  stopping: boolean;
  /** Set when the destination is gone; remaining text is kept, not typed. */
  lostReason: string | null;
  queue: Float32Array[];
  sequence: number;
  inserted: boolean;
  untyped: string[];
  running: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
};
let active: Recording | null = null;

/** Error text without Electron's "Error invoking remote method" wrapper. */
export const dictationErrorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
function microphoneError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was denied. Allow Agent Workspace to use the microphone in your system settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another application.";
  return dictationErrorText(error);
}

async function drain(recording: Recording) {
  const api = window.workspace.dictation!;
  while (recording.queue.length) {
    const samples = recording.queue.shift()!;
    if (!recording.recordingId) return;
    let text = "";
    try {
      const result = await api.phrase({
        recordingId: recording.recordingId,
        sequence: ++recording.sequence,
        pcm: toInt16(samples),
      });
      text = result.text;
    } catch (error) {
      set({ error: "Dictation stopped: " + dictationErrorText(error) });
      recording.queue.length = 0;
      void stopDictation();
      return;
    }
    if (!text) continue;
    const target = recording.target;
    if (!recording.lostReason && !sameDestination(target, target.current()))
      recording.lostReason = "The terminal changed before this text could be typed.";
    if (recording.lostReason) {
      recording.untyped.push(text);
      continue;
    }
    const insertion = phraseInsertion(text, recording.inserted);
    if (!insertion) continue;
    target.paste(insertion);
    recording.inserted = true;
  }
}
function enqueue(recording: Recording, phrases: Float32Array[]) {
  for (const phrase of phrases) {
    if (recording.queue.length >= MAX_PENDING_PHRASES) {
      set({ error: "Speech recognition cannot keep up; dictation stopped." });
      void stopDictation();
      return;
    }
    recording.queue.push(phrase);
  }
  if (recording.recordingId)
    recording.running = recording.running.then(() => drain(recording));
}

export async function startDictation(target: DictationTarget) {
  const api = window.workspace.dictation;
  if (!api) return;
  if (active) {
    // One terminal at a time: the shortcut or button on another terminal stops it.
    await stopDictation();
    return;
  }
  set({ error: undefined });
  let status = state.status;
  try {
    status = await refreshDictationStatus();
  } catch {
    /* start() below reports the problem. */
  }
  const model = status?.models.find((m) => m.id === status!.selected);
  if (status && status.engine !== "fixture" && !model?.installed) {
    openDictationSettings(
      "Dictation needs the English speech model on this computer. Download it once to start.",
    );
    return;
  }
  if (!sameDestination(target, target.current())) {
    set({ error: "Connect the terminal before dictating." });
    return;
  }
  const segmenter = createSegmenter();
  const recording: Recording = {
    target,
    recordingId: null,
    microphone: null,
    segmenter,
    stopping: false,
    lostReason: null,
    queue: [],
    sequence: 0,
    inserted: false,
    untyped: [],
    running: Promise.resolve(),
    timer: setTimeout(() => void stopDictation(), MAX_RECORDING_MS),
  };
  active = recording;
  set({ phase: "starting", sessionId: target.sessionId, viewerId: target.viewerId, startedAt: undefined });
  try {
    const [, started] = await Promise.all([
      openMicrophone((samples) => {
        if (active !== recording || recording.stopping) return;
        const phrases = segmenter.push(samples);
        if (phrases.length) enqueue(recording, phrases);
      }).then(
        (mic) => {
          // Stopped while the permission prompt was open: release at once.
          if (recording.stopping) mic.close();
          else recording.microphone = mic;
          return mic;
        },
      ),
      api.start(),
    ]);
    recording.recordingId = started.recordingId;
    if (recording.stopping) {
      void api.stop(started.recordingId).catch(() => {});
      return;
    }
    // Phrases captured while the model loaded.
    recording.running = recording.running.then(() => drain(recording));
    set({ phase: "listening", startedAt: Date.now() });
  } catch (error) {
    recording.microphone?.close();
    recording.microphone = null;
    clearTimeout(recording.timer);
    if (active === recording) active = null;
    if (!active)
      set({ phase: "idle", sessionId: undefined, viewerId: undefined, error: microphoneError(error) });
  }
}

/**
 * Stops listening at once (releasing the microphone), then finishes the
 * phrases already captured. `lostReason` marks the destination as gone, so
 * remaining text is shown for copying instead of typed.
 */
export async function stopDictation(lostReason?: string) {
  const recording = active;
  if (!recording) return;
  if (lostReason && !recording.lostReason) recording.lostReason = lostReason;
  if (recording.stopping) return recording.running;
  recording.stopping = true;
  clearTimeout(recording.timer);
  recording.microphone?.close();
  recording.microphone = null;
  const tail = recording.segmenter.flush();
  if (tail && recording.recordingId) {
    recording.queue.push(tail);
    recording.running = recording.running.then(() => drain(recording));
  }
  set({ phase: recording.recordingId ? "finishing" : "idle" });
  if (!recording.recordingId) {
    // Still starting: startDictation releases everything when it settles.
    active = null;
    set({ sessionId: undefined, viewerId: undefined });
    return;
  }
  await recording.running.catch(() => {});
  await window.workspace.dictation?.stop(recording.recordingId).catch(() => {});
  if (active === recording) active = null;
  const leftovers = recording.untyped.length
    ? [
        ...state.leftovers,
        {
          id: ++leftoverId,
          text: recording.untyped.join(" "),
          reason: recording.lostReason || "This text was not typed.",
        },
      ]
    : state.leftovers;
  set({ phase: "idle", sessionId: undefined, viewerId: undefined, startedAt: undefined, leftovers });
}

/** Called by a terminal view when its attached viewer goes away. */
export function dictationTargetLost(viewerId: string) {
  if (active && active.target.viewerId === viewerId)
    void stopDictation("The terminal was detached, ended or changed before this text could be typed.");
}
export const dictationActiveFor = (viewerId: string | null) =>
  !!viewerId && state.phase !== "idle" && state.viewerId === viewerId;

// Losing the window (blur, hide, minimize) stops listening. The starting phase
// is exempt because the system microphone prompt itself takes focus.
if (typeof window !== "undefined") {
  window.addEventListener("blur", () => {
    if (state.phase === "listening") void stopDictation();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && active) void stopDictation();
  });
}
