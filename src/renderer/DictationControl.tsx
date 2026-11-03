import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, Mic, Settings2, Square, X } from "lucide-react";
import {
  clearDictationError,
  dictationErrorText,
  closeDictationSettings,
  dictationShortcutLabel,
  dismissLeftover,
  isDictationShortcut,
  openDictationSettings,
  refreshDictationStatus,
  useDictation,
} from "./dictation";

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000) + " MB";
const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * Microphone control beside a terminal's input (desktop owner only). While that
 * terminal receives dictation it becomes the recording indicator: pulsing
 * dot, elapsed time and Stop. It never covers terminal text.
 */
export function DictationButton({
  viewerId,
  onToggle,
  compact = false,
}: {
  viewerId: string | null;
  onToggle: () => void;
  compact?: boolean;
}) {
  const state = useDictation();
  const on =
    state.phase !== "idle" && !!viewerId && state.viewerId === viewerId;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [on]);
  if (!on)
    return (
      <button
        className="button small dictation-toggle"
        title={`Dictate into this terminal: words are typed as you pause, never submitted (${dictationShortcutLabel})`}
        aria-label="Voice typing"
        aria-pressed={false}
        disabled={!viewerId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggle}
      >
        <Mic size={15} />
        Voice typing
      </button>
    );
  const label =
    state.phase === "starting"
      ? "Starting…"
      : state.phase === "finishing"
        ? "Finishing…"
        : "Listening";
  return (
    <span
      className={"dictation-indicator" + (compact ? " compact" : "")}
      role="status"
      aria-live="polite"
      data-phase={state.phase}
      title={`Typed into this terminal as you pause; press Enter yourself (${dictationShortcutLabel} stops)`}
    >
      <span className="dictation-dot" aria-hidden="true" />
      {state.phase === "listening" && state.startedAt ? (
        <>
          <span className={compact ? "sr-only" : "dictation-label"}>
            {label}
          </span>
          <span className="dictation-time">{clock(now - state.startedAt)}</span>
        </>
      ) : compact ? (
        <span className="sr-only">{label}</span>
      ) : (
        <span className="dictation-label">{label}</span>
      )}
      <button
        className="dictation-stop"
        aria-label="Stop dictation"
        aria-pressed={true}
        disabled={state.phase === "finishing"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggle}
      >
        <Square size={9} />
        Stop
      </button>
    </span>
  );
}

/** Kept below the terminal so voice input is discoverable beside the prompt. */
export function DictationToolbar({
  viewerId,
  onToggle,
  compact = false,
}: {
  viewerId: string | null;
  onToggle: () => void;
  compact?: boolean;
}) {
  const state = useDictation();
  return (
    <div
      className={
        "terminal-voice-bar nodrag nowheel" + (compact ? " compact" : "")
      }
      role="group"
      aria-label="Voice typing controls"
    >
      <DictationButton
        viewerId={viewerId}
        onToggle={onToggle}
        compact={compact}
      />
      <span className="terminal-voice-help">
        {viewerId
          ? compact
            ? "Press Enter to send"
            : "Speak to type here. Press Enter to send."
          : "Connecting terminal…"}
      </span>
      <kbd className="terminal-voice-shortcut">{dictationShortcutLabel}</kbd>
      <button
        className="icon-button"
        aria-label="Voice typing settings"
        title="Speech model and microphone settings"
        disabled={state.phase !== "idle"}
        onClick={() => openDictationSettings()}
      >
        <Settings2 size={15} />
      </button>
    </div>
  );
}

