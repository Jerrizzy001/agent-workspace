import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowUpRight,
  Eye,
  EyeOff,
  LockKeyhole,
  LogOut,
  RefreshCw,
} from "lucide-react";
import App from "./App";
import { remoteWorkspace } from "./remote";
import { BrandMark } from "./ui";
import { canLeaveWorkspace } from "./leaveWorkspace";

export function BrowserRoot() {
  if (!remoteWorkspace) return <App />;
  return <RemoteRoot />;
}
function RemoteRoot() {
  const remote = remoteWorkspace!;
  const state = useSyncExternalStore(remote.subscribeState, remote.getState);
  const [secret, setSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A scanned one-time link carries its code in the fragment (#pair=…). Take
  // it once and drop it from the address bar and history straight away.
  const [linkCode] = useState(() => {
    const code = new URLSearchParams(location.hash.slice(1)).get("pair");
    if (code)
      history.replaceState(null, "", location.pathname + location.search);
    return code?.trim() || "";
  });
  const usedLink = useRef(false);
  const signIn = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      await remote.login(value.trim());
      setSecret("");
      return "";
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void remote.initialize();
  }, [remote]);
  useEffect(() => {
    if (!linkCode || usedLink.current || state.status !== "signed-out") return;
    usedLink.current = true;
    void signIn(linkCode).then((failure) => {
      // Only a rejected code means the link is spent; keep other errors as is.
      if (/not accepted/.test(failure))
        setError(
          "This pairing link was already used or has expired. Show a new QR code on the workspace computer, or enter the pairing code.",
        );
    });
  }, [linkCode, state.status]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () =>
      document.documentElement.style.setProperty(
        "--visual-height",
        `${viewport?.height || window.innerHeight}px`,
      );
    resize();
    viewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext)
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  if (
    state.status === "checking" ||
    state.status === "signed-out" ||
    state.status === "connecting"
  )
    return (
      <main className="pairing-screen">
        <form
          className="pairing-card"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn(secret);
          }}
        >
          <div className="pairing-logo">
            <BrandMark size={40} />
          </div>
          <div className="eyebrow">Agent Workspace</div>
          <h1>Connect to your workspace.</h1>
          <p>
            Use the{" "}
            {state.authMode === "password"
              ? "password configured on your server"
              : "QR code or pairing code shown by the workspace owner"}
            . Your folders and terminals stay on that machine.
          </p>
          <label htmlFor="pairing-secret">
            <LockKeyhole size={16} />
            {state.authMode === "password" ? "Server password" : "Pairing code"}
          </label>
          <div className="pairing-input">
            <input
              id="pairing-secret"
              type={revealed ? "text" : "password"}
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus={!linkCode}
              required
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              disabled={busy || state.status !== "signed-out"}
            />
            <button
              type="button"
              className="pairing-reveal"
              aria-pressed={revealed}
              aria-controls="pairing-secret"
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
              {revealed ? "Hide" : "Show"}
            </button>
          </div>
          {error || state.error ? (
            <p className="pairing-error" role="alert">
              {error || state.error}
            </p>
          ) : null}
          <button
            className="primary"
            disabled={busy || state.status !== "signed-out" || !secret.trim()}
          >
            {busy || state.status === "connecting"
              ? "Connecting…"
              : state.status === "checking"
                ? "Checking server…"
                : "Connect"}
            <ArrowUpRight size={16} />
          </button>
          <p className="pairing-footnote">
            Install from your browser’s menu when this workspace uses HTTPS.
            Browser access also works without installation.
          </p>
        </form>
      </main>
    );
  return (
    <div className="browser-workspace">
      <div
        className={
          "remote-bar " +
          (state.status !== "connected" ? "is-disconnected" : "")
        }
        role="status"
      >
        <span>
          <span
            className={
              "tiny-dot " + (state.status !== "connected" ? "neutral" : "")
            }
          />
          {state.status === "connected"
            ? "Connected to workspace"
            : "Reconnecting · input paused"}
        </span>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              if (!(await canLeaveWorkspace())) return;
              await remote.logout();
            } catch (reason) {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <LogOut size={13} />
          Sign out
        </button>
      </div>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
          <button
            aria-label="Dismiss sign out error"
            onClick={() => setError("")}
          >
            ×
          </button>
        </div>
      ) : null}
      <App />
      {state.status !== "connected" ? (
        <div className="network-toast">
          <RefreshCw size={15} />
          Existing processes keep running. Reattaching when online.
        </div>
      ) : null}
    </div>
  );
}
