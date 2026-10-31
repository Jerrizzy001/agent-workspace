import crypto from "node:crypto";
import {
  TEAM_LIMITS,
  plainText,
  type ChangesPage,
  type MeResult,
  type TeamAction,
} from "../shared/team-contracts.js";
import { TeamClientError } from "./client.js";

/**
 * Client sync engine. Pulls ordered change pages per team project into the
 * local cache, and sends queued comment and assignment changes from a bounded,
 * visible outbox with immutable mutation IDs and optimistic revisions. On
 * every (re)connect it first revalidates access with the service; projects the
 * person can no longer reach are purged before anything queued is sent.
 * Conflicts are kept for the person to resolve, never merged silently.
 */
export type TeamStore = (action: string, payload?: Record<string, unknown>) => Promise<any>;
export interface TeamCaller {
  call<T = any>(action: TeamAction, payload?: Record<string, unknown>): Promise<T>;
}
export interface SyncResult {
  me: MeResult;
  revoked: string[];
  sent: number;
  conflicts: number;
  offline: boolean;
}

export function createTeamSync(options: { client: TeamCaller; store: TeamStore; pageSize?: number }) {
  const { client, store } = options;
  const pageSize = options.pageSize ?? 100;
  let running: Promise<SyncResult> | null = null;

  async function revalidate() {
    const me = await client.call<MeResult>("me");
    const { revoked } = await store("setProjects", { projects: me.projects });
    return { me, revoked: revoked as string[] };
  }

  async function pull(teamProjectId: string) {
    for (let guard = 0; guard < 10_000; guard++) {
      const { projects } = await store("state");
      const row = projects.find((p: any) => p.id === teamProjectId);
      if (!row || row.state !== "active") return;
      let page: ChangesPage;
      try {
        page = await client.call<ChangesPage>("changes.read", { projectId: teamProjectId, after: row.cursor, limit: pageSize });
      } catch (error) {
        if (error instanceof TeamClientError && error.code === "no-access") {
          // Access ended between revalidation and this read: purge now.
          await store("purge", { teamProjectId });
          return;
        }
        throw error;
      }
      await store("apply", { teamProjectId, after: row.cursor, page });
      if (!page.more) return;
    }
  }

  async function flush() {
    let sent = 0;
    let conflicts = 0;
    const pending = (await store("outboxPending")) as {
      mutationId: string;
      teamProjectId: string;
      action: TeamAction;
      payload: Record<string, unknown>;
    }[];
    for (const item of pending) {
      await store("outboxUpdate", { mutationId: item.mutationId, state: "sending" });
      try {
        await client.call(item.action, { ...item.payload, mutationId: item.mutationId });
        await store("outboxRemove", { mutationId: item.mutationId });
        sent++;
      } catch (error) {
        const e = error instanceof TeamClientError ? error : new TeamClientError(0, "offline", String(error));
        if (e.code === "offline" || e.code === "rate-limited" || e.code === "server" || e.status === 401) {
          // Kept as it was; the same mutation ID is sent again later.
          await store("outboxUpdate", { mutationId: item.mutationId, state: "pending", error: e.message });
          if (e.status === 401) throw e;
          return { sent, conflicts, offline: true };
        }
        conflicts++;
        await store("outboxUpdate", {
          mutationId: item.mutationId,
          state: e.code === "conflict" ? "conflict" : "failed",
          error: e.message,
        });
      }
    }
    return { sent, conflicts, offline: false };
  }

  async function syncNow(): Promise<SyncResult> {
    const { me, revoked } = await revalidate();
    let offline = false;
    let sent = 0;
    let conflicts = 0;
    try {
      ({ sent, conflicts, offline } = await flush());
    } finally {
      const { projects } = await store("state");
      for (const p of projects) if (p.state === "active") await pull(p.id);
    }
    return { me, revoked, sent, conflicts, offline };
  }

  async function queue(teamProjectId: string, action: TeamAction, payload: Record<string, unknown>, summary: string, target: string) {
    const mutationId = crypto.randomUUID();
    await store("outboxAdd", { mutationId, teamProjectId, action, payload, summary, target });
    return mutationId;
  }
  async function taskOf(sharedTaskId: string) {
    const detail = await store("task", { sharedTaskId });
    if (!detail) throw new Error("That shared task is not available");
    return detail;
  }

  return {
    revalidate,
    pull,
    flush,
    /** One sync at a time; concurrent callers share it. */
    sync() {
      running ??= syncNow().finally(() => (running = null));
      return running;
    },
    async addComment(sharedTaskId: string, body: string) {
      const text = plainText(body, TEAM_LIMITS.comment, "Comment");
      if (!text) throw new Error("Write a comment first");
      const detail = await taskOf(sharedTaskId);
      return queue(detail.teamProjectId, "comment.create", { taskId: sharedTaskId, body: text }, "Comment", sharedTaskId);
    },
    async editComment(commentId: string, body: string) {
      const text = plainText(body, TEAM_LIMITS.comment, "Comment");
      if (!text) throw new Error("A comment cannot be empty; delete it instead");
      const found = await store("comment", { commentId });
      if (!found) throw new Error("That comment is not available");
      return queue(found.teamProjectId, "comment.edit", { commentId, revision: found.comment.revision, body: text }, "Edit comment", found.comment.taskId);
    },
    async deleteComment(commentId: string) {
      const found = await store("comment", { commentId });
      if (!found) throw new Error("That comment is not available");
      return queue(found.teamProjectId, "comment.delete", { commentId, revision: found.comment.revision }, "Delete comment", found.comment.taskId);
    },
    async assign(sharedTaskId: string, memberId: string | null) {
      const detail = await taskOf(sharedTaskId);
      const revision = detail.assignment.revision;
      return memberId
        ? queue(detail.teamProjectId, "assignment.set", { taskId: sharedTaskId, memberId, revision }, "Assign", sharedTaskId)
        : queue(detail.teamProjectId, "assignment.clear", { taskId: sharedTaskId, revision }, "Unassign", sharedTaskId);
    },
    /** Conflict resolution: discard the change, or send it again against the current revision with a new mutation ID. */
    async resolve(mutationId: string, choice: "retry" | "discard") {
      const item = await store("outboxItem", { mutationId });
      if (!item) throw new Error("That change is no longer queued");
      if (choice === "discard") return store("outboxRemove", { mutationId });
      if (item.state !== "conflict" && item.state !== "failed") throw new Error("Only a conflicted change can be resent");
      const payload = { ...item.payload };
      if (item.action === "comment.edit" || item.action === "comment.delete") {
        const found = await store("comment", { commentId: payload.commentId });
        if (!found) {
          await store("outboxRemove", { mutationId });
          throw new Error("The comment was deleted; your change was discarded");
        }
        payload.revision = found.comment.revision;
      } else if (item.action === "assignment.set" || item.action === "assignment.clear") {
        payload.revision = (await taskOf(String(payload.taskId))).assignment.revision;
      }
      await store("outboxRemove", { mutationId });
      return queue(item.teamProjectId, item.action, payload, item.summary, item.target);
    },
  };
}
export type TeamSync = ReturnType<typeof createTeamSync>;
