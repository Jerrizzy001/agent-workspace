import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, LockKeyhole, LogOut, RefreshCw } from "lucide-react";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void remote.initialize();
  }, [remote]);
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
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await remote.login(secret);
              setSecret("");
            } catch (reason) {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            } finally {
              setBusy(false);
            }
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
              : "pairing code shown by the workspace owner"}
            . Your folders and terminals stay on that machine.
          </p>
          <label htmlFor="pairing-secret">
            <LockKeyhole size={16} />
            {state.authMode === "password" ? "Server password" : "Pairing code"}
          </label>
          <input
            id="pairing-secret"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            disabled={busy || state.status !== "signed-out"}
          />
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
