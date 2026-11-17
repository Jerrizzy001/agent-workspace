import { terminalInputChunk } from "../shared/terminal-paste";
import { createId } from "./id";
import { useEffect, useId, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ClipboardImagePreview, Session } from "../shared/contracts";
import { shellEscapePath } from "../shared/terminal-paste";
import { ImagePastePreview } from "./ImagePastePreview";
import { focusOutside, returnModalFocusTo } from "./modal-accessibility";
import { providerName, sessionLocation } from "./sessions";
import {
  getAppearance,
  subscribeAppearance,
  terminalThemes,
} from "./appearance";
import {
  dictationActiveFor,
  dictationAvailable,
  dictationTargetLost,
  isDictationShortcut,
  startDictation,
  stopDictation,
} from "./dictation";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({
  session,
  onViewer,
  endedNotice = true,
  imagePasteRequest = 0,
  dictationToggle = 0,
  handoffPaste,
  onHandoffInserted,
  label,
}: {
  session: Session;
  /** Accessible session name; defaults to the session title or provider. */
  label?: string;
  onViewer?: (id: string | null) => void;
  /** Hosts that explain an ended session themselves turn the built-in notice off. */
  endedNotice?: boolean;
  /** Incremented by the host's "Paste image" action (desktop owner only). */
  imagePasteRequest?: number;
  /** Incremented by the host's microphone button (desktop owner only). */
  dictationToggle?: number;
  handoffPaste?: { request: number; text: string };
  onHandoffInserted?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const hintId = useId();
  // Each terminal is named after its session so screen-reader users can tell
  // several of them apart (xterm's default is "Terminal input" for all).
  const accessibleName = `${label || session.title || providerName(session.provider)} terminal, ${sessionLocation(session)}`;
  const accessibleNameRef = useRef(accessibleName);
  accessibleNameRef.current = accessibleName;
  useEffect(() => {
    terminalRef.current?.textarea?.setAttribute("aria-label", accessibleName);
  }, [accessibleName]);
  useEffect(
    () =>
      subscribeAppearance(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        const { resolved } = getAppearance();
        terminal.options.theme = terminalThemes[resolved];
        terminal.options.minimumContrastRatio = resolved === "light" ? 4.5 : 1;
      }),
    [],
  );
  // The attached viewer, or null; image paste rechecks it before typing.
  const viewerRef = useRef<string | null>(null);
  const onViewerRef = useRef(onViewer);
  onViewerRef.current = onViewer;
  const viewerCallback = useRef((id: string | null) => {
    const previous = viewerRef.current;
    viewerRef.current = id;
    // Dictation is bound to one attached viewer; any change ends it.
    if (previous && previous !== id) dictationTargetLost(previous);
    onViewerRef.current?.(id);
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const toggleDictation = useRef(() => {});
  toggleDictation.current = () => {
    if (!dictationAvailable()) return;
    // A click or keyboard activation should leave Enter directed to the prompt.
    terminalRef.current?.focus();
    const viewer = viewerRef.current;
    if (dictationActiveFor(viewer)) {
      void stopDictation();
      return;
    }
    if (!viewer || !terminalRef.current) return;
    // The destination is fixed now: this session, generation and viewer.
    const fixed = {
      sessionId: session.id,
      generation: session.generation,
      viewerId: viewer,
    };
    void startDictation({
      ...fixed,
      current: () =>
        terminalRef.current && viewerRef.current
          ? {
              sessionId: sessionRef.current.id,
              generation: sessionRef.current.generation,
              viewerId: viewerRef.current,
            }
          : null,
      paste: (text) => {
        // Bracketed-paste aware, no Enter: text only reaches the prompt.
        if (viewerRef.current === fixed.viewerId)
          terminalRef.current?.paste(text);
      },
    });
  };
  useEffect(() => {
    if (dictationToggle) toggleDictation.current();
  }, [dictationToggle]);
  const [imagePaste, setImagePaste] = useState<{
    preview: ClipboardImagePreview;
    viewerId: string;
  } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState("");
  const [imageNotice, setImageNotice] = useState("");
  useEffect(() => {
    if (!handoffPaste) return;
    if (
      !viewerRef.current ||
      !terminalRef.current ||
      sessionRef.current.status !== "running"
    ) {
      setImageNotice(
        "The terminal disconnected. Reconnect and insert the instructions again; nothing was queued.",
      );
      return;
    }
    terminalRef.current.paste(handoffPaste.text);
    terminalRef.current.focus();
    onHandoffInserted?.();
    // An explicit button press inserts once; reconnects never replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffPaste?.request]);
  const startImagePaste = useRef(async () => {});
  startImagePaste.current = async () => {
    const api = window.workspace.clipboardImage;
    const viewerId = viewerRef.current;
    if (!api || imageBusy || imagePaste) return;
    setImageNotice("");
    if (!viewerId) {
      setImageNotice("Connect the terminal before pasting an image.");
      return;
    }
    setImageBusy(true);
    try {
      const preview = await api.preview();
      if (!preview) setImageNotice("The clipboard has no image to paste.");
      else if (viewerRef.current !== viewerId) {
        void api.discard(preview.token).catch(() => {});
        setImageNotice("The terminal reconnected. Paste the image again.");
      } else {
        setImageError("");
        setImagePaste({ preview, viewerId });
      }
    } catch (error) {
      setImageNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setImageBusy(false);
    }
  };
  // The preview dialog keeps the terminal inert until it unmounts; tell the
  // dialog helper to hand focus to the terminal instead of the opener button.
  const focusAfterDialog = () =>
    returnModalFocusTo(terminalRef.current?.textarea);
  const closeImagePaste = () => {
    if (imagePaste)
      void window.workspace.clipboardImage
        ?.discard(imagePaste.preview.token)
        .catch(() => {});
    focusAfterDialog();
    setImagePaste(null);
    setImageError("");
  };
  const confirmImagePaste = async () => {
    const api = window.workspace.clipboardImage;
    if (!api || !imagePaste) return;
    const { preview, viewerId } = imagePaste;
    // The same session, generation and attached viewer must still be on screen.
    const current = () =>
      viewerRef.current === viewerId && !!terminalRef.current;
    if (!current()) {
      setImageError(
        "The terminal reconnected. Cancel and paste the image again.",
      );
      return;
    }
    setImageBusy(true);
    try {
      const saved = await api.save({
        token: preview.token,
        sessionId: session.id,
        generation: session.generation,
      });
      if (!current())
        throw new Error(
          `The terminal disconnected; nothing was typed. The image was saved at ${saved.path}`,
        );
      // Bracketed paste of one escaped path, no Enter: nothing is submitted.
      terminalRef.current!.paste(shellEscapePath(saved.path));
      focusAfterDialog();
      setImagePaste(null);
      setImageError("");
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageBusy(false);
    }
  };
  useEffect(() => {
    if (imagePasteRequest) void startImagePaste.current();
  }, [imagePasteRequest]);
  const terminalRef = useRef<Terminal | null>(null);
  const sendRef = useRef<(data: string) => void>(() => {});
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [manualRetry, setManualRetry] = useState(0);
  const status = useRef(session.status);
  status.current = session.status;
  const [ready, setReady] = useState(false);
  const finalCapture = useRef(() => {});
  useEffect(() => {
    if (session.status === "exited") finalCapture.current();
  }, [session.status, session.transcript]);
  useEffect(
    () =>
      window.workspace.subscribe((event) => {
        if (event.type === "core.status" && event.status === "ready")
          setEpoch((value) => value + 1);
      }),
    [],
  );
  useEffect(() => {
    if (!host.current) return;
    setReady(false);
    setError("");
    let disposed = false;
    let ended = false;
    let finalLoading = false;
    let finalLoaded = false;
    let attached = false;
    let resyncing = false;
    let streamEpoch = 0;
    let inputBuffer = "";
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    let inputInFlight = false;
    let acknowledged = 0;
    let ackSequence = 0;
    let ackInFlight = false;
    const clearInput = () => {
      clearTimeout(inputTimer);
      inputTimer = undefined;
      inputBuffer = "";
    };
    const pending: { data: string; sequence: number }[] = [];
    const viewerId = createId();
    const identity = {
      sessionId: session.id,
      generation: session.generation,
      viewerId,
    };
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      fontSize: 13,
      fontFamily:
        '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
      lineHeight: 1.4,
      scrollback: 5000,
      theme: terminalThemes[getAppearance().resolved],
      minimumContrastRatio: getAppearance().resolved === "light" ? 4.5 : 1,
      // Mirrors output into a live region so VoiceOver can read agent output.
      screenReaderMode: true,
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const element = host.current;
    terminal.open(element);
    terminal.textarea?.setAttribute("aria-describedby", hintId);
    terminal.textarea?.setAttribute("aria-label", accessibleNameRef.current);
    // In screen-reader mode xterm ignores text that arrives without key events
    // (macOS dictation, the emoji picker, text replacement). Forward it here;
    // keyed text is still handled by xterm itself, so nothing is sent twice.
    let keyed = false;
    // Only a keydown that types a character suppresses forwarding, and only
    // briefly: macOS drops keyup for chords held with Cmd and after focus
    // leaves, so the flag must never depend on keyup alone.
    let keyedTimer: ReturnType<typeof setTimeout> | undefined;
    const clearKeyed = () => {
      clearTimeout(keyedTimer);
      keyed = false;
    };
    const onTextKeyDown = (event: KeyboardEvent) => {
      clearKeyed();
      if (event.metaKey || event.ctrlKey || event.key.length !== 1) return;
      keyed = true;
      keyedTimer = setTimeout(clearKeyed, 250);
    };
    const onTextKeyUp = clearKeyed;
    const onTextInput = (event: Event) => {
      const e = event as InputEvent;
      if (keyed || e.isComposing || e.inputType !== "insertText" || !e.data)
        return;
      terminal.input(e.data, true);
      if (terminal.textarea) terminal.textarea.value = "";
    };
    terminal.textarea?.addEventListener("keydown", onTextKeyDown, true);
    terminal.textarea?.addEventListener("keyup", onTextKeyUp, true);
    terminal.textarea?.addEventListener("input", onTextInput);
    terminal.textarea?.addEventListener("blur", clearKeyed);
    // Two key combinations are taken from the terminal: F6 / Shift+F6, which
    // move focus out because the shell keeps Tab, and the dictation shortcut.
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.key === "F6" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        if (event.type === "keydown") focusOutside(element, event.shiftKey);
        return false;
      }
      if (!dictationAvailable() || !isDictationShortcut(event)) return true;
      event.preventDefault();
      if (event.type === "keydown" && !event.repeat) toggleDictation.current();
      return false;
    });
    // A paste that carries only an image becomes the image-path flow; text
    // pastes are left to the terminal untouched.
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (
        !window.workspace.clipboardImage ||
        !data ||
        data.getData("text/plain")
      )
        return;
      if (
        !Array.from(data.items).some(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        )
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void startImagePaste.current();
    };
    element.addEventListener("paste", onPaste, true);
    const fail = (e: unknown) => {
      if (!disposed && !ended && sessionRef.current.status !== "exited") {
        clearInput();
        attached = false;
        viewerCallback.current?.(null);
        setError(String(e));
        setReady(false);
        terminal.options.disableStdin = true;
      }
    };
    const flushAck = () => {
      if (disposed || !attached || ackInFlight || ackSequence <= acknowledged)
        return;
      const sequence = ackSequence;
      const writtenEpoch = streamEpoch;
      ackInFlight = true;
      void window.workspace
        .invoke("session.ack", { ...identity, sequence })
        .then(() => {
          if (writtenEpoch === streamEpoch) acknowledged = sequence;
        })
        .catch((error) => {
          if (writtenEpoch === streamEpoch) fail(error);
        })
        .finally(() => {
          if (writtenEpoch !== streamEpoch) return;
          ackInFlight = false;
          flushAck();
        });
    };
    const write = (data: string, sequence: number) => {
      const writtenEpoch = streamEpoch;
      terminal.write(data, () => {
        if (!disposed && writtenEpoch === streamEpoch) {
          ackSequence = Math.max(ackSequence, sequence);
          flushAck();
        }
      });
    };
    const resize = () => {
      if (!attached || !host.current?.clientWidth || !host.current.clientHeight)
        return;
      fit.fit();
      void window.workspace
        .invoke("session.resize", {
          ...identity,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(fail);
    };
    const attach = async () => {
      streamEpoch++;
      acknowledged = 0;
      ackSequence = 0;
      ackInFlight = false;
      if (host.current?.clientWidth && host.current.clientHeight) fit.fit();
      const result = await window.workspace.invoke<{ data: string }>(
        "session.attach",
        { ...identity, cols: terminal.cols, rows: terminal.rows },
      );
      if (disposed || ended || status.current === "exited") {
        await window.workspace.invoke("session.detach", identity);
        return;
      }
      await new Promise<void>((resolve) => terminal.write("", resolve));
      if (disposed) return;
      terminal.reset();
      terminal.write(result.data || "", () => {
        if (disposed) return;
        attached = true;
        setReady(true);
        // A reattach after a lost connection (SSH reconnect) clears the old error.
        setError("");
        terminal.options.disableStdin = false;
        viewerCallback.current?.(viewerId);
        pending.splice(0).forEach((event) => write(event.data, event.sequence));
        resize();
      });
    };
    const finish = () => {
      ended = true;
      attached = false;
      clearInput();
      pending.length = 0;
      setReady(false);
      setError("");
      terminal.options.disableStdin = true;
      viewerCallback.current?.(null);
      if (disposed || finalLoading || finalLoaded) return;
      finalLoading = true;
      streamEpoch++;
      void window.workspace
        .invoke<{ data: string }>("session.capture", {
          sessionId: session.id,
          generation: session.generation,
        })
        .then(async (result) => {
          if (disposed) return;
          await new Promise<void>((resolve) => terminal.write("", resolve));
          if (disposed) return;
          terminal.reset();
          terminal.write(result.data.replace(/\r?\n/g, "\r\n"));
          finalLoaded = true;
        })
        .catch(() => {
          /* Retain already visible output for legacy sessions without a capture. */
        })
        .finally(() => {
          finalLoading = false;
        });
    };
    finalCapture.current = finish;
    const unsubscribe = window.workspace.subscribe((event) => {
      if (
        (event.type === "session.exit" && event.sessionId === session.id) ||
        (event.type === "snapshot" &&
          event.snapshot.sessions.find((s) => s.id === session.id)?.status ===
            "exited")
      ) {
        finish();
      }
      if (event.type === "core.status" && event.status !== "ready") {
        attached = false;
        clearInput();
        setReady(false);
        terminal.options.disableStdin = true;
        viewerCallback.current?.(null);
      }
      if (
        (event.type === "terminal.data" || event.type === "terminal.resync") &&
        event.sessionId === session.id &&
        event.viewerId === viewerId &&
        !ended
      ) {
        if (event.type === "terminal.data") {
          if (attached) write(event.data, event.sequence);
          else pending.push(event);
        } else if (!resyncing) {
          resyncing = true;
          streamEpoch++;
          attached = false;
          clearInput();
          setReady(false);
          pending.length = 0;
          viewerCallback.current?.(null);
          void window.workspace
            .invoke("session.detach", identity)
            .then(attach)
            .catch(fail)
            .finally(() => {
              resyncing = false;
            });
        }
      }
    });
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const flushInput = () => {
      inputTimer = undefined;
      if (disposed || !attached || inputInFlight || !inputBuffer) return;
      const data = terminalInputChunk(inputBuffer);
      inputBuffer = inputBuffer.slice(data.length);
      inputInFlight = true;
      const inputEpoch = streamEpoch;
      void window.workspace
        .invoke("session.input", { ...identity, data })
        .catch((error) => {
          if (inputEpoch === streamEpoch) fail(error);
        })
        .finally(() => {
          inputInFlight = false;
          if (inputEpoch === streamEpoch && attached) flushInput();
        });
    };
    const send = (data: string) => {
      if (!attached) {
        fail(
          "Terminal is disconnected. Input was not sent or queued. Reconnect before retrying.",
        );
        return;
      }
      if (inputBuffer.length + data.length > 2 * 1024 * 1024) {
        fail(
          "Terminal input exceeded its limit. Unsent text was discarded; inspect the terminal before retrying.",
        );
        return;
      }
      // Batch only while attached. Failed or disconnected input is discarded,
      // and an uncertain write is never retried after reconnecting.
      inputBuffer += data;
      if (!inputInFlight && !inputTimer) inputTimer = setTimeout(flushInput, 8);
    };
    sendRef.current = send;
    const input = terminal.onData(send);
    if (
      status.current === "running" ||
      (status.current === "unknown" && manualRetry > 0)
    )
      void attach().catch(fail);
    else {
      terminal.options.disableStdin = true;
      if (status.current === "exited") finish();
    }
    return () => {
      disposed = true;
      attached = false;
      clearInput();
      viewerCallback.current?.(null);
      observer.disconnect();
      element.removeEventListener("paste", onPaste, true);
      terminal.textarea?.removeEventListener("keydown", onTextKeyDown, true);
      terminal.textarea?.removeEventListener("keyup", onTextKeyUp, true);
      terminal.textarea?.removeEventListener("input", onTextInput);
      terminal.textarea?.removeEventListener("blur", clearKeyed);
      clearKeyed();
      input.dispose();
      unsubscribe();
      terminalRef.current = null;
      sendRef.current = () => {};
      terminal.dispose();
      void window.workspace.invoke("session.detach", identity).catch(() => {});
    };
  }, [session.id, session.generation, epoch, manualRetry]);
  return (
    <div className="terminal-wrap">
      {session.status === "exited" && endedNotice ? (
        <div className="terminal-ended" role="status">
          Session ended.{" "}
          {session.transcript
            ? "Its final screen is shown below."
            : "Output seen in this open view remains below."}
        </div>
      ) : null}
      {session.status === "unknown" && !ready && !error ? (
        <div className="terminal-ended" role="status">
          Session state is unknown. Reconnect to check the existing process.
          <button onClick={() => setManualRetry((value) => value + 1)}>
            Reconnect
          </button>
        </div>
      ) : null}
      {!ready && !error && session.status === "running" ? (
        <div className="terminal-connection" role="status">
          Connecting terminal…
        </div>
      ) : null}
      {error ? (
        <div className="inline-error" role="alert">
          {error}
          {session.status !== "exited" ? (
            <button onClick={() => setManualRetry((value) => value + 1)}>
              Reconnect existing session
            </button>
          ) : null}
        </div>
      ) : null}
      {imageNotice ? (
        <div className="terminal-connection" role="status">
          {imageNotice}
          <button onClick={() => setImageNotice("")}>Dismiss</button>
        </div>
      ) : null}
      <div className="terminal-host" ref={host} />
      <span id={hintId} className="sr-only">
        Tab goes to the program. Press F6 to move to the next control outside
        the terminal, or Shift+F6 to the previous one.
      </span>
      {imagePaste ? (
        <ImagePastePreview
          preview={imagePaste.preview}
          busy={imageBusy}
          error={imageError}
          onConfirm={() => void confirmImagePaste()}
          onCancel={closeImagePaste}
        />
      ) : null}
      {pasteOpen ? (
        <form
          className="terminal-paste"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || !paste) return;
            terminalRef.current?.paste(paste);
            setPaste("");
            setPasteOpen(false);
            terminalRef.current?.focus();
          }}
        >
          <label htmlFor={"paste-" + session.id}>
            Paste terminal text{" "}
            <span>
              Uses the terminal’s paste mode; multiline text may execute
              commands.
            </span>
          </label>
          <textarea
            id={"paste-" + session.id}
            autoFocus
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            placeholder="Paste text here…"
          />
          <div>
            <button
              type="button"
              onClick={() => {
                setPasteOpen(false);
                setPaste("");
              }}
            >
              Cancel
            </button>
            <button className="secondary" disabled={!ready || !paste}>
              Send text
            </button>
          </div>
        </form>
      ) : null}
      <div className="terminal-keys" aria-label="Terminal extra keys">
        <button
          disabled={!ready}
          onClick={() => terminalRef.current?.focus()}
          aria-label="Focus terminal keyboard"
        >
          Keyboard
        </button>
        {[
          ["Esc", "\u001b"],
          ["Tab", "\t"],
          ["Ctrl C", "\u0003"],
          ["↑", "\u001b[A"],
          ["↓", "\u001b[B"],
          ["←", "\u001b[D"],
          ["→", "\u001b[C"],
          ["Enter", "\r"],
        ].map(([name, data]) => (
          <button
            key={name}
            disabled={!ready}
            aria-label={"Terminal " + name}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const terminal = terminalRef.current;
              const key =
                terminal?.modes.applicationCursorKeysMode &&
                /^\u001b\[[ABCD]$/.test(data!)
                  ? data!.replace("\u001b[", "\u001bO")
                  : data!;
              sendRef.current(key);
              terminal?.focus();
            }}
          >
            {name}
          </button>
        ))}
        <button disabled={!ready} onClick={() => setPasteOpen((open) => !open)}>
          Paste
        </button>
      </div>
    </div>
  );
}
