import { useEffect, useState } from "react";
import { X, Shield, Eye, EyeOff } from "lucide-react";
import type { RemoteStatus, Snapshot } from "../shared/contracts";
import "./remote-access.css";

export function RemoteAccessPanel({ onClose }: { onClose(): void }) {
  const api = window.workspace.remote!;
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("4318");
  const [origin, setOrigin] = useState("");
  const [tls, setTLS] = useState(false);
  const [phone, setPhone] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [projects, setProjects] = useState<Snapshot["projects"]>([]);
  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    let active = true;
    void api
      .status()
      .then((s) => {
        if (active) {
          setStatus(s);
          setHost(s.host);
          setPort(String(s.port));
          setTLS(s.tls);
          setOrigin(s.publicOrigin || "");
          setSelected(s.sharedProjects.map((p) => p.id));
        }
      })
      .catch(report);
    void window.workspace
      .invoke<Snapshot>("snapshot")
      .then((s) => {
        if (active)
          setProjects(s.projects.filter((p) => !p.hidden && !p.hostId));
      })
      .catch(report);
    const timer = setInterval(() => {
      void api
        .status()
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch(() => {});
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  async function run(action: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await action();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  let https = false;
  try {
    const u = new URL(origin);
    https =
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash;
  } catch {
    /* incomplete input */
  }
  const localAddress = status?.url
    ? ["localhost", "127.0.0.1", "[::1]"].includes(new URL(status.url).hostname)
    : false;
  const choices = status?.enabled ? status.sharedProjects : projects;
  const selectedLocal = selected.filter(id => projects.some(p => p.id === id));
  const ready = !!status && selectedLocal.length > 0 && (!phone || https);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal remote-access"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-title"
      >
        <header>
          <div>
            <h2 id="remote-title">
              <Shield size={18} /> Remote access
            </h2>
            <p>Connect your phone or another browser to this computer.</p>
          </div>
          <button aria-label="Close remote access" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="remote-status" role="status">
          <span
            className={status?.enabled ? "remote-dot enabled" : "remote-dot"}
          />{" "}
          {status?.enabled
            ? "Listener running · pair your device below"
            : "Off · complete the setup below"}
        </div>
        <p>
          Select the folders to show on your device. Paired devices act as you:
          terminal commands use your host account's permissions, so folder
          selection is not an operating-system sandbox. Closing the desktop app
          turns access off.
        </p>
        <fieldset disabled={busy || status?.enabled}>
          <legend>1. Choose folders</legend>
          <div className="remote-projects">
            {choices.length ? (
              choices.map((p) => (
                <label className="remote-checkbox" key={p.id}>
                  <input
                    type="checkbox"
                    checked={status?.enabled ? true : selected.includes(p.id)}
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked
                          ? [...ids, p.id]
                          : ids.filter((id) => id !== p.id),
                      )
                    }
                  />
                  {p.name}
                </label>
              ))
            ) : (
              <p>
                Open a local folder first. SSH folders cannot be shared here.
              </p>
            )}
          </div>
          <h3>2. Choose how to connect</h3>
          <label className="remote-checkbox">
            <input
              type="radio"
              name="remote-mode"
              checked={phone}
              onChange={() => setPhone(true)}
            />
            Phone or another computer · HTTPS required
          </label>
          <label className="remote-checkbox">
            <input
              type="radio"
              name="remote-mode"
              checked={!phone}
              onChange={() => {
                setPhone(false);
                setHost("127.0.0.1");
                setTLS(false);
                setOrigin("");
              }}
            />
            Browser on this computer only
          </label>
          {phone ? (
            <div className="setup-guide">
              <strong>You need a secure address for this computer</strong>
              <p>
                Use an existing HTTPS tunnel or a private-network certificate.
                The app does not create a public address for you.
              </p>
              <ol>
                <li>
                  Configure your tunnel to forward to{" "}
                  <code>http://127.0.0.1:{port}</code>.
                </li>
                <li>
                  Paste the tunnel's HTTPS address below. Do not use your
                  phone's localhost address.
                </li>
                <li>
                  Enable access, open that address on your phone and enter the
                  pairing code.
                </li>
              </ol>
              <p className="muted">
                Address format is checked here. Network reachability is
                confirmed when your device connects.
              </p>
            </div>
          ) : (
            <p>
              This starts a local browser listener. Other devices cannot use its
              loopback address.
            </p>
          )}
          <label>
            Browser address {phone ? "(HTTPS)" : "(optional)"}
            <input
              aria-label="Public browser address"
              placeholder="https://workspace.example.net"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
            />
          </label>
          {phone && origin && !https ? (
            <p role="status">
              Enter an HTTPS address without a path, query or credentials.
            </p>
          ) : null}
          <details>
            <summary>Advanced network settings</summary>
            <label>
              Listen on
              <select
                aria-label="Listen address"
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  if (e.target.value !== "127.0.0.1") setTLS(true);
                }}
              >
                <option value="127.0.0.1">
                  This host only · secure tunnel
                </option>
                <option value="0.0.0.0">
                  Network interfaces · HTTPS required
                </option>
              </select>
            </label>
            <label>
              Port
              <input
                aria-label="Remote port"
                type="number"
                min="1"
                max="65535"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
            <label className="remote-checkbox">
              <input
                type="checkbox"
                checked={tls}
                disabled={host !== "127.0.0.1"}
                onChange={(e) => setTLS(e.target.checked)}
              />{" "}
              Use a TLS certificate on this listener
            </label>
            {tls ? (
              <div className="remote-files">
                <button
                  type="button"
                  onClick={() =>
                    void run(async () =>
                      setStatus(await api.chooseTLSFile("certificate")),
                    )
                  }
                >
                  {status?.certificateName || "Choose certificate…"}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void run(async () =>
                      setStatus(await api.chooseTLSFile("key")),
                    )
                  }
                >
                  {status?.keyName || "Choose private key…"}
                </button>
              </div>
            ) : null}
            <p>
              A direct network connection needs a browser-trusted certificate,
              its private key and a matching HTTPS address. Keep loopback
              selected when using a tunnel.
            </p>
          </details>
        </fieldset>
        <section aria-label="Pair device">
          <h3>3. Pair your device</h3>
          {status?.enabled ? (
            <div className="remote-pair">
              <label>
                {localAddress
                  ? "Open on this computer"
                  : "Open on your other device"}
                <output>{status.url}</output>
              </label>
              <p>
                {localAddress
                  ? "This address works on this computer only."
                  : "Open this exact address and enter the pairing code. Keep this computer awake and Agent Workspace open."}
              </p>
              <div className="remote-actions">
                <button
                  disabled={busy}
                  onClick={() => {
                    if (secret) setSecret("");
                    else
                      void run(async () =>
                        setSecret(await api.pairingSecret()),
                      );
                  }}
                >
                  {secret ? <EyeOff size={14} /> : <Eye size={14} />}{" "}
                  {secret ? "Hide pairing code" : "Reveal pairing code"}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.revokeSessions();
                      setSecret("");
                      setNotice(
                        "All browser sessions revoked. The pairing code has changed.",
                      );
                    })
                  }
                >
                  Revoke all devices
                </button>
              </div>
              {secret ? (
                <label>
                  Pairing code
                  <output className="remote-secret">{secret}</output>
                  <span>Enter only on a device you trust.</span>
                </label>
              ) : null}
            </div>
          ) : (
            <p>
              Enable access after choosing folders and a connection method. Your
              pairing code will appear here.
            </p>
          )}
        </section>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        <footer>
          {status?.enabled ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setStatus(await api.disable());
                  setSecret("");
                })
              }
            >
              Stop remote access
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || !ready}
              onClick={() =>
                void run(async () => {
                  const n = Number(port);
                  if (!Number.isInteger(n) || n < 1 || n > 65535)
                    throw new Error("Enter a port from 1 to 65535");
                  setStatus(
                    await api.enable({
                      host,
                      port: n,
                      tls,
                      publicOrigin: origin.trim() || undefined,
                      projectIds: selectedLocal,
                    }),
                  );
                  setSecret("");
                })
              }
            >
              {busy ? "Starting…" : "Enable remote access"}
            </button>
          )}
          <button onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
