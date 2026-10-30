/**
 * Local voice dictation helpers shared by the renderer (capture and
 * segmentation), the desktop main process (payload bounds) and the core
 * (setting validation). Nothing here touches audio devices, files or the
 * network, so all of it runs under node:test with synthetic PCM.
 */
import { sanitizePasteText } from "./terminal-paste.js";

/** Whisper models take 16 kHz mono audio. */
export const DICTATION_SAMPLE_RATE = 16000;
/** English-only Whisper models offered for download; the first is the default. */
export const DICTATION_MODEL_IDS = ["base.en", "tiny.en"] as const;
export type DictationModelId = (typeof DICTATION_MODEL_IDS)[number];
export const isDictationModelId = (value: unknown): value is DictationModelId =>
  typeof value === "string" &&
  (DICTATION_MODEL_IDS as readonly string[]).includes(value);

/** A phrase ends after this much silence. */
export const PHRASE_SILENCE_MS = 700;
/** Continuous speech is cut into phrases of at most this length. */
export const PHRASE_CAP_MS = 15000;
/** Hard bound on one phrase's PCM across IPC (Int16, 16 kHz): 30 s, 960 KB. */
export const MAX_PHRASE_SAMPLES = DICTATION_SAMPLE_RATE * 30;
/** Phrases waiting for transcription before dictation stops as too far behind. */
export const MAX_PENDING_PHRASES = 4;
/** One recording may last at most this long. */
export const MAX_RECORDING_MS = 30 * 60 * 1000;

/**
 * Streaming resampler from the capture rate to 16 kHz mono. Downsampling
 * averages the input over each output step (a box low-pass filter that keeps
 * speech intelligible and suppresses aliasing) and keeps its fractional
 * position between chunks, so chunk boundaries never click or drift.
 */
export function createResampler(inputRate: number, outputRate = DICTATION_SAMPLE_RATE) {
  if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 384000)
    throw new Error("Unsupported capture sample rate");
  const step = inputRate / outputRate;
  // Absolute input position (in input samples) of the next output sample,
  // relative to the start of `carry`.
  let position = 0;
  let carry = new Float32Array(0);
  return (chunk: Float32Array): Float32Array => {
    if (step === 1) return Float32Array.from(chunk);
    const input = new Float32Array(carry.length + chunk.length);
    input.set(carry);
    input.set(chunk, carry.length);
    const out: number[] = [];
    if (step <= 1) {
      // Upsampling: linear interpolation.
      while (position + 1 < input.length) {
        const i = Math.floor(position);
        const frac = position - i;
        out.push(input[i] * (1 - frac) + input[i + 1] * frac);
        position += step;
      }
    } else {
      while (position + step <= input.length) {
        const start = position;
        const end = position + step;
        let sum = 0;
        let weight = 0;
        for (let i = Math.floor(start); i < Math.ceil(end); i++) {
          const w = Math.min(end, i + 1) - Math.max(start, i);
          if (w <= 0) continue;
          sum += input[i] * w;
          weight += w;
        }
        out.push(weight ? sum / weight : 0);
        position = end;
      }
    }
    const consumed = Math.floor(position);
    carry = input.slice(consumed);
    position -= consumed;
    return Float32Array.from(out);
  };
}

export interface SegmenterOptions {
  sampleRate?: number;
  silenceMs?: number;
  capMs?: number;
  /** Phrases with less detected speech than this are dropped as noise. */
  minSpeechMs?: number;
  /** Audio kept from just before speech starts, so first syllables survive. */
  preRollMs?: number;
  /** Lowest RMS level that can count as speech. */
  minLevel?: number;
}

/**
 * Energy-based voice activity segmentation over 20 ms frames. A phrase starts
 * after two consecutive loud frames, ends after `silenceMs` of quiet, and is
 * cut at `capMs` while speech continues. The quiet threshold follows a slowly
 * adapting noise floor so steady fan or room noise does not count as speech.
 */
