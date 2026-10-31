import type { DatabaseSync } from "node:sqlite";
import type {
  AssignmentView,
  ChangesPage,
  CommentView,
  SharedTaskView,
  TeamBoardEntry,
  TeamLocalProject,
  TeamMemberView,
  TeamOutboxItem,
  TeamProjectSummary,
} from "../shared/team-contracts.js";

/**
 * Local team metadata (schema migration `roadmap_05_team_metadata`): the
 * link to a team service (no tokens), team-project and task mappings, a
 * bounded nonauthoritative cache of shared tasks, comments, assignments and
 * members, an ordered sync cursor per project and a bounded outbox. Reached
 * only from the desktop main process through a trusted channel; it is not a
 * core command, so neither the renderer's generic invoke nor the gateway can
 * call it. Local tasks are never rewritten by it.
 */
export const TEAM_CACHE_LIMIT = 5000;
export const TEAM_OUTBOX_LIMIT = 200;

export const TEAM_METADATA_SQL = `
CREATE TABLE IF NOT EXISTS team_link (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_projects_local (
  team_project_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, team_name TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL, local_project_id TEXT UNIQUE, state TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_task_map (
  local_task_id TEXT PRIMARY KEY, team_project_id TEXT NOT NULL, shared_task_id TEXT NOT NULL UNIQUE,
  local_revision INTEGER NOT NULL, payload_hash TEXT NOT NULL, published_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_cache (
  team_project_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL, value TEXT, sort TEXT NOT NULL, PRIMARY KEY (team_project_id, kind, id));
CREATE INDEX IF NOT EXISTS team_cache_parent ON team_cache(team_project_id, kind, parent);
CREATE TABLE IF NOT EXISTS team_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, mutation_id TEXT NOT NULL UNIQUE, team_project_id TEXT NOT NULL,
  action TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL, target TEXT, state TEXT NOT NULL,
  error TEXT, conflict TEXT, created_at TEXT NOT NULL);
`;

const ID = /^[0-9a-f-]{8,64}$/;
const id = (v: unknown, label: string) => {
  if (typeof v !== "string" || !ID.test(v)) throw new Error(`Invalid ${label}`);
  return v;
};
const localId = (v: unknown, label: string) => {
  if (typeof v !== "string" || !v || v.length > 128 || v.includes("\0")) throw new Error(`Invalid ${label}`);
  return v;
};
const plain = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
function only(p: any, keys: string[]) {
  if (!plain(p) || Object.keys(p).some((k) => !keys.includes(k))) throw new Error("Unexpected team cache field");
  return p as Record<string, any>;
}
const OUTBOX_ACTIONS = [
  "sharedTask.publish",
  "sharedTask.update",
  "sharedTask.remove",
  "comment.create",
  "comment.edit",
  "comment.delete",
  "assignment.set",
  "assignment.clear",
];

export interface TeamCacheHost {
  db: DatabaseSync;
  /** Local task records (never modified here). */
  task(taskId: string): { id: string; projectId: string; revision: number; title: string; description: string; status: string } | null;
  tasks(projectId: string): { id: string; revision: number }[];
  project(projectId: string): { id: string; hostId?: string; name: string } | null;
}

