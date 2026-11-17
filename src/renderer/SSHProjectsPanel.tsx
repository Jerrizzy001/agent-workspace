import { useState } from "react";
import {
  ArrowUp,
  Folder,
  FolderGit2,
  LoaderCircle,
  Plug,
  PlugZap,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import type {
  DirectoryListing,
  ExecutionHostView,
  HostProblem,
  Project,
} from "../shared/contracts";
import { errorText } from "./sessions";

export const hostStateLabel = (state: ExecutionHostView["state"]) =>
  state === "connected"
    ? "Connected"
    : state === "connecting"
      ? "Connecting…"
      : state === "reconnecting"
        ? "Reconnecting…"
        : "Disconnected";

function Problem({ problem }: { problem: HostProblem }) {
  const keyProblem =
    problem.code === "host-key-unknown" || problem.code === "host-key-changed";
  return (
    <div
      className={
        "ssh-problem" + (problem.code === "host-key-changed" ? " danger" : "")
      }
      role="alert"
    >
      {keyProblem ? <ShieldAlert size={15} aria-hidden="true" /> : null}
      <div>
        <strong>
          {problem.code === "host-key-unknown"
            ? "Unknown host key"
            : problem.code === "host-key-changed"
              ? "Host key changed"
              : problem.code === "helper-missing"
                ? "Helper not installed"
                : problem.code === "protocol-mismatch"
                  ? "Helper version mismatch"
                  : problem.code === "node-missing"
                    ? "Node.js missing on the host"
                    : problem.code === "auth-failed"
                      ? "Sign-in refused"
                      : problem.code === "upgrade-required"
                        ? "Helper data needs an upgrade"
                        : problem.code === "connection-lost"
                          ? "Connection lost"
                          : "Could not connect"}
        </strong>
        <p>{problem.message}</p>
        {problem.fingerprints?.length ? (
          <div className="ssh-fingerprints">
            <span>
              Fingerprint{problem.fingerprints.length > 1 ? "s" : ""} offered by
              the server:
            </span>
            <ul>
              {problem.fingerprints.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Desktop owner only: SSH execution hosts, their probes and their folders. */
export function SSHProjectsPanel({
  hosts,
  onClose,
  onOpenProject,
}: {
  hosts: ExecutionHostView[];
  onClose(): void;
  onOpenProject(project: Project): void;
}) {
  const api = window.workspace.ssh!;
  const [alias, setAlias] = useState("");
  const [label, setLabel] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [helperPath, setHelperPath] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [browseLocation, setBrowseLocation] = useState("");
  const [browsing, setBrowsing] = useState<{
    hostId: string;
    listing: DirectoryListing;
  } | null>(null);
  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  const browse = (hostId: string, path?: string) =>
    run("browse:" + hostId, async () => {
      const listing = await api.browse(hostId, path);
      setBrowsing({ hostId, listing });
      setBrowseLocation(listing.path);
    });
  const browsingHost = browsing && hosts.find((h) => h.id === browsing.hostId);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal ssh-hosts"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-title"
      >
        <header>
          <div>
            <h2 id="ssh-title">
              SSH hosts
            </h2>
            <p>
              Run Claude, Codex and shells on another computer while this window
              stays the interface.
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close SSH hosts"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <ol className="connection-steps">
          <li>Prepare host</li>
          <li>Check connection</li>
          <li>Choose folder</li>
        </ol>
        {!hosts.length ? (
          <section className="setup-guide">
            <h3>Before adding your first host</h3>
            <p>
              You need a Mac or Linux computer that you can already reach with
              SSH. The app will test its host key, sign-in, Node version and
              workspace helper before offering its folders.
            </p>
            <ol>
              <li>
                Create a named host in your OpenSSH configuration and connect
                once to verify its fingerprint.
              </li>
              <li>
                Install the matching Agent Workspace server archive on that
                computer. Expand the helper guide below for the commands.
              </li>
              <li>
                Add the alias here, check it, then connect and choose a folder.
              </li>
            </ol>
            <p>
              This setup runs your agents on the other computer. To use this
              computer from a phone, choose Remote access instead.
            </p>
          </section>
        ) : null}
        {browsing && browsingHost ? (
          <div
            className="ssh-browser"
            aria-label={"Folders on " + browsingHost.label}
          >
            <div className="ssh-browser-head">
              <button
                className="button ghost small"
                aria-label="Parent folder"
                disabled={!browsing.listing.parent || !!busy}
                onClick={() =>
                  void browse(browsingHost.id, browsing.listing.parent!)
                }
              >
                <ArrowUp size={14} />
              </button>
              <code title={browsing.listing.path}>
                {browsingHost.label}:{browsing.listing.path}
              </code>
              <button
                className="button ghost small"
                onClick={() => setBrowsing(null)}
              >
                Back to hosts
              </button>
            </div>
            <form
              className="browser-location"
              onSubmit={(e) => {
                e.preventDefault();
                const entered = browseLocation.trim();
                if (entered)
                  void browse(
                    browsingHost.id,
                    entered.startsWith("~/")
                      ? browsing.listing.home + entered.slice(1)
                      : entered,
                  );
              }}
            >
              <label>
                Remote folder location
                <input
                  aria-label="Remote folder location"
                  value={browseLocation}
                  disabled={!!busy}
                  onChange={(e) => setBrowseLocation(e.target.value)}
                  placeholder="/srv/my-project"
                />
              </label>
              <button
                className="button"
                disabled={!!busy || !browseLocation.trim()}
              >
                Go to folder
              </button>
            </form>
            {browsing.listing.truncated ? (
              <p role="status">
                This folder has more entries than can be listed. Paste its full
                child-folder path above to open it.
              </p>
            ) : null}
            <div className="ssh-places">
              {browsing.listing.places.map((p) => (
                <button
                  key={p.path}
                  className="button ghost small"
                  onClick={() => void browse(browsingHost.id, p.path)}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <ul className="ssh-entries">
              {browsing.listing.entries
                .filter((e) => e.type === "directory" && !e.hidden)
                .map((e) => (
                  <li key={e.path}>
                    <button
                      disabled={!!busy}
                      onClick={() => void browse(browsingHost.id, e.path)}
                    >
                      {e.git ? <FolderGit2 size={14} /> : <Folder size={14} />}
                      <span>{e.name}</span>
                      {e.git ? <em>Git</em> : null}
                    </button>
                  </li>
                ))}
              {!browsing.listing.entries.some(
                (e) => e.type === "directory" && !e.hidden,
              ) ? (
                <li className="ssh-empty">No folders here.</li>
              ) : null}
            </ul>
            <div className="ssh-browser-foot">
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() =>
                  void run("register", async () => {
                    const project = await api.registerProject(
                      browsingHost.id,
                      browsing.listing.path,
                    );
                    setBrowsing(null);
                    setNotice(
                      `${project.name} on ${browsingHost.label} was added to your folders.`,
                    );
                    onOpenProject(project);
                  })
                }
              >
                {busy === "register" ? (
                  <LoaderCircle size={14} className="spin" />
                ) : null}
                Open this folder on {browsingHost.label}
              </button>
              <span className="muted">
                Files, Git and terminals for it run on {browsingHost.label}.
              </span>
            </div>
          </div>
        ) : (
          <>
            {hosts.length ? (
              <ul className="ssh-host-list">
                {hosts.map((h) => (
                  <li
                    key={h.id}
                    className="ssh-host"
                    aria-label={"Host " + h.label}
                  >
                    <div className="ssh-host-head">
                      <span
                        className={"ssh-dot " + h.state}
                        aria-hidden="true"
                      />
                      <div className="ssh-host-name">
                        <strong>{h.label}</strong>
                        <small>
                          {h.user ? h.user + "@" : ""}
                          {h.alias}
                          {h.port ? ":" + h.port : ""} · helper {h.helperPath}
                        </small>
                      </div>
                      <span
                        className="ssh-state"
                        role="status"
                        aria-label={h.label + " connection"}
                      >
                        {hostStateLabel(h.state)}
                      </span>
                    </div>
                    {h.helperVersion ? (
                      <p className="ssh-meta">
                        Helper {h.helperVersion} · protocol {h.protocol} ·{" "}
                        {h.platform}
                        {h.probedAt
                          ? " · checked " +
                            new Date(h.probedAt).toLocaleString()
                          : ""}
                      </p>
                    ) : null}
                    {h.tools?.length ? (
                      <div
                        className="ssh-tools"
                        aria-label={"Tools on " + h.label}
                      >
                        {h.tools.map((t) => (
                          <span
                            key={t.name}
                            className={t.available ? "ok" : "missing"}
                            title={t.detail}
                          >
                            {t.name}
                            {t.available ? "" : " missing"}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {h.problem ? <Problem problem={h.problem} /> : null}
                    <div className="ssh-actions">
                      <button
                        className="button ghost small"
                        disabled={!!busy}
                        onClick={() =>
                          void run("probe:" + h.id, async () => {
                            const result = await api.probe(h.id);
                            if (result.ok)
                              setNotice(
                                `${h.label}: helper ${result.host.helperVersion} answered.`,
                              );
                          })
                        }
                      >
                        {busy === "probe:" + h.id ? (
                          <LoaderCircle size={13} className="spin" />
                        ) : (
                          <RefreshCw size={13} />
                        )}
                        Check host
                      </button>
                      {h.state === "connected" ? (
                        <>
                          <button
                            className="button small"
                            disabled={!!busy}
                            onClick={() => void browse(h.id)}
                          >
                            <Folder size={13} /> Open a folder…
                          </button>
                          <button
                            className="button ghost small"
                            disabled={!!busy}
                            onClick={() =>
                              void run(
                                "disconnect:" + h.id,
                                async () => void (await api.disconnect(h.id)),
                              )
                            }
                          >
                            <Plug size={13} /> Disconnect
                          </button>
                        </>
                      ) : (
                        <button
                          className="button small"
                          disabled={!!busy || h.state === "connecting"}
                          onClick={() =>
                            void run(
                              "connect:" + h.id,
                              async () => void (await api.connect(h.id)),
                            )
                          }
                        >
                          {busy === "connect:" + h.id ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : (
                            <PlugZap size={13} />
                          )}
                          Connect
                        </button>
                      )}
                      {h.problem?.code === "upgrade-required" &&
                      h.state !== "connected" ? (
                        <button
                          className="button small"
                          disabled={!!busy}
                          onClick={() => {
                            if (
                              confirm(
                                `Upgrade the helper data on ${h.label}? A backup is kept on the host; older helpers will refuse the upgraded data.`,
                              )
                            )
                              void run(
                                "connect:" + h.id,
                                async () =>
                                  void (await api.connect(h.id, {
                                    approveUpgrade: true,
                                  })),
                              );
                          }}
                        >
                          Upgrade and connect
                        </button>
                      ) : null}
                      <button
                        className="button ghost small danger"
                        aria-label={"Remove " + h.label}
                        disabled={!!busy}
                        onClick={() => {
                          if (
                            confirm(
                              `Remove ${h.label} from this app? Its folders leave your list. Sessions and files on the host are not touched.`,
                            )
                          )
                            void run("remove:" + h.id, () => api.remove(h.id));
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ssh-intro">
                No hosts yet. Add an alias from your OpenSSH configuration (
                <code>~/.ssh/config</code>). The app uses your existing keys and
                agent; it never stores passwords or keys.
              </p>
            )}
            <details className="ssh-add-wrap" open={!hosts.length}>
              <summary>
                {hosts.length ? "Add another host" : "Add a host"}
              </summary>
              <form
                className="ssh-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("add", async () => {
                    const n = port.trim() ? Number(port) : undefined;
                    const host = await api.add({
                      alias: alias.trim(),
                      ...(label.trim() ? { label: label.trim() } : {}),
                      ...(user.trim() ? { user: user.trim() } : {}),
                      ...(n !== undefined ? { port: n } : {}),
                      ...(helperPath.trim()
                        ? { helperPath: helperPath.trim() }
                        : {}),
                      ...(dataDir.trim() ? { dataDir: dataDir.trim() } : {}),
                    });
                    setAlias("");
                    setLabel("");
                    setUser("");
                    setPort("");
                    const result = await api.probe(host.id);
                    if (result.ok)
                      setNotice(
                        `${host.label}: helper ${result.host.helperVersion} answered. Connect to open folders there.`,
                      );
                  });
                }}
              >
                <div className="ssh-row">
                  <label>
                    Host alias
                    <input
                      aria-label="Host alias"
                      placeholder="build-box"
                      value={alias}
                      onChange={(e) => setAlias(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>
                      Name <span className="muted">optional</span>
                    </span>
                    <input
                      aria-label="Host name"
                      placeholder="Build box"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                    />
                  </label>
                </div>
                <details>
                  <summary>User, port and helper location</summary>
                  <div className="ssh-row">
                    <label>
                      <span>
                        User <span className="muted">overrides the alias</span>
                      </span>
                      <input
                        aria-label="SSH user"
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                      />
                    </label>
                    <label>
                      Port
                      <input
                        aria-label="SSH port"
                        inputMode="numeric"
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                      />
                    </label>
                  </div>
                  <label>
                    Helper folder on the host
                    <input
                      aria-label="Helper folder"
                      placeholder="~/agent-workspace-server"
                      value={helperPath}
                      onChange={(e) => setHelperPath(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>
                      Helper data folder{" "}
                      <span className="muted">
                        optional, default ~/.agent-workspace-ssh
                      </span>
                    </span>
                    <input
                      aria-label="Helper data folder"
                      value={dataDir}
                      onChange={(e) => setDataDir(e.target.value)}
                    />
                  </label>
                </details>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!!busy || !alias.trim()}
                >
                  {busy === "add" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : null}
                  Add and check host
                </button>
              </form>
            </details>
            <details className="ssh-help">
              <summary>Install the helper on a host</summary>
              <ol>
                <li>
                  On the host, install Node.js 24 or newer, tmux and Git, and
                  sign in to Claude or Codex there if you use them.
                </li>
                <li>
                  Copy{" "}
                  <code>agent-workspace-server-&lt;version&gt;.tar.gz</code>{" "}
                  from this app release into an otherwise empty folder on the
                  host, then run{" "}
                  <code>
                    mkdir -p ~/agent-workspace-server &amp;&amp; tar -xzf
                    ./agent-workspace-server-*.tar.gz --strip-components=1 -C
                    ~/agent-workspace-server &amp;&amp; cd
                    ~/agent-workspace-server &amp;&amp; npm ci
                  </code>
                  .
                </li>
                <li>
                  Connect once with <code>ssh &lt;alias&gt;</code> in your own
                  terminal to check and accept the host key.
                </li>
              </ol>
              <p className="muted">
                The app runs <code>ssh -T</code> with strict host key checking,
                no agent or port forwarding, and starts only{" "}
                <code>&lt;helper folder&gt;/bin/aw-ssh-helper</code>.
                Disconnecting leaves sessions running on the host. SSH folders
                are never shared with paired browsers. Pasted images, agent
                control and AI suggestions stay on this computer.
              </p>
            </details>
          </>
        )}
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="ssh-notice" role="status">
            {notice}
          </p>
        ) : null}
        <footer>
          <button onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
