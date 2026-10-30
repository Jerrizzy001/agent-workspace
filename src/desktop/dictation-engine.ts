/**
 * Speech-to-text engines for the dictation worker process. The real engine is
 * sherpa-onnx (Apache-2.0, prebuilt N-API addon with ONNX Runtime) running an
 * English Whisper model on the CPU. A fixture engine exists only for tests and
 * is selected by an explicit test environment variable.
 */
import { createRequire } from "node:module";
import { DICTATION_SAMPLE_RATE } from "../shared/dictation.js";

export interface Transcriber {
  transcribe(samples: Float32Array): Promise<string>;
  close(): void;
}

export function createSherpaTranscriber(files: {
  encoder: string;
  decoder: string;
  tokens: string;
}): Transcriber {
  const require = createRequire(import.meta.url);
  const sherpa = require("sherpa-onnx-node");
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: DICTATION_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: files.encoder,
        decoder: files.decoder,
        language: "en",
        task: "transcribe",
        tailPaddings: -1,
      },
      tokens: files.tokens,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
  });
  return {
    async transcribe(samples) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: DICTATION_SAMPLE_RATE, samples });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      return typeof result?.text === "string" ? result.text : "";
    },
    close() {
      /* The addon frees the recognizer with the process. */
    },
  };
}

/**
 * Test-only: returns `|`-separated phrases from WORKSPACE_TEST_DICTATION_TEXT
 * in order (cycling), ignoring the audio except for its presence.
 */
export function createFixtureTranscriber(text: string): Transcriber {
  const phrases = text.split("|");
  let next = 0;
  return {
    async transcribe(samples) {
      if (!samples.length) return "";
      return phrases[next++ % phrases.length];
    },
    close() {},
  };
}
