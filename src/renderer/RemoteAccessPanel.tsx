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
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [projects, setProjects] = useState<Snapshot["projects"]>([]);
  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    let active = true;
    void api.status().then(s => { if (active) { setStatus(s); setHost(s.host); setPort(String(s.port)); setTLS(s.tls); setOrigin(s.publicOrigin || ""); } }).catch(report);
    void window.workspace.invoke<Snapshot>("snapshot").then(s => { if (active) setProjects(s.projects); }).catch(report);
    const timer = setInterval(() => { void api.status().then(s => { if (active) setStatus(s); }).catch(() => {}); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [api]);
  async function run(action: () => Promise<void>) {
    setError(""); setNotice(""); setBusy(true);
    try { await action(); } catch (e) { report(e); } finally { setBusy(false); }
  }
  const localAddress = status?.url ? ["localhost", "127.0.0.1", "[::1]"].includes(new URL(status.url).hostname) : false;
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <section className="modal remote-access" role="dialog" aria-modal="true" aria-labelledby="remote-title">
      <header><div><h2 id="remote-title"><Shield size={18} /> Remote access</h2><p>Connect a browser to this host’s running workspace.</p></div><button aria-label="Close remote access" onClick={onClose}><X size={18} /></button></header>
      <div className="remote-status" role="status"><span className={status?.enabled ? "remote-dot enabled" : "remote-dot"} /> {status?.enabled ? `Listening · core ${status.coreStatus}` : "Remote access is off"}</div>
      <p className="remote-detail">Paired devices can control terminals and edit files in registered projects using this host’s account. Access stays off after an app restart.</p>
      <div className="remote-projects"><strong>{status?.enabled ? "Shared projects" : "Projects to share"}</strong>{(status?.enabled ? status.sharedProjects : projects).length ? <ul>{(status?.enabled ? status.sharedProjects : projects).map(p => <li key={p.id}>{p.name}</li>)}</ul> : <p className="remote-detail">Open a project before enabling remote access.</p>}<p className="remote-detail">Sharing is fixed when you enable access. Stop and enable again after adding projects.</p></div>
      <fieldset disabled={busy || status?.enabled}>
        <label>Listen on<select aria-label="Listen address" value={host} onChange={e => { setHost(e.target.value); if (e.target.value !== "127.0.0.1") setTLS(true); }}><option value="127.0.0.1">This host only · secure tunnel</option><option value="0.0.0.0">Network interfaces · HTTPS required</option></select></label>
        <label>Port<input aria-label="Remote port" type="number" min="1" max="65535" value={port} onChange={e => setPort(e.target.value)} /></label>
        <label>Browser address <span className="muted">optional HTTPS origin, for example your tunnel address</span><input aria-label="Public browser address" placeholder="https://workspace.example.net" value={origin} onChange={e => setOrigin(e.target.value)} /></label>
        <label className="remote-checkbox"><input type="checkbox" checked={tls} disabled={host !== "127.0.0.1"} onChange={e => setTLS(e.target.checked)} /> Use a TLS certificate on this listener</label>
        {tls && <div className="remote-files"><button onClick={() => void run(async () => setStatus(await api.chooseTLSFile("certificate")))}>{status?.certificateName || "Choose certificate…"}</button><button onClick={() => void run(async () => setStatus(await api.chooseTLSFile("key")))}>{status?.keyName || "Choose private key…"}</button></div>}
      </fieldset>
      {status?.enabled && <div className="remote-pair"><label>{localAddress ? "Local listener address" : "Open this address on your other device"}<output>{status.url}</output></label><p className="remote-detail">{localAddress ? "For another device, configure an HTTPS tunnel and enter its address above. A loopback address only reaches the device you open it on." : "Open this exact address in your other device’s browser. Its host name must match the TLS certificate."}</p><div className="remote-actions"><button disabled={busy} onClick={() => { if (secret) setSecret(""); else void run(async () => setSecret(await api.pairingSecret())); }}>{secret ? <EyeOff size={14} /> : <Eye size={14} />} {secret ? "Hide pairing code" : "Reveal pairing code"}</button><button disabled={busy} onClick={() => void run(async () => { await api.revokeSessions(); setSecret(""); setNotice("All browser sessions revoked. The pairing code has changed."); })}>Revoke all devices</button></div>{secret && <label>Pairing code<output className="remote-secret">{secret}</output><span className="remote-detail">Enter only on a device you trust. This code grants workspace control.</span></label>}</div>}
      <details><summary>Connect from your phone or another computer</summary><ol><li>Keep this host awake and Agent Workspace running. Both devices must reach the browser address.</li><li>For access anywhere, keep the loopback listener and route an HTTPS tunnel to port {port || "4318"}, using your own Tailscale Serve or reverse proxy setup.</li><li>For direct private-network access, choose network interfaces and a browser-trusted TLS certificate and matching private key. Enter the HTTPS origin users will open.</li><li>Open the browser address, reveal the code here, and pair on your other device. You can install the browser app from its browser menu.</li></ol><p className="remote-detail">The model CLIs and project files run on this host. Closing a browser detaches its terminal view; running sessions continue in tmux. To host on another Mac or Linux machine, use the headless server instructions in the README.</p></details>
      {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="remote-detail" role="status">{notice}</p>}
      <footer>{status?.enabled ? <button className="primary" disabled={busy} onClick={() => void run(async () => { setStatus(await api.disable()); setSecret(""); })}>Stop remote access</button> : <button className="primary" disabled={busy || !status || !projects.length} onClick={() => void run(async () => { const n = Number(port); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Enter a port from 1 to 65535"); setStatus(await api.enable({ host, port: n, tls, publicOrigin: origin.trim() || undefined })); setSecret(""); })}>{busy ? "Starting…" : "Enable remote access"}</button>}<button onClick={onClose}>Done</button></footer>
    </section>
  </div>;
}