export function createTeamCache({ db, task, tasks, project }: TeamCacheHost) {
  const now = () => new Date().toISOString();
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const link = () => {
    const row = db.prepare("SELECT value FROM team_link WHERE id=1").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  };
  const projects = (): TeamLocalProject[] =>
    (db.prepare("SELECT * FROM team_projects_local ORDER BY team_name, name").all() as any[]).map((r) => ({
      id: r.team_project_id,
      teamId: r.team_id,
      teamName: r.team_name,
      name: r.name,
      role: r.role,
      localProjectId: r.local_project_id,
      state: r.state,
      cursor: r.cursor,
      ...(r.truncated ? { truncated: true } : {}),
    }));
  const projectRow = (teamProjectId: string) =>
    db.prepare("SELECT * FROM team_projects_local WHERE team_project_id=?").get(teamProjectId) as any;
  const outbox = (): TeamOutboxItem[] =>
    (db.prepare("SELECT * FROM team_outbox ORDER BY seq").all() as any[]).map((r) => ({
      mutationId: r.mutation_id,
      projectId: r.team_project_id,
      action: r.action,
      summary: r.summary,
      state: r.state,
      ...(r.error ? { error: r.error } : {}),
      ...(r.target ? { target: r.target } : {}),
      createdAt: r.created_at,
    }));
  /** Removes everything cached for a project; its local tasks stay as they are. */
  function purge(teamProjectId: string) {
    db.prepare("DELETE FROM team_cache WHERE team_project_id=?").run(teamProjectId);
    db.prepare("DELETE FROM team_outbox WHERE team_project_id=?").run(teamProjectId);
    db.prepare("DELETE FROM team_task_map WHERE team_project_id=?").run(teamProjectId);
  }
  function cached<T>(teamProjectId: string, kind: string): T[] {
    return (
      db
        .prepare("SELECT value FROM team_cache WHERE team_project_id=? AND kind=? AND deleted=0 ORDER BY sort")
        .all(teamProjectId, kind) as any[]
    ).map((r) => JSON.parse(r.value));
  }
  /** Applies one ordered page. Stale or out-of-order pages, revoked projects and resurrections are ignored. */
  function apply(teamProjectId: string, after: number, page: ChangesPage) {
    const row = projectRow(teamProjectId);
    if (!row || row.state !== "active") return { applied: 0, ignored: "revoked" };
    if (row.cursor !== after || page.projectId !== teamProjectId) return { applied: 0, ignored: "stale" };
    if (!Number.isSafeInteger(page.cursor) || page.cursor < after || !Array.isArray(page.changes) || page.changes.length > 1000)
      throw new Error("Invalid change page");
    let applied = 0;
    let last = after;
    for (const c of page.changes) {
      if (!plain(c) || !Number.isSafeInteger(c.seq) || c.seq <= last || c.seq > page.cursor) throw new Error("Unordered change page");
      last = c.seq;
      if (!["task", "comment", "assignment", "member"].includes(c.kind)) continue;
      const key = id(c.id, "change ID");
      const existing = db
        .prepare("SELECT revision, deleted FROM team_cache WHERE team_project_id=? AND kind=? AND id=?")
        .get(teamProjectId, c.kind, key) as { revision: number; deleted: number } | undefined;
      const value = c.value as any;
      const deleted = c.deleted || !value;
      const revision = Number.isSafeInteger(value?.revision) ? value.revision : c.seq;
      // Removed tasks and comments never come back from a cache write.
      if (existing?.deleted && (c.kind === "task" || c.kind === "comment" || c.kind === "assignment")) continue;
      if (existing && c.kind !== "member" && revision < existing.revision) continue;
      if (value && (value.projectId ?? teamProjectId) !== teamProjectId) continue;
      const json = deleted ? null : JSON.stringify(value);
      if (json && json.length > 64 * 1024) continue;
      const parent = c.kind === "comment" ? (value?.taskId ?? null) : c.kind === "assignment" ? key : null;
      const sort = c.kind === "comment" ? (value?.createdAt ?? "") + key : c.kind === "member" ? (value?.name ?? "") + key : String(c.seq).padStart(16, "0");
      db.prepare(
        "INSERT OR REPLACE INTO team_cache VALUES (?,?,?,?,?,?,?,?)",
      ).run(teamProjectId, c.kind, key, parent, revision, deleted ? 1 : 0, json, sort);
      if (deleted && c.kind === "task") {
        db.prepare("DELETE FROM team_task_map WHERE shared_task_id=?").run(key);
        db.prepare("UPDATE team_cache SET deleted=1, value=NULL WHERE team_project_id=? AND kind='assignment' AND id=?").run(teamProjectId, key);
      }
      applied++;
    }
    const count = (db.prepare("SELECT COUNT(*) AS n FROM team_cache WHERE team_project_id=?").get(teamProjectId) as any).n;
    let truncated = row.truncated;
    if (count > TEAM_CACHE_LIMIT) {
      db.prepare(
        "DELETE FROM team_cache WHERE rowid IN (SELECT rowid FROM team_cache WHERE team_project_id=? AND kind='comment' AND deleted=0 ORDER BY sort LIMIT ?)",
      ).run(teamProjectId, count - TEAM_CACHE_LIMIT);
      truncated = 1;
    }
    db.prepare("UPDATE team_projects_local SET cursor=?, role=?, truncated=?, updated_at=? WHERE team_project_id=?").run(
      page.cursor,
      ["admin", "member", "viewer"].includes(page.role) ? page.role : row.role,
      truncated,
      now(),
      teamProjectId,
    );
    return { applied, cursor: page.cursor };
  }
  function commentCount(teamProjectId: string, sharedTaskId: string) {
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM team_cache WHERE team_project_id=? AND kind='comment' AND parent=? AND deleted=0")
        .get(teamProjectId, sharedTaskId) as any
    ).n;
    const pending = (
      db
        .prepare("SELECT COUNT(*) AS n FROM team_outbox WHERE team_project_id=? AND action='comment.create' AND target=?")
        .get(teamProjectId, sharedTaskId) as any
    ).n;
    return n + pending;
  }
  const assignment = (teamProjectId: string, sharedTaskId: string): AssignmentView => {
    const row = db
      .prepare("SELECT value FROM team_cache WHERE team_project_id=? AND kind='assignment' AND id=? AND deleted=0")
      .get(teamProjectId, sharedTaskId) as any;
    return row ? JSON.parse(row.value) : { taskId: sharedTaskId, memberId: null, memberName: "", revision: 0 };
  };
  const sharedTask = (sharedTaskId: string) => {
    const row = db.prepare("SELECT team_project_id, value, deleted FROM team_cache WHERE kind='task' AND id=?").get(sharedTaskId) as any;
    return row && !row.deleted ? { teamProjectId: row.team_project_id as string, task: JSON.parse(row.value) as SharedTaskView } : null;
  };

  const actions: Record<string, (p: any) => unknown> = {
    state: (p) => {
      only(p, []);
      return { link: link(), projects: projects(), outbox: outbox() };
    },
    setLink: (p) => {
      only(p, ["link"]);
      if (p.link === null)
        return tx(() => {
          db.exec("DELETE FROM team_link; DELETE FROM team_projects_local; DELETE FROM team_task_map; DELETE FROM team_cache; DELETE FROM team_outbox;");
          return { ok: true };
        });
      const l = only(p.link, ["serviceUrl", "identity", "teams", "connectedAt", "lastSyncAt"]);
      only(l.identity, ["issuer", "subject", "name", "email"]);
      if (typeof l.serviceUrl !== "string" || !Array.isArray(l.teams) || JSON.stringify(l).length > 64 * 1024)
        throw new Error("Invalid team link");
      const previous = link();
      return tx(() => {
        // A different service or person starts from an empty cache.
        if (previous && (previous.serviceUrl !== l.serviceUrl || previous.identity?.subject !== l.identity.subject || previous.identity?.issuer !== l.identity.issuer))
          db.exec("DELETE FROM team_projects_local; DELETE FROM team_task_map; DELETE FROM team_cache; DELETE FROM team_outbox;");
        db.prepare("INSERT OR REPLACE INTO team_link VALUES (1, ?)").run(JSON.stringify(l));
        return { ok: true };
      });
    },
    setProjects: (p) => {
      only(p, ["projects"]);
      if (!Array.isArray(p.projects) || p.projects.length > 500) throw new Error("Invalid team projects");
      const incoming = p.projects as TeamProjectSummary[];
      for (const pr of incoming) {
        only(pr, ["id", "teamId", "teamName", "name", "role"]);
        id(pr.id, "team project");
        id(pr.teamId, "team");
        if (!["admin", "member", "viewer"].includes(pr.role)) throw new Error("Invalid role");
      }
      return tx(() => {
        const revoked: string[] = [];
        for (const r of db.prepare("SELECT team_project_id, state FROM team_projects_local").all() as any[])
          if (!incoming.some((pr) => pr.id === r.team_project_id) && r.state !== "revoked") {
            // Access ended: purge this project's cache, outbox and task links.
            purge(r.team_project_id);
            db.prepare("UPDATE team_projects_local SET state='revoked', cursor=0, truncated=0, updated_at=? WHERE team_project_id=?").run(now(), r.team_project_id);
            revoked.push(r.team_project_id);
          }
        for (const pr of incoming) {
          const existing = projectRow(pr.id);
          if (existing)
            db.prepare(
              "UPDATE team_projects_local SET team_name=?, name=?, role=?, state='active', cursor=CASE WHEN state='revoked' THEN 0 ELSE cursor END, updated_at=? WHERE team_project_id=?",
            ).run(String(pr.teamName).slice(0, 200), String(pr.name).slice(0, 200), pr.role, now(), pr.id);
          else
            db.prepare("INSERT INTO team_projects_local VALUES (?,?,?,?,?,NULL,'active',0,0,?)").run(
              pr.id, pr.teamId, String(pr.teamName).slice(0, 200), String(pr.name).slice(0, 200), pr.role, now(),
            );
        }
        return { revoked };
      });
    },
    linkProject: (p) => {
      only(p, ["teamProjectId", "localProjectId"]);
      const teamProjectId = id(p.teamProjectId, "team project");
      const row = projectRow(teamProjectId);
      if (!row || row.state !== "active") throw new Error("That team project is not available");
      if (p.localProjectId === null) {
        db.prepare("UPDATE team_projects_local SET local_project_id=NULL WHERE team_project_id=?").run(teamProjectId);
        return { ok: true };
      }
      const local = project(localId(p.localProjectId, "project"));
      if (!local) throw new Error("Folder not found");
      if (local.hostId) throw new Error("Team publishing is available for folders on this computer only");
      const other = db.prepare("SELECT team_project_id FROM team_projects_local WHERE local_project_id=?").get(local.id) as any;
      if (other && other.team_project_id !== teamProjectId) throw new Error("This folder is already published to another team project");
      db.prepare("UPDATE team_projects_local SET local_project_id=? WHERE team_project_id=?").run(local.id, teamProjectId);
      return { ok: true };
    },
    apply: (p) => {
      only(p, ["teamProjectId", "after", "page"]);
      return tx(() => apply(id(p.teamProjectId, "team project"), p.after, p.page));
    },
    purge: (p) => {
      only(p, ["teamProjectId"]);
      const teamProjectId = id(p.teamProjectId, "team project");
      return tx(() => {
        purge(teamProjectId);
        db.prepare("UPDATE team_projects_local SET state='revoked', cursor=0 WHERE team_project_id=?").run(teamProjectId);
        return { ok: true };
      });
    },
    cache: (p) => {
      only(p, ["teamProjectId"]);
      const teamProjectId = id(p.teamProjectId, "team project");
      return {
        tasks: cached<SharedTaskView>(teamProjectId, "task"),
        comments: cached<CommentView>(teamProjectId, "comment"),
        assignments: cached<AssignmentView>(teamProjectId, "assignment"),
        members: cached<TeamMemberView>(teamProjectId, "member"),
      };
    },
    sharedTasks: (p) => {
      only(p, ["teamProjectId"]);
      const teamProjectId = id(p.teamProjectId, "team project");
      return cached<SharedTaskView>(teamProjectId, "task").map((t) => {
        const a = assignment(teamProjectId, t.id);
        return { ...t, assignee: a.memberId ? a.memberName : null, commentCount: commentCount(teamProjectId, t.id) };
      });
    },
    task: (p) => {
      only(p, ["sharedTaskId"]);
      const found = sharedTask(id(p.sharedTaskId, "shared task"));
      if (!found) return null;
      const comments = (
        db
          .prepare("SELECT value FROM team_cache WHERE team_project_id=? AND kind='comment' AND parent=? ORDER BY sort")
          .all(found.teamProjectId, found.task.id) as any[]
      )
        .filter((r) => r.value)
        .map((r) => JSON.parse(r.value) as CommentView);
      const row = projectRow(found.teamProjectId);
      return {
        teamProjectId: found.teamProjectId,
        role: row?.role,
        task: found.task,
        comments,
        assignment: assignment(found.teamProjectId, found.task.id),
        members: cached<TeamMemberView>(found.teamProjectId, "member"),
        outbox: outbox().filter((o) => o.projectId === found.teamProjectId),
      };
    },
    comment: (p) => {
      only(p, ["commentId"]);
      const row = db.prepare("SELECT team_project_id, value FROM team_cache WHERE kind='comment' AND id=? AND deleted=0").get(id(p.commentId, "comment")) as any;
      return row ? { teamProjectId: row.team_project_id, comment: JSON.parse(row.value) } : null;
    },
    localTask: (p) => {
      only(p, ["taskId"]);
      const t = task(localId(p.taskId, "task"));
      if (!t) throw new Error("Task not found");
      const map = db.prepare("SELECT * FROM team_task_map WHERE local_task_id=?").get(t.id) as any;
      const linked = db.prepare("SELECT * FROM team_projects_local WHERE local_project_id=? AND state='active'").get(t.projectId) as any;
      return {
        task: t,
        map: map ?? null,
        teamProject: linked ? { id: linked.team_project_id, name: linked.name, role: linked.role } : null,
        remote: map ? (sharedTask(map.shared_task_id)?.task ?? null) : null,
      };
    },
    mapTask: (p) => {
      only(p, ["localTaskId", "teamProjectId", "sharedTaskId", "localRevision", "payloadHash"]);
      const t = task(localId(p.localTaskId, "task"));
      if (!t) throw new Error("Task not found");
      if (!Number.isSafeInteger(p.localRevision) || typeof p.payloadHash !== "string" || p.payloadHash.length > 128)
        throw new Error("Invalid task mapping");
      db.prepare("INSERT OR REPLACE INTO team_task_map VALUES (?,?,?,?,?,?)").run(
        t.id, id(p.teamProjectId, "team project"), id(p.sharedTaskId, "shared task"), p.localRevision, p.payloadHash, now(),
      );
      return { ok: true };
    },
    unmapTask: (p) => {
      only(p, ["localTaskId"]);
      db.prepare("DELETE FROM team_task_map WHERE local_task_id=?").run(localId(p.localTaskId, "task"));
      return { ok: true };
    },
    taskMaps: (p) => {
      only(p, ["teamProjectId"]);
      return db.prepare("SELECT * FROM team_task_map WHERE team_project_id=?").all(id(p.teamProjectId, "team project"));
    },
    outboxAdd: (p) => {
      only(p, ["mutationId", "teamProjectId", "action", "payload", "summary", "target"]);
      const teamProjectId = id(p.teamProjectId, "team project");
      const row = projectRow(teamProjectId);
      if (!row || row.state !== "active") throw new Error("You no longer have access to that team project");
      if (!OUTBOX_ACTIONS.includes(p.action)) throw new Error("Only team metadata changes can be queued");
      const payload = JSON.stringify(p.payload ?? {});
      if (payload.length > 32 * 1024) throw new Error("Change is too large");
      const n = (db.prepare("SELECT COUNT(*) AS n FROM team_outbox").get() as any).n;
      if (n >= TEAM_OUTBOX_LIMIT) throw new Error("Too many unsent team changes. Reconnect to send them, or discard some.");
      db.prepare("INSERT INTO team_outbox (mutation_id, team_project_id, action, payload, summary, target, state, created_at) VALUES (?,?,?,?,?,?,'pending',?)").run(
        id(p.mutationId, "mutation"), teamProjectId, p.action, payload, String(p.summary ?? "").slice(0, 200), p.target ? id(p.target, "target") : null, now(),
      );
      return outbox();
    },
    outboxPending: (p) => {
      only(p, []);
      return (db.prepare("SELECT * FROM team_outbox WHERE state IN ('pending','sending') ORDER BY seq").all() as any[]).map((r) => ({
        mutationId: r.mutation_id,
        teamProjectId: r.team_project_id,
        action: r.action,
        payload: JSON.parse(r.payload),
        target: r.target,
      }));
    },
    outboxItem: (p) => {
      only(p, ["mutationId"]);
      const r = db.prepare("SELECT * FROM team_outbox WHERE mutation_id=?").get(id(p.mutationId, "mutation")) as any;
      return r ? { mutationId: r.mutation_id, teamProjectId: r.team_project_id, action: r.action, payload: JSON.parse(r.payload), target: r.target, state: r.state, summary: r.summary } : null;
    },
    outboxUpdate: (p) => {
      only(p, ["mutationId", "state", "error"]);
      if (!["pending", "sending", "conflict", "failed"].includes(p.state)) throw new Error("Invalid outbox state");
      db.prepare("UPDATE team_outbox SET state=?, error=? WHERE mutation_id=?").run(p.state, p.error ? String(p.error).slice(0, 300) : null, id(p.mutationId, "mutation"));
      return { ok: true };
    },
    outboxRemove: (p) => {
      only(p, ["mutationId"]);
      db.prepare("DELETE FROM team_outbox WHERE mutation_id=?").run(id(p.mutationId, "mutation"));
      return { ok: true };
    },
    boardInfo: (p) => {
      only(p, ["projectId"]);
      const projectId = localId(p.projectId, "project");
      const linked = db.prepare("SELECT * FROM team_projects_local WHERE local_project_id=?").get(projectId) as any;
      const out: Record<string, TeamBoardEntry> = {};
      if (!linked) return out;
      const box = outbox();
      for (const t of tasks(projectId)) {
        const map = db.prepare("SELECT * FROM team_task_map WHERE local_task_id=?").get(t.id) as any;
        if (!map) continue;
        const a = assignment(linked.team_project_id, map.shared_task_id);
        const related = box.filter((o) => o.target === map.shared_task_id || o.target === t.id);
        out[t.id] = {
          sharedTaskId: map.shared_task_id,
          teamProjectId: linked.team_project_id,
          assignee: a.memberId ? a.memberName : null,
          commentCount: commentCount(linked.team_project_id, map.shared_task_id),
          sync:
            linked.state !== "active"
              ? "revoked"
              : related.some((o) => o.state === "conflict" || o.state === "failed")
                ? "conflict"
                : related.length
                  ? "pending"
                  : t.revision !== map.local_revision
                    ? "local-changes"
                    : "synced",
        };
      }
      return out;
    },
  };
  return (action: unknown, payload: unknown = {}) => {
    if (typeof action !== "string" || !Object.hasOwn(actions, action)) throw new Error("Unsupported team cache action");
    return actions[action]!(payload);
  };
}
