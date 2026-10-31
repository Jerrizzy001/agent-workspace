import { useCallback, useEffect, useState } from "react";
// Styles: team.css, imported by TeamPanel and TaskTeam (kept out so tests can render this module).
import { LoaderCircle, MessageSquare, Pencil, RotateCcw, Trash2, UserRound, X } from "lucide-react";
import type { CommentView, TeamOutboxItem, TeamTaskDetail } from "../shared/team-contracts";
import { errorText } from "./sessions";

/** A comment body: plain text only, never HTML, links or mentions. */
export function CommentBody({ body }: { body: string }) {
  return <p className="team-comment-body">{body}</p>;
}

export function CommentItem({
  comment,
  canEdit,
  canDelete,
  busy,
  onEdit,
  onDelete,
}: {
  comment: CommentView & { pending?: boolean; mine?: boolean };
  canEdit: boolean;
  canDelete: boolean;
  busy?: boolean;
  onEdit?: (body: string) => void;
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <li className={"team-comment" + (comment.pending ? " pending" : "")} aria-label={"Comment by " + comment.authorName}>
      <header>
        <strong>{comment.authorName}</strong>
        <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
        {comment.revision > 1 ? <em>edited</em> : null}
        {comment.pending ? <span className="team-chip pending">Not sent yet</span> : null}
        {!comment.pending && (canEdit || canDelete) && editing === null ? (
          <span className="team-comment-actions">
            {canEdit ? (
              <button className="icon-button" aria-label="Edit comment" disabled={busy} onClick={() => setEditing(comment.body)}>
                <Pencil size={12} />
              </button>
            ) : null}
            {canDelete ? (
              <button
                className="icon-button"
                aria-label="Delete comment"
                disabled={busy}
                onClick={() => {
                  if (confirm("Delete this comment for everyone on the team?")) onDelete?.();
                }}
              >
                <Trash2 size={12} />
              </button>
            ) : null}
          </span>
        ) : null}
      </header>
      {editing !== null ? (
        <form
          className="team-comment-edit"
          onSubmit={(e) => {
            e.preventDefault();
            onEdit?.(editing);
            setEditing(null);
          }}
        >
          <textarea aria-label="Edit comment text" value={editing} maxLength={4000} onChange={(e) => setEditing(e.target.value)} />
          <div>
            <button className="button small primary" disabled={!editing.trim() || busy}>Save</button>
            <button type="button" className="button small ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <CommentBody body={comment.body} />
      )}
    </li>
  );
}

export function OutboxRow({ item, onResolve }: { item: TeamOutboxItem; onResolve: (choice: "retry" | "discard") => void }) {
  return (
    <div className={"team-outbox-row " + item.state} role={item.state === "conflict" || item.state === "failed" ? "alert" : undefined}>
      <span className={"team-chip " + item.state}>
        {item.state === "conflict" ? "Conflict" : item.state === "failed" ? "Not accepted" : item.state === "sending" ? "Sending" : "Waiting to send"}
      </span>
      <span>{item.summary}</span>
      {item.error ? <small>{item.error}</small> : null}
      {item.state === "conflict" || item.state === "failed" ? (
        <span className="team-outbox-actions">
          {item.state === "conflict" ? (
            <button className="button small" onClick={() => onResolve("retry")}>
              <RotateCcw size={12} /> Apply to latest
            </button>
          ) : null}
          <button className="button small ghost" onClick={() => onResolve("discard")}>
            <X size={12} /> Discard
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** Comments and assignee for one shared task. Assignment is coordination only; it never grants process rights. */
export function TeamTaskThread({ sharedTaskId }: { sharedTaskId: string }) {
  const api = window.workspace.team!;
  const [detail, setDetail] = useState<TeamTaskDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api
      .taskDetail({ sharedTaskId })
      .then((d) => {
        setDetail(d);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  }, [sharedTaskId]);
  useEffect(() => {
    load();
    return api.onChange(load);
  }, [load]);
  async function run(fn: () => Promise<TeamTaskDetail | unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      if (result && typeof result === "object" && "comments" in (result as object)) setDetail(result as TeamTaskDetail);
      else load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <section className="team-thread" aria-label="Team comments">
        {error ? <p className="team-error">{error}</p> : <p className="muted">Loading team comments…</p>}
      </section>
    );
  const admin = detail.role === "admin";
  const canComment = detail.role === "admin" || detail.role === "member";
  const assignable = detail.members.filter((m) => m.status === "active" && m.role !== "viewer");
  const assignee = detail.assignment.memberId;
  const choices = admin ? assignable : assignable.filter((m) => m.memberId === detail.meMemberId);
  const canChangeAssignee = admin || (detail.role === "member" && (!assignee || assignee === detail.meMemberId));
  return (
    <section className="team-thread" aria-label="Team comments">
      <div className="team-assignee">
        <UserRound size={14} aria-hidden="true" />
        <label>
          Assignee
          <select
            aria-label="Assignee"
            value={assignee ?? ""}
            disabled={busy || !canChangeAssignee}
            onChange={(e) => void run(() => api.assign({ sharedTaskId, memberId: e.target.value || null }))}
          >
            <option value="">Unassigned</option>
            {assignee && !choices.some((m) => m.memberId === assignee) ? (
              <option value={assignee}>{detail.assignment.memberName}</option>
            ) : null}
            {choices.map((m) => (
              <option key={m.memberId} value={m.memberId}>
                {m.name}
                {m.memberId === detail.meMemberId ? " (you)" : ""}
              </option>
            ))}
          </select>
        </label>
        <small className="muted">Coordination only: an assignee gets no access to anyone's terminals or files.</small>
      </div>
      {detail.outbox.map((o) => (
        <OutboxRow key={o.mutationId} item={o} onResolve={(choice) => void run(() => api.resolve({ mutationId: o.mutationId, choice }))} />
      ))}
      <h4 className="team-thread-title">
        <MessageSquare size={13} aria-hidden="true" /> Comments <span className="muted">{detail.comments.length}</span>
      </h4>
      <ul className="team-comments">
        {detail.comments.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            busy={busy}
            canEdit={c.mine && canComment}
            canDelete={(c.mine && canComment) || admin}
            onEdit={(body) => void run(() => api.editComment({ commentId: c.id, body }))}
            onDelete={() => void run(() => api.deleteComment({ commentId: c.id }))}
          />
        ))}
        {!detail.comments.length ? <li className="muted team-empty">No comments yet.</li> : null}
      </ul>
      {canComment ? (
        <form
          className="team-comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            const body = draft;
            setDraft("");
            void run(() => api.addComment({ sharedTaskId, body }));
          }}
        >
          <textarea
            aria-label="New comment"
            placeholder="Comment for the team (plain text)"
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="button small primary" disabled={busy || !draft.trim()}>
            {busy ? <LoaderCircle size={12} className="spin" /> : null}
            Comment
          </button>
        </form>
      ) : (
        <p className="muted">Viewers can read comments but not write them.</p>
      )}
      {error ? <p className="team-error" role="alert">{error}</p> : null}
    </section>
  );
}
