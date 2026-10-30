import { createId } from "./id";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Session } from "../shared/contracts";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({
  session,
  onViewer,
}: {
  session: Session;
  onViewer?: (id: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewerCallback = useRef(onViewer);
  viewerCallback.current = onViewer;
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
      fontFamily: '"SFMono-Regular", Menlo, monospace',
      lineHeight: 1.45,
      scrollback: 5000,
      theme: {
        background: "#151719",
        foreground: "#d6d9dc",
        cursor: "#eeb66a",
        selectionBackground: "#5c4b35",
        black: "#282c30",
        red: "#e68b82",
        green: "#a6c592",
        yellow: "#eeb66a",
        blue: "#8cb4dc",
        magenta: "#bd9aca",
        cyan: "#8bc7bf",
        white: "#e4e4e4",
      },
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    const fail = (e: unknown) => {
      if (!disposed) {
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
      if (disposed) {
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
        terminal.options.disableStdin = false;
        viewerCallback.current?.(viewerId);
        pending.splice(0).forEach((event) => write(event.data, event.sequence));
        resize();
      });
    };
    const unsubscribe = window.workspace.subscribe((event) => {
      if (
        (event.type === "session.exit" && event.sessionId === session.id) ||
        (event.type === "snapshot" &&
          event.snapshot.sessions.find((s) => s.id === session.id)?.status ===
            "exited")
      ) {
        attached = false;
        clearInput();
        setReady(false);
        terminal.options.disableStdin = true;
        viewerCallback.current?.(null);
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
        event.viewerId === viewerId
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
      const data = inputBuffer;
      inputBuffer = "";
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
      if (inputBuffer.length + data.length > 65536) {
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
    else terminal.options.disableStdin = true;
    return () => {
      disposed = true;
      attached = false;
      clearInput();
      viewerCallback.current?.(null);
      observer.disconnect();
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
      {session.status === "exited" ? (
        <div className="terminal-ended" role="status">
          Session ended. Output received in this open view remains below. Closed
          views have no saved terminal transcript.
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
      <div className="terminal-host" ref={host} />
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
