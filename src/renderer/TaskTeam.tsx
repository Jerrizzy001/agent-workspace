import { useCallback, useEffect, useState } from "react";
import {
  CloudUpload,
  LoaderCircle,
  MessageSquare,
  UserRound,
  X,
} from "lucide-react";
import type { Task } from "../shared/contracts";
import type {
  TeamBoardEntry,
  TeamStatus,
  TeamSyncState,
  TeamTaskPreview,
} from "../shared/team-contracts";
import { errorText } from "./sessions";
import { TeamTaskThread } from "./TaskComments";

export const syncLabel = (s: TeamSyncState) =>
  s === "synced"
    ? "Shared"
    : s === "pending"
      ? "Sending…"
      : s === "conflict"
        ? "Conflict"
        : s === "local-changes"
          ? "Local edits not shared"
          : s === "revoked"
            ? "Access ended"
            : "Offline";

/** Team metadata for this folder's local tasks (assignee, comment count, sync state). */
export function useTeamBoard(projectId: string | undefined, tasks: Task[]) {
  const [entries, setEntries] = useState<Record<string, TeamBoardEntry>>({});
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const key = tasks.map((t) => t.id + ":" + t.revision).join(",");
  const load = useCallback(() => {
    const api = window.workspace.team;
    if (!api || !projectId) return;
    void api
      .boardInfo({ projectId })
      .then(setEntries)
      .catch(() => setEntries({}));
    void api
      .status()
      .then(setStatus)
      .catch(() => {});
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load, key]);
  useEffect(() => window.workspace.team?.onChange(load), [load]);
  return { entries, status, reload: load };
}

export function TeamCardMeta({
  entry,
  offline,
}: {
  entry?: TeamBoardEntry;
  offline?: boolean;
}) {
  if (!entry) return null;
  const sync = offline && entry.sync === "synced" ? "offline" : entry.sync;
  return (
    <div className="team-card-meta" aria-label="Team">
      <span className={"team-chip " + sync}>{syncLabel(sync)}</span>
      <span title="Assignee">
        <UserRound size={11} aria-hidden="true" />{" "}
        {entry.assignee ?? "Unassigned"}
      </span>
      <span title="Comments" aria-label={entry.commentCount + " comments"}>
        <MessageSquare size={11} aria-hidden="true" /> {entry.commentCount}
      </span>
    </div>
  );
}

/** Shows exactly what would leave this computer before a task is shared. */
export function PublishPreview({
  taskId,
  onClose,
  onPublished,
}: {
  taskId: string;
  onClose: () => void;
  onPublished: () => void;
}) {
  const api = window.workspace.team!;
  const [preview, setPreview] = useState<TeamTaskPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .previewTask({ taskId })
      .then(setPreview)
      .catch((e) => setError(errorText(e)));
  }, [taskId]);
  return (
    <div className="modal-backdrop">
      <section
        className="modal team-panel team-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-preview-title"
      >
        <header>
          <div>
            <div className="eyebrow">Team</div>
            <h2 id="team-preview-title">
              {preview?.sharedTaskId
                ? "Update the shared task"
                : "Share this task with the team"}
            </h2>
            {preview ? (
              <p>
                Sent to {preview.teamProjectName}, readable by everyone in that
                project. Exactly these {preview.bytes} bytes leave this
                computer:
              </p>
            ) : null}
          </div>
          <button
            className="icon-button"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {preview ? (
          <>
            <pre aria-label="Data sent to the team service">{preview.json}</pre>
            <div>
              <strong>Never sent:</strong>
              <ul>
                <li>folder and file paths, file contents and Git data</li>
                <li>
                  first messages, prompts, transcripts and terminal output
                </li>
                <li>attempts, sessions, notes and canvas</li>
              </ul>
            </div>
            <p className="form-hint">
              A description can itself contain secrets. Edit the task first if
              anything above should stay private.
            </p>
          </>
        ) : null}
        {error ? (
          <p className="team-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <button className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!preview || busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api.publishTask({ taskId, hash: preview!.hash });
                onPublished();
              } catch (e) {
                setError(errorText(e));
                api
                  .previewTask({ taskId })
                  .then(setPreview)
                  .catch(() => {});
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <CloudUpload size={14} />
            )}
            {preview?.sharedTaskId ? "Send update" : "Share task"}
          </button>
        </footer>
      </section>
    </div>
  );
}

/** Team section of the task sheet: share, sync state, assignee and comments. */
export function TaskTeamSection({
  task,
  entry,
  status,
  reload,
  report,
}: {
  task: Task;
  entry?: TeamBoardEntry;
  status: TeamStatus | null;
  reload: () => void;
  report: (e: unknown) => void;
}) {
  const [previewing, setPreviewing] = useState(false);
  if (!window.workspace.team || !status?.connected) return null;
  const linked = status.projects.find(
    (p) => p.localProjectId === task.projectId && p.state === "active",
  );
  return (
    <section className="task-team" aria-label="Team">
      <div className="task-team-head">
        <h3 className="section-label">Team</h3>
        {entry ? (
          <span className={"team-chip " + entry.sync}>
            {syncLabel(entry.sync)}
          </span>
        ) : null}
        {linked &&
        linked.role === "admin" &&
        (!entry || entry.sync === "local-changes") ? (
          <button className="button small" onClick={() => setPreviewing(true)}>
            <CloudUpload size={13} />{" "}
            {entry ? "Update shared copy…" : "Share with team…"}
          </button>
        ) : null}
        {entry && linked?.role === "admin" ? (
          <button
            className="button small ghost"
            onClick={async () => {
              if (
                !confirm(
                  "Stop sharing this task? Its comments and assignment are removed for the team; your local task stays.",
                )
              )
                return;
              try {
                await window.workspace.team!.unpublishTask({ taskId: task.id });
                reload();
              } catch (e) {
                report(e);
              }
            }}
          >
            Stop sharing
          </button>
        ) : null}
      </div>
      {!linked ? (
        <p className="muted">
          Publish this folder from the Team panel to share its tasks.
        </p>
      ) : null}
      {entry ? (
        <TeamTaskThread
          key={entry.sharedTaskId}
          sharedTaskId={entry.sharedTaskId}
        />
      ) : null}
      {previewing ? (
        <PublishPreview
          taskId={task.id}
          onClose={() => setPreviewing(false)}
          onPublished={() => {
            setPreviewing(false);
            reload();
          }}
        />
      ) : null}
    </section>
  );
}
