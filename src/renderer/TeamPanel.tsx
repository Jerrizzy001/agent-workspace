import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  Copy,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import type {
  InvitationCreated,
  ProjectRole,
  SharedTaskView,
  TeamLocalProject,
  TeamMemberView,
  TeamStatus,
} from "../shared/team-contracts";
import { errorText } from "./sessions";
import { OutboxRow, TeamTaskThread } from "./TaskComments";

const roleLabel = (role: ProjectRole) =>
  role === "admin" ? "Admin" : role === "member" ? "Member" : "Viewer";

export function useTeamStatus() {
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const load = useCallback(() => {
    void window.workspace.team
      ?.status()
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!window.workspace.team) return;
    load();
    return window.workspace.team.onChange(load);
  }, [load]);
  return [status, setStatus, load] as const;
}

/** Desktop owner only: connect to a self-hosted team service, publish a folder's tasks, manage members. */
export function TeamPanel({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const api = window.workspace.team!;
  const [status, setStatus, reload] = useTeamStatus();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [serviceUrl, setServiceUrl] = useState("");
  const [invitation, setInvitation] = useState("");
  const [openProject, setOpenProject] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState(projectName);
  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      const result = await fn();
      if (
        result &&
        typeof result === "object" &&
        "secretStorage" in (result as object)
      )
        setStatus(result as TeamStatus);
      else reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    if (status?.serviceUrl && !serviceUrl) setServiceUrl(status.serviceUrl);
  }, [status?.serviceUrl]);
  const linked = status?.projects.find(
    (p) => p.localProjectId === projectId && p.state === "active",
  );
  const ownedTeams = (status?.teams ?? []).filter((t) => t.role === "owner");
  const adminProjects = (status?.projects ?? []).filter(
    (p) => p.state === "active" && p.role === "admin" && !p.localProjectId,
  );
  const selected = status?.projects.find((p) => p.id === openProject);
  return (
    <div className="modal-backdrop">
      <section
        className="modal team-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-panel-title"
      >
        <header>
          <div>
            <h2 id="team-panel-title">
              Team
            </h2>
            <p>
              Share chosen task titles, descriptions and status with your team.
              Files, prompts, transcripts and terminals never leave this
              computer, and teammates get no access to your sessions.
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close team panel"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        {!status ? (
          <p className="muted">Loading…</p>
        ) : !status.secretStorage.available ? (
          <div className="team-warning" role="alert">
            <ShieldAlert size={15} aria-hidden="true" />
            <div>
              <strong>
                {status.secretStorage.backend === "unchecked"
                  ? "Check secure storage before signing in"
                  : "Secure credential storage is unavailable"}
              </strong>
              <p>{status.secretStorage.detail}</p>
              <button
                className="button"
                disabled={!!busy}
                onClick={() => void run("prepare", () => api.prepare())}
              >
                Check secure storage
              </button>
            </div>
          </div>
        ) : null}
        {status && !status.connected ? (
          <section className="setup-guide">
            <h3>Join an existing team</h3>
            <p>
              Ask the team owner for the HTTPS service address and your
              invitation code. This shares task metadata, comments and
              assignments—not terminals or agent conversations.
            </p>
            <details>
              <summary>I am the owner: set up a team service</summary>
              <ol>
                <li>
                  Choose a server and identity provider. The server archive
                  includes <code>dist/team/server.mjs</code> and{" "}
                  <code>team-service.md</code>.
                </li>
                <li>
                  Follow that guide to create <code>team-service.json</code>{" "}
                  with an HTTPS address, private data directory, and your
                  identity provider's client settings.
                </li>
                <li>
                  Start the service with{" "}
                  <code>
                    node dist/team/server.mjs --config team-service.json
                  </code>
                  .
                </li>
                <li>
                  Create your owner invitation on the server with{" "}
                  <code>
                    node dist/team/server.mjs --config team-service.json
                    init-team --name "My team"
                  </code>
                  .
                </li>
                <li>
                  Enter the address and the invitation below, then sign in in
                  your browser.
                </li>
              </ol>
              <p>
                A team service is not hosted automatically. Your local workspace
                works without one.
              </p>
            </details>
          </section>
        ) : null}
        {status && !status.connected ? (
          <form
            className="team-connect"
            onSubmit={(e) => {
              e.preventDefault();
              void run("connect", () =>
                api.connect({
                  serviceUrl,
                  ...(invitation.trim()
                    ? { invitation: invitation.trim() }
                    : {}),
                }),
              );
            }}
          >
            <label>
              Team service address
              <input
                value={serviceUrl}
                onChange={(e) => setServiceUrl(e.target.value)}
                placeholder="https://team.example.com"
                required
                spellCheck={false}
              />
            </label>
            <label>
              Invitation code <span className="muted">first time only</span>
              <input
                value={invitation}
                onChange={(e) => setInvitation(e.target.value)}
                placeholder="twi_…"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <p className="form-hint">
              Connect opens your browser to sign in with your organization's
              identity provider. Joining needs an invitation from a team owner
              or project admin; there is no public sign-up.
            </p>
            <button
              className="button primary"
              disabled={
                !!busy || !status.secretStorage.available || !serviceUrl.trim()
              }
            >
              {busy === "connect" ? (
                <LoaderCircle size={14} className="spin" />
              ) : null}
              {busy === "connect"
                ? "Waiting for sign-in in your browser…"
                : "Connect"}
            </button>
          </form>
        ) : null}
        {status?.connected ? (
          <>
            <div className="team-identity">
              <span
                className={"team-dot" + (status.online ? " online" : "")}
                aria-hidden="true"
              />
              <div>
                <strong>{status.identity?.name}</strong>
                <small>
                  {status.identity?.email} · {status.serviceUrl}
                </small>
              </div>
              <span className="team-sync-label" role="status">
                {status.online ? "Online" : "Offline"}
                {status.lastSyncAt
                  ? " · synced " +
                    new Date(status.lastSyncAt).toLocaleTimeString()
                  : ""}
              </span>
              <button
                className="button small ghost"
                disabled={!!busy}
                onClick={() => void run("sync", () => api.sync())}
              >
                {busy === "sync" ? (
                  <LoaderCircle size={12} className="spin" />
                ) : (
                  <RefreshCw size={12} />
                )}{" "}
                Sync now
              </button>
              <button
                className="button small ghost"
                disabled={!!busy}
                onClick={() => {
                  if (
                    confirm(
                      status.outbox.length
                        ? `Disconnect? ${status.outbox.length} unsent change(s) and this computer's copy of team data will be removed.`
                        : "Disconnect from the team service? This computer's copy of team data is removed; your local tasks stay.",
                    )
                  )
                    void run("disconnect", () => api.disconnect());
                }}
              >
                <LogOut size={12} /> Disconnect
              </button>
            </div>
            {status.error ? (
              <p className="team-error" role="alert">
                {status.error}
              </p>
            ) : null}
            {status.notices.map((n, i) => (
              <p key={i} className="team-notice" role="status">
                {n}
              </p>
            ))}
            {status.outbox.length ? (
              <div className="team-outbox" aria-label="Unsent team changes">
                <h3>Unsent changes</h3>
                {status.outbox.map((o) => (
                  <OutboxRow
                    key={o.mutationId}
                    item={o}
                    onResolve={(choice) =>
                      void run("resolve", () =>
                        api.resolve({ mutationId: o.mutationId, choice }),
                      )
                    }
                  />
                ))}
              </div>
            ) : null}
            {projectId ? (
              <div className="team-folder" aria-label="This folder">
                <h3>This folder · {projectName}</h3>
                {linked ? (
                  <div className="team-folder-row">
                    <span>
                      Published to{" "}
                      <strong>
                        {linked.teamName} / {linked.name}
                      </strong>
                      . Share individual tasks from the Board's Tasks view; each
                      one shows exactly what is sent first.
                    </span>
                    <button
                      className="button small ghost danger"
                      disabled={!!busy}
                      onClick={() => {
                        if (
                          confirm(
                            "Stop publishing this folder? Its shared tasks are removed from the team project; your local tasks stay.",
                          )
                        )
                          void run("revoke", () =>
                            api.revokeProject({ projectId }),
                          );
                      }}
                    >
                      Stop publishing
                    </button>
                  </div>
                ) : (
                  <div className="team-folder-publish">
                    {ownedTeams.length ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run("publish", () =>
                            api.publishProject({
                              projectId,
                              teamId: ownedTeams[0]!.id,
                              name: newProjectName,
                            }),
                          );
                        }}
                      >
                        <label>
                          New team project in {ownedTeams[0]!.name}
                          <input
                            value={newProjectName}
                            onChange={(e) => setNewProjectName(e.target.value)}
                            maxLength={120}
                            required
                          />
                        </label>
                        <button
                          className="button small primary"
                          disabled={!!busy || !newProjectName.trim()}
                        >
                          Publish folder
                        </button>
                      </form>
                    ) : null}
                    {adminProjects.map((p) => (
                      <button
                        key={p.id}
                        className="button small"
                        disabled={!!busy}
                        onClick={() =>
                          void run("publish", () =>
                            api.publishProject({
                              projectId,
                              teamProjectId: p.id,
                            }),
                          )
                        }
                      >
                        Publish to {p.teamName} / {p.name}
                      </button>
                    ))}
                    {!ownedTeams.length && !adminProjects.length ? (
                      <p className="muted">
                        Only team owners and project admins publish folders. You
                        can still comment on shared tasks below.
                      </p>
                    ) : (
                      <p className="form-hint">
                        Publishing a folder sends nothing by itself; you choose
                        each task to share.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : null}
            {selected ? (
              <TeamProjectView
                project={selected}
                onBack={() => setOpenProject("")}
              />
            ) : (
              <div className="team-projects">
                <h3>Team projects</h3>
                {status.projects.filter((p) => p.state === "active").length ? (
                  <ul>
                    {status.projects
                      .filter((p) => p.state === "active")
                      .map((p) => (
                        <li key={p.id}>
                          <button
                            className="team-project-row"
                            onClick={() => setOpenProject(p.id)}
                          >
                            <strong>{p.name}</strong>
                            <small>{p.teamName}</small>
                            <span className="team-chip">
                              {roleLabel(p.role)}
                            </span>
                          </button>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="muted">No team projects yet.</p>
                )}
              </div>
            )}
          </>
        ) : null}
        {error ? (
          <p className="team-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function TeamProjectView({
  project,
  onBack,
}: {
  project: TeamLocalProject;
  onBack: () => void;
}) {
  const api = window.workspace.team!;
  const [members, setMembers] = useState<TeamMemberView[]>([]);
  const [tasks, setTasks] = useState<
    (SharedTaskView & { assignee: string | null; commentCount: number })[]
  >([]);
  const [task, setTask] = useState("");
  const [role, setRole] = useState<ProjectRole>("member");
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const admin = project.role === "admin";
  const load = useCallback(() => {
    api
      .members({ teamProjectId: project.id })
      .then(setMembers)
      .catch((e) => setError(errorText(e)));
    api
      .sharedTasks({ teamProjectId: project.id })
      .then(setTasks)
      .catch(() => {});
  }, [project.id]);
  useEffect(() => {
    load();
    return api.onChange(load);
  }, [load]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      const r = await fn();
      if (Array.isArray(r)) setMembers(r as TeamMemberView[]);
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const current = tasks.find((t) => t.id === task);
  return (
    <div className="team-project" aria-label={"Team project " + project.name}>
      <div className="team-project-head">
        <button
          className="button small ghost"
          onClick={current ? () => setTask("") : onBack}
        >
          <ChevronLeft size={13} /> {current ? project.name : "All projects"}
        </button>
        <h3>
          {current ? current.title : project.name}{" "}
          <small className="muted">{project.teamName}</small>
        </h3>
        <span className="team-chip">{roleLabel(project.role)}</span>
      </div>
      {project.truncated ? (
        <p className="muted">
          Only the newest comments are kept on this computer.
        </p>
      ) : null}
      {current ? (
        <>
          {current.description ? (
            <p className="team-task-description">{current.description}</p>
          ) : null}
          <TeamTaskThread sharedTaskId={current.id} />
        </>
      ) : (
        <>
          <h4>Members</h4>
          <ul className="team-members">
            {members.map((m) => (
              <li key={m.memberId} aria-label={"Member " + m.name}>
                <div>
                  <strong>{m.name}</strong>
                  <small>
                    {m.email}
                    {m.status === "invited" ? " · invitation pending" : ""}
                    {m.teamRole === "owner" ? " · team owner" : ""}
                  </small>
                </div>
                {admin && m.teamRole !== "owner" ? (
                  <>
                    <select
                      aria-label={"Role for " + m.name}
                      value={m.role}
                      disabled={busy}
                      onChange={(e) =>
                        void run(() =>
                          api.setRole({
                            teamProjectId: project.id,
                            memberId: m.memberId,
                            role: e.target.value as ProjectRole,
                          }),
                        )
                      }
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      className="icon-button"
                      aria-label={"Remove " + m.name}
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            `Remove ${m.name} from ${project.name}? Their access and assignments end now; their comments stay.`,
                          )
                        )
                          void run(() =>
                            api.removeMember({
                              teamProjectId: project.id,
                              memberId: m.memberId,
                            }),
                          );
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                ) : (
                  <span className="team-chip">
                    {m.role ? roleLabel(m.role) : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {admin ? (
            <form
              className="team-invite"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () =>
                  setCreated(
                    await api.invite({
                      teamProjectId: project.id,
                      role,
                      ...(email.trim() ? { email: email.trim() } : {}),
                    }),
                  ),
                );
              }}
            >
              <label>
                Invite with role
                <select
                  aria-label="Invitation role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as ProjectRole)}
                >
                  <option value="member">Member</option>
                  <option value="viewer">Viewer (read only)</option>
                  <option value="admin">Admin (manages members)</option>
                </select>
              </label>
              <label>
                Email (optional)
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  title="If set, only a sign-in with this verified email can use the invitation"
                />
              </label>
              <button className="button small primary" disabled={busy}>
                Create invitation
              </button>
              <p className="form-hint">
                Members comment and take assignments; viewers only read; admins
                also manage members and shared tasks. With an email, only a
                sign-in with that verified email can use the code.
              </p>
            </form>
          ) : null}
          {created ? (
            <div className="team-invitation" role="status">
              <span>
                Send this code privately. It works once and expires{" "}
                {new Date(created.expiresAt).toLocaleString()}.
              </span>
              <code aria-label="Invitation code">{created.code}</code>
              <button
                className="button small ghost"
                onClick={() =>
                  void navigator.clipboard?.writeText(created.code)
                }
              >
                <Copy size={12} /> Copy
              </button>
            </div>
          ) : null}
          <h4>Shared tasks</h4>
          <ul className="team-shared-tasks">
            {tasks.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setTask(t.id)}
                  aria-label={"Shared task " + t.title}
                >
                  <strong>{t.title}</strong>
                  <small>
                    {t.status.replace("_", " ")} ·{" "}
                    {t.assignee ? "assigned to " + t.assignee : "unassigned"} ·{" "}
                    {t.commentCount}{" "}
                    {t.commentCount === 1 ? "comment" : "comments"}
                  </small>
                </button>
              </li>
            ))}
            {!tasks.length ? (
              <li className="muted team-empty">Nothing shared yet.</li>
            ) : null}
          </ul>
        </>
      )}
      {error ? (
        <p className="team-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
