import type { DatabaseSync } from "node:sqlite";

type Records = {
  list(kind: string): any[];
  get(kind: string, key: unknown): any;
  put(kind: string, value: any): unknown;
  remove(kind: string, key: string): unknown;
};
export function createRetention(db: DatabaseSync, records: Records) {
  const { list, get, put, remove } = records;
  function transaction<T>(work: () => T) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function forgetPositions(projectId: string, ids: string[]) {
    const layout = list("layouts").find((l) => l.projectId === projectId);
    if (!layout) return;
    for (const id of ids) delete layout.positions[id];
    layout.revision = (layout.revision ?? 1) + 1;
    put("layouts", layout);
  }
  return {
    prune(before = new Date(Date.now() - 30 * 86_400_000).toISOString()) {
      const cutoff = Date.parse(before);
      if (!Number.isFinite(cutoff) || cutoff > Date.now())
        throw new Error("Invalid history cutoff");
      return transaction(() => {
        let archived = 0;
        for (const session of list("sessions")) {
          if (
            session.status !== "exited" ||
            session.historyArchived ||
            Date.parse(
              session.historyRestoredAt ?? session.endedAt ?? session.createdAt,
            ) >= cutoff
          )
            continue;
          session.historyArchived = true;
          put("sessions", session);
          archived++;
        }
        return { archived };
      });
    },
    history(offset: unknown = 0, limit: unknown = 100) {
      if (
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0 ||
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 500
      )
        throw new Error("Invalid history page");
      const all = list("sessions").filter((s) => s.historyArchived);
      return {
        sessions: all.slice(Number(offset), Number(offset) + Number(limit)),
        total: all.length,
      };
    },
    restore(sessionId: unknown) {
      const session = get("sessions", sessionId);
      delete session.historyArchived;
      session.historyRestoredAt = new Date().toISOString();
      put("sessions", session);
      return session;
    },
    deleteNote(noteId: unknown, revision: unknown) {
      const note = get("notes", noteId);
      if (revision !== (note.revision ?? 1))
        throw new Error("Stale note revision");
      if (!note.archived)
        throw new Error("Archive the note before deleting it");
      return transaction(() => {
        remove("notes", note.id);
        forgetPositions(note.projectId, [note.id]);
        return { ok: true };
      });
    },
    deleteTask(taskId: unknown, revision: unknown) {
      const task = get("tasks", taskId);
      if (revision !== task.revision) throw new Error("Stale task revision");
      if (
        db
          .prepare("SELECT 1 FROM team_task_map WHERE local_task_id=?")
          .get(task.id)
      )
        throw new Error("Unpublish this task from Team before deleting it");
      const attempts = list("attempts").filter((a) => a.taskId === task.id);
      const ids = new Set(attempts.map((a) => a.id));
      const sessions = list("sessions").filter((s) => ids.has(s.attemptId));
      if (sessions.some((s) => s.status !== "exited"))
        throw new Error("End this task's sessions before deleting it");
      return transaction(() => {
        for (const session of sessions) {
          session.attemptId = null;
          put("sessions", session);
        }
        for (const attempt of attempts) remove("attempts", attempt.id);
        forgetPositions(task.projectId, [...ids]);
        remove("tasks", task.id);
        return { ok: true };
      });
    },
  };
}
