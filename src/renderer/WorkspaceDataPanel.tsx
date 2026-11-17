import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Session, Snapshot } from "../shared/contracts";

/** Local owner only: explicit data maintenance, without touching running processes. */
export function WorkspaceDataPanel({
  snapshot,
  onClose,
}: {
  snapshot: Snapshot;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [taskId, setTaskId] = useState("");
  const [noteId, setNoteId] = useState("");
  const projects = new Set(
    snapshot.projects.filter((p) => !p.hostId).map((p) => p.id),
  );
  const tasks = snapshot.tasks.filter((t) => projects.has(t.projectId));
  const notes = snapshot.notes.filter(
    (n) => projects.has(n.projectId) && n.archived,
  );
  const load = useCallback(async (offset = 0) => {
    const page = await window.workspace.invoke<{
      sessions: Session[];
      total: number;
    }>("history.list", { offset, limit: 100 });
    setHistory((current) =>
      offset ? [...current, ...page.sessions] : page.sessions,
    );
    setTotal(page.total);
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Workspace data"
      >
        <header>
          <h2>Workspace data</h2>
          <button
            className="icon-button"
            aria-label="Close workspace data"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <p>
          A private database backup is saved daily. The newest seven daily
          copies are kept.
        </p>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const saved = await window.workspace.invoke<{ path: string }>(
                "backup.export",
              );
              setNotice(`Backup exported to ${saved.path}`);
            })
          }
        >
          Export backup
        </button>
        <p>
          Ended sessions older than 30 days move out of the active workspace.
          Their history remains available here.
        </p>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const result = await window.workspace.invoke<{
                archived: number;
              }>("history.prune");
              await load();
              setNotice(`${result.archived} ended sessions archived.`);
            })
          }
        >
          Archive old ended sessions
        </button>
        <p>{total} archived sessions</p>
        <div style={{ maxHeight: 180, overflow: "auto" }}>
          {history.map((s) => (
            <div key={s.id}>
              <span>
                {s.title || s.provider} · {s.cwd}
              </span>{" "}
              <button
                className="button small"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await window.workspace.invoke("history.restore", {
                      sessionId: s.id,
                    });
                    await load();
                  })
                }
              >
                Restore to workspace
              </button>
            </div>
          ))}
        </div>
        {history.length < total ? (
          <button
            disabled={busy}
            onClick={() => void act(() => load(history.length))}
          >
            Load more history
          </button>
        ) : null}
        <label>
          Task to delete
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">Choose a task</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          disabled={busy || !tasks.some((t) => t.id === taskId)}
          onClick={() => {
            const task = tasks.find((t) => t.id === taskId);
            if (!task) return;
            if (
              !confirm(
                `Permanently delete task “${task.title}”? Its ended sessions are kept. Export a backup first if you need a copy.`,
              )
            )
              return;
            void act(async () => {
              await window.workspace.invoke("task.delete", {
                taskId,
                revision: task.revision,
              });
              setTaskId("");
              setNotice("Task deleted.");
            });
          }}
        >
          Delete selected task…
        </button>
        <label>
          Archived note to delete
          <select value={noteId} onChange={(e) => setNoteId(e.target.value)}>
            <option value="">Choose an archived note</option>
            {notes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          disabled={busy || !notes.some((n) => n.id === noteId)}
          onClick={() => {
            const note = notes.find((n) => n.id === noteId);
            if (!note) return;
            if (
              !confirm(
                `Permanently delete archived note “${note.title}”? Export a backup first if you need a copy.`,
              )
            )
              return;
            void act(async () => {
              await window.workspace.invoke("note.delete", {
                noteId,
                revision: note.revision ?? 1,
              });
              setNoteId("");
              setNotice("Note deleted.");
            });
          }}
        >
          Delete selected note…
        </button>
        {notice ? (
          <p role="status" style={{ overflowWrap: "anywhere" }}>
            {notice}
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