export function createSegmenter(options: SegmenterOptions = {}) {
  const rate = options.sampleRate ?? DICTATION_SAMPLE_RATE;
  const frame = Math.round(rate * 0.02);
  const silenceFrames = Math.ceil((options.silenceMs ?? PHRASE_SILENCE_MS) / 20);
  const capSamples = Math.round(((options.capMs ?? PHRASE_CAP_MS) * rate) / 1000);
  const minSpeechFrames = Math.ceil((options.minSpeechMs ?? 200) / 20);
  const preRollFrames = Math.ceil((options.preRollMs ?? 300) / 20);
  const minLevel = options.minLevel ?? 0.01;
  let noise = minLevel / 3;
  let pendingFrame = new Float32Array(0);
  const preRoll: Float32Array[] = [];
  let phrase: Float32Array[] = [];
  let phraseSamples = 0;
  let speechFrames = 0;
  let quietRun = 0;
  let loudRun = 0;
  let inPhrase = false;
  const finish = (): Float32Array | null => {
    // Keep at most 200 ms of the trailing silence.
    const keepQuiet = Math.min(quietRun, 10);
    const frames = phrase.slice(0, phrase.length - (quietRun - keepQuiet));
    const enough = speechFrames >= minSpeechFrames;
    phrase = [];
    phraseSamples = 0;
    speechFrames = 0;
    quietRun = 0;
    inPhrase = false;
    if (!enough || !frames.length) return null;
    const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
    let offset = 0;
    for (const f of frames) {
      out.set(f, offset);
      offset += f.length;
    }
    return out;
  };
  const level = (f: Float32Array) => {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    return Math.sqrt(sum / f.length);
  };
  const threshold = () => Math.max(minLevel, noise * 3);
  return {
    /** Feeds 16 kHz samples; returns every phrase completed by them. */
    push(samples: Float32Array): Float32Array[] {
      const done: Float32Array[] = [];
      const input = new Float32Array(pendingFrame.length + samples.length);
      input.set(pendingFrame);
      input.set(samples, pendingFrame.length);
      let offset = 0;
      for (; offset + frame <= input.length; offset += frame) {
        const f = input.slice(offset, offset + frame);
        const rms = level(f);
        const loud = rms > threshold();
        if (!loud) noise = noise * 0.95 + Math.min(rms, minLevel) * 0.05;
        if (!inPhrase) {
          preRoll.push(f);
          if (preRoll.length > preRollFrames) preRoll.shift();
          loudRun = loud ? loudRun + 1 : 0;
          if (loudRun >= 2) {
            inPhrase = true;
            phrase = preRoll.splice(0);
            phraseSamples = phrase.reduce((n, p) => n + p.length, 0);
            speechFrames = loudRun;
            quietRun = 0;
            loudRun = 0;
          }
          continue;
        }
        phrase.push(f);
        phraseSamples += f.length;
        if (loud) {
          speechFrames++;
          quietRun = 0;
        } else quietRun++;
        if (quietRun >= silenceFrames) {
          const out = finish();
          if (out) done.push(out);
        } else if (phraseSamples >= capSamples) {
          // Still speaking at the cap: emit and keep listening as a new phrase.
          const out = finish();
          if (out) done.push(out);
          if (loud) {
            inPhrase = true;
            speechFrames = 0;
          }
        }
      }
      pendingFrame = input.slice(offset);
      return done;
    },
    /** Ends the current phrase, if it holds enough speech (used on Stop). */
    flush(): Float32Array | null {
      pendingFrame = new Float32Array(0);
      preRoll.length = 0;
      loudRun = 0;
      return inPhrase ? finish() : null;
    },
  };
}

/** Float samples in [-1, 1] to 16-bit PCM for the bounded IPC payload. */
export function toInt16(samples: Float32Array) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}
export function fromInt16(samples: Int16Array) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 0x8000;
  return out;
}

// Whisper emits bracketed or parenthesized annotations for non-speech audio,
// e.g. "[BLANK_AUDIO]", "(music)", "[Music]", "*laughs*", and music notes.
const NON_SPEECH =
  /\[[^\]]{0,40}\]|\([^)]{0,40}\)|\*[^*]{0,40}\*|[♪♫♬]+|>>/gu;
/**
 * One transcribed phrase as plain single-line terminal text: non-speech
 * annotations dropped, control characters removed, CR/LF/tab flattened to
 * spaces and whitespace collapsed. The result never contains a control byte.
 */
export function cleanTranscript(text: unknown) {
  if (typeof text !== "string") return "";
  const stripped = text.slice(0, 4000).replace(NON_SPEECH, " ");
  return sanitizePasteText(stripped).replace(/\s+/g, " ").trim();
}

/** Text to type for the next phrase: one space between phrases, never Enter. */
export function phraseInsertion(text: string, previouslyInserted: boolean) {
  const clean = cleanTranscript(text);
  if (!clean) return "";
  return (previouslyInserted ? " " : "") + clean;
}

/** Where dictated text goes; fixed when recording starts. */
export interface DictationDestination {
  sessionId: string;
  generation: number;
  viewerId: string;
}
/** True only while the exact same terminal view is still attached. */
export function sameDestination(
  fixed: DictationDestination,
  current: { sessionId: string; generation: number; viewerId: string | null } | null,
) {
  return (
    !!current &&
    current.viewerId !== null &&
    fixed.sessionId === current.sessionId &&
    fixed.generation === current.generation &&
    fixed.viewerId === current.viewerId
  );
}

/**
 * Validates one `phrase` IPC payload: an owner-issued recording ID, an
 * increasing sequence number and bounded 16-bit PCM. Returns the samples.
 */
export function validatePhrasePayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid dictation phrase");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["recordingId", "sequence", "pcm"].includes(k)))
    throw new Error("Invalid dictation phrase");
  if (typeof v.recordingId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(v.recordingId))
    throw new Error("Invalid dictation recording");
  if (!Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1)
    throw new Error("Invalid dictation phrase sequence");
  const pcm = v.pcm;
  if (!(pcm instanceof Int16Array) && !(pcm instanceof Uint8Array))
    throw new Error("Dictation audio must be 16-bit PCM");
  if (pcm.byteLength % 2 || pcm.byteLength === 0)
    throw new Error("Dictation audio must be 16-bit PCM");
  if (pcm.byteLength > MAX_PHRASE_SAMPLES * 2)
    throw new Error("Dictation phrase is longer than 30 seconds");
  const samples =
    pcm instanceof Int16Array
      ? pcm
      : new Int16Array(
          pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
        );
  return {
    recordingId: v.recordingId,
    sequence: v.sequence as number,
    samples,
  };
}