/** App-level notices: untyped text after a destination change, and errors. */
export function DictationNotices() {
  const state = useDictation();
  if (!state.leftovers.length && !state.error) return null;
  return createPortal(
    <div className="dictation-notices">
      {state.error ? (
        <div className="dictation-notice" role="alert">
          <div>
            <strong>Dictation</strong>
            <p>{state.error}</p>
          </div>
          <button
            className="icon-button"
            aria-label="Dismiss dictation message"
            onClick={clearDictationError}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
      {state.leftovers.map((item) => (
        <div className="dictation-notice" role="status" key={item.id}>
          <div>
            <strong>Dictated text not typed</strong>
            <p className="muted">{item.reason}</p>
            <blockquote className="dictation-leftover">{item.text}</blockquote>
          </div>
          <div className="dictation-notice-actions">
            <button
              className="button ghost small"
              onClick={() =>
                void navigator.clipboard?.writeText(item.text).catch(() => {})
              }
            >
              <Copy size={12} />
              Copy
            </button>
            <button
              className="icon-button"
              aria-label="Dismiss untyped text"
              onClick={() => dismissLeftover(item.id)}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Voice dictation settings: model choice, consented download, privacy. */
export function DictationSettings() {
  const state = useDictation();
  const [micTest, setMicTest] = useState("");
  const [micTesting, setMicTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const micCleanup = useRef<(() => void) | null>(null);
  const micTicket = useRef(0);
  const stopMic = () => {
    micTicket.current++;
    micCleanup.current?.();
    micCleanup.current = null;
    setLevel(0);
    setMicTesting(false);
  };
  useEffect(() => {
    if (!state.settingsOpen) stopMic();
    return () => {
      micTicket.current++;
      micCleanup.current?.();
      micCleanup.current = null;
    };
  }, [state.settingsOpen]);
  async function testMic() {
    stopMic();
    const ticket = micTicket.current;
    setMicTesting(true);
    setMicTest("Requesting microphone access…");
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (ticket !== micTicket.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const meter = ctx.createAnalyser();
      source.connect(meter);
      meter.fftSize = 256;
      const data = new Uint8Array(meter.fftSize);
      let frame = 0;
      const read = () => {
        meter.getByteTimeDomainData(data);
        const volume = Math.min(
          100,
          Math.round(
            Math.sqrt(
              data.reduce((sum, x) => sum + ((x - 128) / 128) ** 2, 0) /
                data.length,
            ) * 400,
          ),
        );
        setLevel(volume);
        frame = requestAnimationFrame(read);
      };
      const timer = setTimeout(() => {
        stopMic();
        setMicTest("Microphone test finished. No audio was saved or sent.");
      }, 10000);
      micCleanup.current = () => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        stream!.getTracks().forEach((t) => t.stop());
        void ctx.close();
      };
      setMicTest(
        "Listening for 10 seconds. Speak and watch the input level; no text is inserted.",
      );
      read();
    } catch {
      stream?.getTracks().forEach((t) => t.stop());
      if (ticket === micTicket.current) {
        setMicTesting(false);
        setMicTest(
          "Microphone unavailable. Check system microphone permission and your input device, then try again.",
        );
      }
    }
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (state.settingsOpen)
      void refreshDictationStatus().catch((e) =>
        setError(dictationErrorText(e)),
      );
  }, [state.settingsOpen]);
  if (!state.settingsOpen) return null;
  const status = state.status;
  const selected = status?.models.find((m) => m.id === status.selected);
  const download = status?.download;
  const downloading =
    !!download && !["done", "failed"].includes(download.phase);
  const choose = async (modelId: string) => {
    setError("");
    try {
      await window.workspace.invoke("settings.write", {
        key: "dictationModel",
        value: modelId,
      });
      await refreshDictationStatus();
    } catch (e) {
      setError(dictationErrorText(e));
    }
  };
  const fetchModel = async () => {
    if (!selected || !window.workspace.dictation) return;
    setBusy(true);
    setError("");
    try {
      await window.workspace.dictation.downloadModel(selected.id);
      await refreshDictationStatus();
    } catch (e) {
      setError(dictationErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const percent =
    download && download.total
      ? Math.min(100, Math.round((download.received / download.total) * 100))
      : 0;
  return createPortal(
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          closeDictationSettings();
        }
        // Space on a focused button would otherwise activate it behind this chord.
        if (isDictationShortcut(e)) e.preventDefault();
      }}
    >
      <section
        className="modal dictation-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dictation-title"
      >
        <header>
          <div>
            <div className="eyebrow">This computer</div>
            <h2 id="dictation-title">Voice dictation</h2>
          </div>
          <button
            className="icon-button"
            onClick={closeDictationSettings}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>
        {state.settingsNotice && !selected?.installed ? (
          <p className="dictation-callout">{state.settingsNotice}</p>
        ) : null}
        <p className="muted">
          Open a running Claude, Codex or shell session from the sidebar, then
          click <strong>Voice typing</strong> below its terminal. You can also
          press <kbd>{dictationShortcutLabel}</kbd> in the terminal. Speak
          English; each phrase is typed when you pause. Press Enter yourself to
          send.
        </p>
        <p className="muted">
          Audio stays in memory on this computer and is transcribed here; it is
          never saved or uploaded. After you press Enter, the agent's CLI may
          send the text to its provider.
        </p>
        <section className="setup-guide">
          <strong>
            {selected?.installed
              ? "Speech model ready · English"
              : "Download a speech model to begin"}
          </strong>
          <p>
            This is only a microphone test. To type into your AI, close settings
            and use Voice typing below the terminal.
          </p>
          <button
            className="button"
            disabled={state.phase !== "idle" || micTesting}
            onClick={() => void testMic()}
          >
            Test microphone
          </button>
          {micTest ? (
            <div role="status">
              <p>{micTest}</p>
              {micTesting ? (
                <>
                  <meter
                    aria-label="Microphone input level"
                    min={0}
                    max={100}
                    value={level}
                  />
                  <button
                    className="button small"
                    onClick={() => {
                      stopMic();
                      setMicTest("Microphone test stopped.");
                    }}
                  >
                    Stop test
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
        <fieldset className="dictation-models" disabled={downloading}>
          <legend>English speech model</legend>
          {status?.models.map((model) => (
            <label key={model.id} className="dictation-model">
              <input
                type="radio"
                name="dictation-model"
                checked={status.selected === model.id}
                onChange={() => void choose(model.id)}
              />
              <span>
                <strong>
                  {model.label}
                  {model.installed ? (
                    <span className="dictation-installed">Downloaded</span>
                  ) : null}
                </strong>
                <span className="muted">
                  {model.description} Download {megabytes(model.downloadBytes)},{" "}
                  {megabytes(model.diskBytes)} on disk.
                </span>
              </span>
            </label>
          )) ?? <p className="muted">Loading…</p>}
        </fieldset>
        {selected && !selected.installed ? (
          <div className="dictation-consent">
            <p className="muted">
              The model is not bundled. Downloading fetches{" "}
              {megabytes(selected.downloadBytes)} from{" "}
              <code>{selected.source}</code>, checks it against a pinned SHA-256
              and keeps only the files speech recognition needs in this app's
              data folder.
            </p>
            <p className="muted">
              {selected.provenance} License: {selected.license}.
            </p>
            <button
              className="button primary"
              disabled={busy || downloading}
              onClick={() => void fetchModel()}
            >
              <Download size={14} />
              Download English speech model (~
              {megabytes(selected.downloadBytes)})
            </button>
          </div>
        ) : selected ? (
          <details className="dictation-ready">
            <summary>Model source and licenses</summary>
            <p>
              {selected.provenance} License: {selected.license}.
            </p>
          </details>
        ) : null}
        {download &&
        download.modelId === selected?.id &&
        download.phase !== "done" ? (
          <div className="dictation-progress" role="status">
            {download.phase === "failed" ? (
              <span className="inline-error">
                {download.error || "The download failed."}
              </span>
            ) : (
              <>
                <span>
                  {download.phase === "downloading"
                    ? `Downloading… ${megabytes(download.received)} of ${megabytes(download.total)}`
                    : download.phase === "verifying"
                      ? "Checking the download…"
                      : `Unpacking… ${megabytes(download.received)}`}
                </span>
                <progress
                  max={100}
                  value={download.phase === "downloading" ? percent : undefined}
                  aria-label="Model download progress"
                />
              </>
            )}
          </div>
        ) : null}
        {status?.engineError ? (
          <div className="inline-error">{status.engineError}</div>
        ) : null}
        {error ? <div className="inline-error">{error}</div> : null}
        <footer>
          <button className="button ghost" onClick={closeDictationSettings}>
            Close
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
