import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import {
  TEAM_ACTIONS,
  TEAM_LIMITS,
  TEAM_PROTOCOL,
  plainText,
  type AssignmentView,
  type ChangesPage,
  type CommentView,
  type MeResult,
  type ProjectRole,
  type SharedTaskView,
  type TeamAction,
  type TeamIdentity,
  type TeamMemberView,
  type TeamRole,
} from "../shared/team-contracts.js";
import {
  TeamError,
  UUID,
  activeMember,
  can,
  canAssign,
  canGrant,
  forbidden,
  noAccess,
  projectAccess,
  teamAccess,
  type Identity,
  type MemberRow,
  type ProjectAccess,
} from "./authorization.js";
import {
  checkClientRedirect,
  createLoginTransactions,
  createOidc,
  createSessions,
  hashSecret,
  isLoopback,
  randomSecret,
  redirectShape,
  type OidcSettings,
} from "./auth.js";
import { openTeamStore, transaction } from "./store.js";

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const STATUSES = ["backlog", "ready", "in_progress", "review", "done"];

function fields(p: any, allowed: string[]) {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new TeamError(400, "invalid", "Invalid request");
  for (const k of Object.keys(p))
    if (!allowed.includes(k)) throw new TeamError(400, "invalid", `Unexpected field ${k}`);
  return p as Record<string, any>;
}
function id(v: unknown, label: string) {
  if (typeof v !== "string" || !UUID.test(v)) throw new TeamError(400, "invalid", `Invalid ${label}`);
  return v;
}
function revision(v: unknown) {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new TeamError(400, "invalid", "Invalid revision");
  return v as number;
}
function text(v: unknown, max: number, label: string, multiline = true, required = false) {
  try {
    const t = plainText(v ?? "", max, label, multiline);
    if (required && !t) throw new Error(`${label} is required`);
    return t;
  } catch (error) {
    throw new TeamError(400, "invalid", (error as Error).message);
  }
}

/** Fixed-window limits per caller and action group. */
export interface RateLimits {
  comment: number;
  invite: number;
  auth: number;
  call: number;
}
const DEFAULT_LIMITS: RateLimits = { comment: 30, invite: 20, auth: 30, call: 600 };
const WINDOWS: Record<keyof RateLimits, number> = { comment: 60_000, invite: 3_600_000, auth: 60_000, call: 60_000 };
function rateLimiter(limits: RateLimits) {
  const buckets = new Map<string, { count: number; reset: number }>();
  return (group: keyof RateLimits, key: string) => {
    const at = Date.now();
    const k = group + "\0" + key;
    let b = buckets.get(k);
    if (!b || b.reset <= at) {
      if (buckets.size > 50_000) buckets.clear();
      b = { count: 0, reset: at + WINDOWS[group] };
      buckets.set(k, b);
    }
    if (++b.count > limits[group])
      throw new TeamError(429, "rate-limited", "Too many requests; wait a moment and try again");
  };
}

export interface TeamAppOptions {
  db: DatabaseSync;
  /** Called after authentication and before the authorizing transaction (tests: remove-during-request). */
  beforeTransaction?: (who: Identity, action: string) => Promise<void> | void;
  limits?: Partial<RateLimits>;
}

/** Team logic over the service store. Every call re-reads membership inside its own transaction. */
export function createTeamApp(options: TeamAppOptions) {
  const { db } = options;
  const limit = rateLimiter({ ...DEFAULT_LIMITS, ...options.limits });

  const change = (projectId: string, kind: string, entityId: string) =>
    db.prepare("INSERT INTO changes (project_id, kind, entity_id, at) VALUES (?,?,?,?)").run(projectId, kind, entityId, now());
  const audit = (teamId: string, actorId: string | null, action: string, target: string, detail: object = {}) =>
    db
      .prepare("INSERT INTO audit (team_id, actor_id, action, target, detail, at) VALUES (?,?,?,?,?,?)")
      .run(teamId, actorId, action, target, JSON.stringify(detail), now());

  function taskRow(taskId: unknown) {
    if (typeof taskId !== "string" || !UUID.test(taskId)) throw noAccess();
    const row = db.prepare("SELECT * FROM shared_tasks WHERE id=?").get(taskId) as any;
    if (!row) throw noAccess();
    return row;
  }
  /** A task the caller can reach in its own project; deleted tasks are not writable. */
  function taskAccess(who: Identity, taskId: unknown, writable = true) {
    const row = taskRow(taskId);
    const access = projectAccess(db, who, row.project_id);
    if (writable && row.deleted_at) throw new TeamError(409, "conflict", "This task was removed from the team", taskView(row));
    return { row, access };
  }
  function commentAccess(who: Identity, commentId: unknown) {
    if (typeof commentId !== "string" || !UUID.test(commentId)) throw noAccess();
    const row = db.prepare("SELECT * FROM comments WHERE id=?").get(commentId) as any;
    if (!row) throw noAccess();
    const access = projectAccess(db, who, row.project_id);
    return { row, access };
  }
  const taskView = (r: any): SharedTaskView => ({
    id: r.id,
    projectId: r.project_id,
    title: r.deleted_at ? "" : r.title,
    description: r.deleted_at ? "" : r.description,
    status: r.status,
    revision: r.revision,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    deleted: !!r.deleted_at,
  });
  const memberName = (memberId: string | null) =>
    memberId
      ? ((db.prepare("SELECT name, email FROM members WHERE id=?").get(memberId) as any)?.name || "Member")
      : "";
  const commentView = (r: any): CommentView => ({
    id: r.id,
    taskId: r.task_id,
    authorId: r.author_id,
    authorName: memberName(r.author_id),
    body: r.deleted_at ? "" : r.body,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: !!r.deleted_at,
  });
  function assignmentView(taskId: string): AssignmentView {
    const r = db.prepare("SELECT * FROM assignments WHERE task_id=?").get(taskId) as any;
    return r
      ? { taskId, memberId: r.member_id, memberName: memberName(r.member_id), revision: r.revision }
      : { taskId, memberId: null, memberName: "", revision: 0 };
  }
  function projectMemberView(projectId: string, memberId: string): TeamMemberView | null {
    const m = db.prepare("SELECT * FROM members WHERE id=?").get(memberId) as MemberRow | undefined;
    if (!m) return null;
    const pm = db
      .prepare("SELECT role FROM project_memberships WHERE project_id=? AND member_id=?")
      .get(projectId, memberId) as { role: ProjectRole } | undefined;
    const project = db.prepare("SELECT team_id FROM team_projects WHERE id=?").get(projectId) as any;
    if (!project || m.team_id !== project.team_id) return null;
    if (m.status === "suspended") return null;
    if (m.team_role !== "owner" && !pm) return null;
    return {
      memberId: m.id,
      name: m.name || m.email || "Invited member",
      email: m.email,
      status: m.status,
      teamRole: m.team_role,
      role: m.team_role === "owner" ? "admin" : pm!.role,
    };
  }
  function projectMembers(projectId: string, teamId: string) {
    const rows = db
      .prepare(
        `SELECT DISTINCT m.id FROM members m LEFT JOIN project_memberships pm ON pm.member_id=m.id AND pm.project_id=?
         WHERE m.team_id=? AND m.status!='suspended' AND (m.team_role='owner' OR pm.project_id IS NOT NULL) ORDER BY m.created_at`,
      )
      .all(projectId, teamId) as { id: string }[];
    return rows.map((r) => projectMemberView(projectId, r.id)!).filter(Boolean);
  }
  /** Clears assignments that point at a member in a project (or every team project). */
  function clearAssignmentsOf(memberId: string, projectId: string | null, actorId: string) {
    const rows = db
      .prepare(
        `SELECT a.task_id, t.project_id FROM assignments a JOIN shared_tasks t ON t.id=a.task_id
         WHERE a.member_id=?${projectId ? " AND t.project_id=?" : ""}`,
      )
      .all(...(projectId ? [memberId, projectId] : [memberId])) as any[];
    for (const r of rows) {
      db.prepare("UPDATE assignments SET member_id=NULL, revision=revision+1, assigned_by=?, updated_at=? WHERE task_id=?").run(
        actorId,
        now(),
        r.task_id,
      );
      change(r.project_id, "assignment", r.task_id);
    }
  }

  /** Idempotent mutation: the same mutation ID and request returns the stored result. */
  function mutate<T>(who: Identity, action: string, p: Record<string, any>, fn: () => T): T {
    const mutationId = id(p.mutationId, "mutation ID");
    const { mutationId: _, ...rest } = p;
    const digest = hashSecret(action + "\0" + JSON.stringify(rest, Object.keys(rest).sort()));
    const prior = db
      .prepare("SELECT action, digest, result FROM mutations WHERE issuer=? AND subject=? AND id=?")
      .get(who.issuer, who.subject, mutationId) as any;
    if (prior) {
      if (prior.digest !== digest || prior.action !== action)
        throw new TeamError(409, "mutation-reused", "This mutation ID was already used for a different change");
      return JSON.parse(prior.result);
    }
    const result = fn();
    db.prepare("INSERT INTO mutations VALUES (?,?,?,?,?,?,?)").run(
      who.issuer,
      who.subject,
      mutationId,
      action,
      digest,
      JSON.stringify(result ?? null),
      now(),
    );
    return result;
  }

  function me(who: TeamIdentity): MeResult {
    const teams = db
      .prepare(
        "SELECT m.id AS member_id, m.team_role, t.id, t.name FROM members m JOIN teams t ON t.id=m.team_id WHERE m.issuer=? AND m.subject=? AND m.status='active' ORDER BY t.created_at",
      )
      .all(who.issuer, who.subject) as any[];
    const projects: MeResult["projects"] = [];
    for (const t of teams) {
      const rows = db
        .prepare(
          `SELECT p.id, p.name, pm.role FROM team_projects p LEFT JOIN project_memberships pm ON pm.project_id=p.id AND pm.member_id=?
           WHERE p.team_id=? ORDER BY p.created_at`,
        )
        .all(t.member_id, t.id) as any[];
      for (const r of rows) {
        const role = t.team_role === "owner" ? "admin" : r.role;
        if (role) projects.push({ id: r.id, teamId: t.id, teamName: t.name, name: r.name, role });
      }
    }
    return {
      identity: { issuer: who.issuer, subject: who.subject, name: who.name, email: who.email },
      teams: teams.map((t) => ({ id: t.id, name: t.name, role: t.team_role, memberId: t.member_id })),
      projects,
    };
  }

  /** Redeems an invitation for a signed-in identity, inside the caller's transaction. */
  function redeem(who: TeamIdentity & { emailVerified?: boolean }, codeHash: string) {
    const inv = db.prepare("SELECT * FROM invitations WHERE code_hash=?").get(codeHash) as any;
    const invalid = () => new TeamError(403, "not-invited", "This invitation is invalid, expired or already used");
    if (!inv || inv.revoked_at || inv.redeemed_at || Date.parse(inv.expires_at) <= Date.now()) throw invalid();
    if (inv.email && (inv.email.toLowerCase() !== who.email.toLowerCase() || who.emailVerified === false))
      throw new TeamError(403, "not-invited", "This invitation is for a different email address");
    const existing = db
      .prepare("SELECT * FROM members WHERE team_id=? AND issuer=? AND subject=?")
      .get(inv.team_id, who.issuer, who.subject) as MemberRow | undefined;
    let memberId: string;
    if (existing) {
      memberId = existing.id;
      const role: TeamRole = existing.team_role === "owner" || inv.team_role === "owner" ? "owner" : "member";
      db.prepare("UPDATE members SET status='active', team_role=?, name=?, email=?, updated_at=? WHERE id=?").run(
        role,
        who.name,
        who.email,
        now(),
        memberId,
      );
      if (inv.member_id && inv.member_id !== memberId) {
        db.prepare("DELETE FROM project_memberships WHERE member_id=?").run(inv.member_id);
        db.prepare("UPDATE members SET status='suspended', updated_at=? WHERE id=?").run(now(), inv.member_id);
      }
    } else if (inv.member_id) {
      memberId = inv.member_id;
      db.prepare(
        "UPDATE members SET issuer=?, subject=?, name=?, email=?, status='active', team_role=?, updated_at=? WHERE id=?",
      ).run(who.issuer, who.subject, who.name, who.email, inv.team_role, now(), memberId);
    } else {
      memberId = uuid();
      db.prepare("INSERT INTO members VALUES (?,?,?,?,?,?,?,'active',?,?)").run(
        memberId,
        inv.team_id,
        who.issuer,
        who.subject,
        who.name,
        who.email,
        inv.team_role,
        now(),
        now(),
      );
    }
    if (inv.project_id) {
      db.prepare(
        "INSERT INTO project_memberships VALUES (?,?,?,?) ON CONFLICT(project_id, member_id) DO UPDATE SET role=excluded.role",
      ).run(inv.project_id, memberId, inv.project_role, now());
      change(inv.project_id, "member", memberId);
    }
    db.prepare("UPDATE invitations SET redeemed_at=?, redeemed_by=? WHERE id=?").run(now(), memberId, inv.id);
    audit(inv.team_id, memberId, "invitation.accept", inv.id, { projectId: inv.project_id, role: inv.project_role });
    return { teamId: inv.team_id, memberId };
  }

  function createInvitation(input: {
    teamId: string;
    teamRole: TeamRole;
    projectId: string | null;
    projectRole: ProjectRole | null;
    email: string;
    hours: number;
    createdBy: string | null;
  }) {
    const code = "twi_" + randomSecret(24);
    const invitationId = uuid();
    const expiresAt = new Date(Date.now() + input.hours * 3_600_000).toISOString();
    // A placeholder member shows the pending invitation in member lists. It
    // can never be assigned or act until a person redeems the invitation.
    const memberId = uuid();
    db.prepare("INSERT INTO members VALUES (?,?,NULL,NULL,?,?,?,'invited',?,?)").run(
      memberId,
      input.teamId,
      input.email || "",
      input.email,
      input.teamRole,
      now(),
      now(),
    );
    if (input.projectId) {
      db.prepare("INSERT INTO project_memberships VALUES (?,?,?,?)").run(input.projectId, memberId, input.projectRole, now());
      change(input.projectId, "member", memberId);
    }
    db.prepare("INSERT INTO invitations VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)").run(
      invitationId,
      input.teamId,
      hashSecret(code),
      input.teamRole,
      input.projectId,
      input.projectRole,
      input.email,
      memberId,
      input.createdBy,
      now(),
      expiresAt,
    );
    audit(input.teamId, input.createdBy, "member.invite", invitationId, {
      projectId: input.projectId,
      role: input.projectRole ?? input.teamRole,
    });
    return { invitationId, code, expiresAt };
  }

  const handlers: Record<TeamAction, (who: TeamIdentity, p: any) => unknown> = {
    me: (who, p) => {
      fields(p, []);
      return me(who);
    },
    "project.create": (who, p) => {
      fields(p, ["teamId", "name", "mutationId"]);
      const member = teamAccess(db, who, p.teamId);
      if (member.team_role !== "owner") throw forbidden("create team projects");
      const name = text(p.name, TEAM_LIMITS.name, "Project name", false, true);
      return mutate(who, "project.create", p, () => {
        const projectId = uuid();
        db.prepare("INSERT INTO team_projects VALUES (?,?,?,?,?)").run(projectId, member.team_id, name, member.id, now());
        db.prepare("INSERT INTO project_memberships VALUES (?,?,?,?)").run(projectId, member.id, "admin", now());
        change(projectId, "member", member.id);
        audit(member.team_id, member.id, "project.create", projectId, {});
        return { id: projectId, teamId: member.team_id, name, role: "admin" as const };
      });
    },
    "member.list": (who, p) => {
      fields(p, ["projectId", "teamId"]);
      if (p.projectId) {
        const access = projectAccess(db, who, p.projectId);
        return projectMembers(access.projectId, access.teamId);
      }
      const member = teamAccess(db, who, p.teamId);
      if (member.team_role !== "owner") throw forbidden("list every team member");
      return (db.prepare("SELECT * FROM members WHERE team_id=? ORDER BY created_at").all(member.team_id) as any[]).map(
        (m): TeamMemberView => ({ memberId: m.id, name: m.name || m.email || "Invited member", email: m.email, status: m.status, teamRole: m.team_role }),
      );
    },
    "member.invite": (who, p) => {
      fields(p, ["teamId", "projectId", "role", "teamRole", "email", "hours"]);
      limit("invite", who.issuer + "\0" + who.subject);
      const email = text(p.email, 254, "Email", false);
      if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) throw new TeamError(400, "invalid", "Invalid email");
      const hours = p.hours === undefined ? 72 : Number(p.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) throw new TeamError(400, "invalid", "Invalid expiry");
      if (p.projectId !== undefined) {
        const access = projectAccess(db, who, p.projectId);
        if (!["admin", "member", "viewer"].includes(p.role)) throw new TeamError(400, "invalid", "Invalid role");
        if (!canGrant(access, p.role)) throw forbidden("invite people to this project");
        return createInvitation({
          teamId: access.teamId,
          teamRole: "member",
          projectId: access.projectId,
          projectRole: p.role,
          email,
          hours,
          createdBy: access.member.id,
        });
      }
      const member = teamAccess(db, who, p.teamId);
      if (member.team_role !== "owner") throw forbidden("invite people to the team");
      if (!["owner", "member"].includes(p.teamRole)) throw new TeamError(400, "invalid", "Invalid team role");
      return createInvitation({ teamId: member.team_id, teamRole: p.teamRole, projectId: null, projectRole: null, email, hours, createdBy: member.id });
    },
    "invitation.accept": (who, p) => {
      fields(p, ["code"]);
      if (typeof p.code !== "string" || p.code.length > 100) throw new TeamError(400, "invalid", "Invalid invitation");
      redeem(who, hashSecret(p.code.trim()));
      return me(who);
    },
    "invitation.list": (who, p) => {
      fields(p, ["teamId"]);
      const member = teamAccess(db, who, p.teamId);
      if (member.team_role !== "owner") throw forbidden("list invitations");
      return (db.prepare("SELECT * FROM invitations WHERE team_id=? ORDER BY created_at DESC LIMIT 200").all(member.team_id) as any[]).map((i) => ({
        invitationId: i.id,
        email: i.email,
        projectId: i.project_id,
        role: i.project_role ?? i.team_role,
        expiresAt: i.expires_at,
        state: i.revoked_at ? "revoked" : i.redeemed_at ? "accepted" : Date.parse(i.expires_at) <= Date.now() ? "expired" : "pending",
      }));
    },
    "invitation.revoke": (who, p) => {
      fields(p, ["invitationId"]);
      const inv = db.prepare("SELECT * FROM invitations WHERE id=?").get(id(p.invitationId, "invitation")) as any;
      if (!inv) throw noAccess();
      if (inv.project_id) {
        const access = projectAccess(db, who, inv.project_id);
        if (!can(access.role, "member.manage")) throw forbidden("revoke invitations");
      } else if (teamAccess(db, who, inv.team_id).team_role !== "owner") throw forbidden("revoke invitations");
      if (!inv.redeemed_at && !inv.revoked_at) {
        db.prepare("UPDATE invitations SET revoked_at=? WHERE id=?").run(now(), inv.id);
        if (inv.member_id) {
          db.prepare("DELETE FROM project_memberships WHERE member_id=?").run(inv.member_id);
          db.prepare("UPDATE members SET status='suspended', updated_at=? WHERE id=? AND status='invited'").run(now(), inv.member_id);
          if (inv.project_id) change(inv.project_id, "member", inv.member_id);
        }
        audit(inv.team_id, activeMember(db, who, inv.team_id)?.id ?? null, "invitation.revoke", inv.id);
      }
      return { ok: true };
    },
    "member.setRole": (who, p) => {
      fields(p, ["projectId", "memberId", "role"]);
      const access = projectAccess(db, who, p.projectId);
      if (!["admin", "member", "viewer"].includes(p.role)) throw new TeamError(400, "invalid", "Invalid role");
      if (!canGrant(access, p.role)) throw forbidden("change roles");
      const target = projectMemberView(access.projectId, id(p.memberId, "member"));
      if (!target) throw noAccess();
      if (target.teamRole === "owner") throw new TeamError(400, "invalid", "Team owners are always project admins");
      db.prepare("UPDATE project_memberships SET role=? WHERE project_id=? AND member_id=?").run(p.role, access.projectId, target.memberId);
      if (p.role === "viewer") clearAssignmentsOf(target.memberId, access.projectId, access.member.id);
      change(access.projectId, "member", target.memberId);
      audit(access.teamId, access.member.id, "member.setRole", target.memberId, { projectId: access.projectId, role: p.role });
      return projectMembers(access.projectId, access.teamId);
    },
    "member.remove": (who, p) => {
      fields(p, ["projectId", "teamId", "memberId"]);
      const memberId = id(p.memberId, "member");
      if (p.projectId !== undefined) {
        const access = projectAccess(db, who, p.projectId);
        if (!can(access.role, "member.manage")) throw forbidden("remove members");
        const target = projectMemberView(access.projectId, memberId);
        if (!target) throw noAccess();
        if (target.teamRole === "owner") throw new TeamError(400, "invalid", "Team owners cannot be removed from a project");
        db.prepare("DELETE FROM project_memberships WHERE project_id=? AND member_id=?").run(access.projectId, memberId);
        clearAssignmentsOf(memberId, access.projectId, access.member.id);
        change(access.projectId, "member", memberId);
        audit(access.teamId, access.member.id, "member.remove", memberId, { projectId: access.projectId });
        return projectMembers(access.projectId, access.teamId);
      }
      const owner = teamAccess(db, who, p.teamId);
      if (owner.team_role !== "owner") throw forbidden("remove team members");
      const target = db.prepare("SELECT * FROM members WHERE id=? AND team_id=?").get(memberId, owner.team_id) as MemberRow | undefined;
      if (!target) throw noAccess();
      if (target.team_role === "owner") {
        const owners = (db.prepare("SELECT COUNT(*) AS n FROM members WHERE team_id=? AND team_role='owner' AND status='active'").get(owner.team_id) as any).n;
        if (owners <= 1 && target.status === "active") throw new TeamError(400, "invalid", "A team needs at least one owner");
      }
      const projects = db.prepare("SELECT project_id FROM project_memberships WHERE member_id=?").all(memberId) as any[];
      db.prepare("DELETE FROM project_memberships WHERE member_id=?").run(memberId);
      db.prepare("UPDATE members SET status='suspended', team_role='member', updated_at=? WHERE id=?").run(now(), memberId);
      clearAssignmentsOf(memberId, null, owner.id);
      for (const pr of projects) change(pr.project_id, "member", memberId);
      if (target.team_role === "owner")
        for (const pr of db.prepare("SELECT id FROM team_projects WHERE team_id=?").all(owner.team_id) as any[]) change(pr.id, "member", memberId);
      audit(owner.team_id, owner.id, "member.removeFromTeam", memberId);
      return { ok: true };
    },
    "sharedTask.publish": (who, p) => {
      fields(p, ["projectId", "mutationId", "title", "description", "status"]);
      const access = projectAccess(db, who, p.projectId);
      if (!can(access.role, "task.publish")) throw forbidden("publish tasks");
      const title = text(p.title, TEAM_LIMITS.title, "Title", false, true);
      const description = text(p.description, TEAM_LIMITS.description, "Description");
      if (!STATUSES.includes(p.status)) throw new TeamError(400, "invalid", "Invalid status");
      return mutate(who, "sharedTask.publish", p, () => {
        const taskId = uuid();
        db.prepare("INSERT INTO shared_tasks VALUES (?,?,?,?,?,1,?,?,?,?,NULL)").run(
          taskId, access.projectId, title, description, p.status, access.member.id, access.member.id, now(), now(),
        );
        change(access.projectId, "task", taskId);
        audit(access.teamId, access.member.id, "sharedTask.publish", taskId, { projectId: access.projectId });
        return taskView(db.prepare("SELECT * FROM shared_tasks WHERE id=?").get(taskId));
      });
    },
    "sharedTask.update": (who, p) => {
      fields(p, ["taskId", "mutationId", "revision", "title", "description", "status"]);
      const { row, access } = taskAccess(who, p.taskId);
      if (!can(access.role, "task.publish")) throw forbidden("change shared tasks");
      const rev = revision(p.revision);
      const title = p.title === undefined ? row.title : text(p.title, TEAM_LIMITS.title, "Title", false, true);
      const description = p.description === undefined ? row.description : text(p.description, TEAM_LIMITS.description, "Description");
      if (p.status !== undefined && !STATUSES.includes(p.status)) throw new TeamError(400, "invalid", "Invalid status");
      return mutate(who, "sharedTask.update", p, () => {
        if (rev !== row.revision) throw new TeamError(409, "conflict", "The shared task changed since you last synced", taskView(row));
        db.prepare("UPDATE shared_tasks SET title=?, description=?, status=?, revision=revision+1, updated_by=?, updated_at=? WHERE id=?").run(
          title, description, p.status ?? row.status, access.member.id, now(), row.id,
        );
        change(access.projectId, "task", row.id);
        audit(access.teamId, access.member.id, "sharedTask.update", row.id);
        return taskView(db.prepare("SELECT * FROM shared_tasks WHERE id=?").get(row.id));
      });
    },
    "sharedTask.remove": (who, p) => {
      fields(p, ["taskId", "mutationId", "revision"]);
      const row = taskRow(p.taskId);
      const access = projectAccess(db, who, row.project_id);
      if (!can(access.role, "task.publish")) throw forbidden("remove shared tasks");
      const rev = revision(p.revision);
      return mutate(who, "sharedTask.remove", p, () => {
        if (row.deleted_at) return taskView(row);
        if (rev !== row.revision) throw new TeamError(409, "conflict", "The shared task changed since you last synced", taskView(row));
        db.prepare("UPDATE shared_tasks SET deleted_at=?, revision=revision+1, title='', description='', updated_by=?, updated_at=? WHERE id=?").run(
          now(), access.member.id, now(), row.id,
        );
        db.prepare("DELETE FROM assignments WHERE task_id=?").run(row.id);
        change(access.projectId, "task", row.id);
        audit(access.teamId, access.member.id, "sharedTask.remove", row.id);
        return taskView(db.prepare("SELECT * FROM shared_tasks WHERE id=?").get(row.id));
      });
    },
    "comment.list": (who, p) => {
      fields(p, ["taskId", "after", "limit"]);
      const { row } = taskAccess(who, p.taskId, false);
      const after = p.after === undefined ? 0 : revision(p.after);
      const lim = Math.min(TEAM_LIMITS.pageSize, p.limit === undefined ? 100 : Math.max(1, revision(p.limit)));
      const rows = db
        .prepare("SELECT rowid AS seq, * FROM comments WHERE task_id=? AND rowid>? ORDER BY rowid LIMIT ?")
        .all(row.id, after, lim + 1) as any[];
      const page = rows.slice(0, lim);
      return { comments: page.map(commentView), cursor: page.length ? page[page.length - 1].seq : after, more: rows.length > lim };
    },
    "comment.create": (who, p) => {
      fields(p, ["taskId", "mutationId", "body"]);
      limit("comment", who.issuer + "\0" + who.subject);
      const { row, access } = taskAccess(who, p.taskId);
      if (!can(access.role, "comment.create")) throw forbidden("comment");
      const body = text(p.body, TEAM_LIMITS.comment, "Comment", true, true);
      return mutate(who, "comment.create", p, () => {
        const commentId = uuid();
        db.prepare("INSERT INTO comments VALUES (?,?,?,?,?,1,?,?,NULL,NULL)").run(commentId, row.id, access.projectId, access.member.id, body, now(), now());
        change(access.projectId, "comment", commentId);
        return commentView(db.prepare("SELECT * FROM comments WHERE id=?").get(commentId));
      });
    },
    "comment.edit": (who, p) => {
      fields(p, ["commentId", "mutationId", "revision", "body"]);
      limit("comment", who.issuer + "\0" + who.subject);
      const { row, access } = commentAccess(who, p.commentId);
      if (row.author_id !== access.member.id || !can(access.role, "comment.editOwn")) throw forbidden("edit this comment");
      const body = text(p.body, TEAM_LIMITS.comment, "Comment", true, true);
      const rev = revision(p.revision);
      return mutate(who, "comment.edit", p, () => {
        if (row.deleted_at || rev !== row.revision) throw new TeamError(409, "conflict", "The comment changed since you last synced", commentView(row));
        db.prepare("UPDATE comments SET body=?, revision=revision+1, updated_at=? WHERE id=?").run(body, now(), row.id);
        change(access.projectId, "comment", row.id);
        return commentView(db.prepare("SELECT * FROM comments WHERE id=?").get(row.id));
      });
    },
    "comment.delete": (who, p) => {
      fields(p, ["commentId", "mutationId", "revision"]);
      const { row, access } = commentAccess(who, p.commentId);
      const own = row.author_id === access.member.id && can(access.role, "comment.editOwn");
      if (!own && !can(access.role, "comment.moderate")) throw forbidden("delete this comment");
      const rev = revision(p.revision);
      return mutate(who, "comment.delete", p, () => {
        if (row.deleted_at) return commentView(row);
        if (rev !== row.revision) throw new TeamError(409, "conflict", "The comment changed since you last synced", commentView(row));
        db.prepare("UPDATE comments SET body='', deleted_at=?, deleted_by=?, revision=revision+1, updated_at=? WHERE id=?").run(now(), access.member.id, now(), row.id);
        change(access.projectId, "comment", row.id);
        // Moderation is audited; comment text never enters the audit log.
        if (!own) audit(access.teamId, access.member.id, "comment.moderate", row.id, { author: row.author_id });
        return commentView(db.prepare("SELECT * FROM comments WHERE id=?").get(row.id));
      });
    },
    "assignment.set": (who, p) => assign(who, p, true),
    "assignment.clear": (who, p) => assign(who, p, false),
    "changes.read": (who, p) => {
      fields(p, ["projectId", "after", "limit"]);
      const access = projectAccess(db, who, p.projectId);
      const after = p.after === undefined ? 0 : revision(p.after);
      const lim = Math.min(TEAM_LIMITS.pageSize, p.limit === undefined ? 100 : Math.max(1, revision(p.limit)));
      const rows = db
        .prepare("SELECT seq, kind, entity_id FROM changes WHERE project_id=? AND seq>? ORDER BY seq LIMIT ?")
        .all(access.projectId, after, lim + 1) as any[];
      const page = rows.slice(0, lim);
      const page_: ChangesPage = {
        projectId: access.projectId,
        role: access.role,
        cursor: page.length ? page[page.length - 1].seq : after,
        more: rows.length > lim,
        changes: page.map((c) => {
          let value: any = null;
          if (c.kind === "task") {
            const r = db.prepare("SELECT * FROM shared_tasks WHERE id=? AND project_id=?").get(c.entity_id, access.projectId);
            value = r ? taskView(r) : null;
          } else if (c.kind === "comment") {
            const r = db.prepare("SELECT * FROM comments WHERE id=? AND project_id=?").get(c.entity_id, access.projectId);
            value = r ? commentView(r) : null;
          } else if (c.kind === "assignment") {
            const t = db.prepare("SELECT id, deleted_at FROM shared_tasks WHERE id=? AND project_id=?").get(c.entity_id, access.projectId) as any;
            value = t && !t.deleted_at ? assignmentView(t.id) : null;
          } else if (c.kind === "member") value = projectMemberView(access.projectId, c.entity_id);
          return { seq: c.seq, kind: c.kind, id: c.entity_id, value, deleted: !value || !!value.deleted };
        }),
      };
      return page_;
    },
    "audit.list": (who, p) => {
      fields(p, ["teamId", "after", "limit"]);
      const member = teamAccess(db, who, p.teamId);
      if (member.team_role !== "owner") throw forbidden("read the audit log");
      const after = p.after === undefined ? 0 : revision(p.after);
      const lim = Math.min(TEAM_LIMITS.pageSize, p.limit === undefined ? 100 : Math.max(1, revision(p.limit)));
      return db.prepare("SELECT * FROM audit WHERE team_id=? AND seq>? ORDER BY seq LIMIT ?").all(member.team_id, after, lim);
    },
  };

  function assign(who: TeamIdentity, p: any, set: boolean) {
    fields(p, set ? ["taskId", "mutationId", "memberId", "revision"] : ["taskId", "mutationId", "revision"]);
    const { row, access } = taskAccess(who, p.taskId);
    const rev = revision(p.revision);
    const target = set ? id(p.memberId, "member") : null;
    const current = assignmentView(row.id);
    if (!canAssign(access, target, current.memberId)) throw forbidden("make this assignment");
    if (target) {
      // Only active members of this project who can work on it (not viewers).
      const view = projectMemberView(access.projectId, target);
      if (!view || view.status !== "active" || view.role === "viewer")
        throw new TeamError(400, "invalid", "Assign only active project members (not viewers)");
    }
    return mutate(who, set ? "assignment.set" : "assignment.clear", p, () => {
      const latest = assignmentView(row.id);
      if (rev !== latest.revision) throw new TeamError(409, "conflict", "The assignment changed since you last synced", latest);
      db.prepare(
        `INSERT INTO assignments VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET member_id=excluded.member_id,
         revision=excluded.revision, assigned_by=excluded.assigned_by, updated_at=excluded.updated_at`,
      ).run(row.id, target, latest.revision + 1, access.member.id, now());
      change(access.projectId, "assignment", row.id);
      audit(access.teamId, access.member.id, set ? "assignment.set" : "assignment.clear", row.id, { member: target });
      return assignmentView(row.id);
    });
  }

  return {
    db,
    limit,
    redeem,
    createInvitation,
    me,
    /** One authenticated action. Authorization and the mutation share one transaction. */
    async call(who: TeamIdentity, action: unknown, payload: unknown) {
      if (typeof action !== "string" || !(TEAM_ACTIONS as readonly string[]).includes(action))
        throw new TeamError(404, "not-found", "Unknown team action");
      limit("call", who.issuer + "\0" + who.subject);
      await options.beforeTransaction?.(who, action);
      return transaction(db, () => handlers[action as TeamAction](who, payload ?? {}));
    },
  };
}
export type TeamApp = ReturnType<typeof createTeamApp>;

/** Owner bootstrap: a team and a one-time owner invitation (printed once). */
export function createTeam(db: DatabaseSync, input: { name: string; ownerEmail?: string; hours?: number }) {
  const app = createTeamApp({ db });
  const name = text(input.name, TEAM_LIMITS.name, "Team name", false, true);
  return transaction(db, () => {
    const teamId = uuid();
    db.prepare("INSERT INTO teams VALUES (?,?,?)").run(teamId, name, now());
    const invitation = app.createInvitation({
      teamId,
      teamRole: "owner",
      projectId: null,
      projectRole: null,
      email: input.ownerEmail ?? "",
      hours: input.hours ?? 72,
      createdBy: null,
    });
    return { teamId, name, ...invitation };
  });
}

export interface TeamServiceOptions {
  dataDir: string;
  host?: string;
  port?: number;
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** The exact HTTPS origin clients use; required for a non-loopback listener. */
  publicOrigin?: string;
  oidc: OidcSettings;
  sessionMs?: number;
  refreshMs?: number;
  limits?: Partial<RateLimits>;
  beforeTransaction?: TeamAppOptions["beforeTransaction"];
}
export interface TeamService {
  url: string;
  port: number;
  app: TeamApp;
  db: DatabaseSync;
  stop(): Promise<void>;
}

/**
 * The self-hosted team service: one Node process, its own SQLite store and
 * its own HTTPS listener. Like the owner gateway, a non-loopback listener
 * requires TLS. It exposes only the team API: no terminal, file, Git,
 * project or gateway route exists here.
 */
export async function startTeamService(options: TeamServiceOptions): Promise<TeamService> {
  const host = options.host || "127.0.0.1";
  if (!isLoopback(host) && !options.tls) throw new Error("Non-loopback listeners require TLS");
  if (!isLoopback(host) && !options.publicOrigin) throw new Error("A network listener needs its public HTTPS origin");
  if (options.publicOrigin) {
    const u = new URL(options.publicOrigin);
    if (u.origin !== options.publicOrigin || (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))))
      throw new Error("The public origin must be an exact HTTPS origin");
  }
  const oidc = createOidc(options.oidc);
  const db = openTeamStore(options.dataDir);
  const app = createTeamApp({ db, limits: options.limits, beforeTransaction: options.beforeTransaction });
  const sessions = createSessions(db, { sessionMs: options.sessionMs, refreshMs: options.refreshMs });
  const logins = createLoginTransactions(db);
  const redirect = redirectShape(options.oidc.redirectUri);
  const pruneTimer = setInterval(() => {
    try {
      sessions.prune();
    } catch {}
  }, 3_600_000);
  pruneTimer.unref();

  function send(res: http.ServerResponse, status: number, body: unknown) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": Buffer.byteLength(data),
    });
    res.end(data);
  }
  async function body(req: http.IncomingMessage) {
    if (!String(req.headers["content-type"] || "").startsWith("application/json"))
      throw new TeamError(415, "invalid", "Send JSON");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > TEAM_LIMITS.requestBytes) throw new TeamError(413, "invalid", "Request is too large");
      chunks.push(chunk);
    }
    try {
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      throw new TeamError(400, "invalid", "Invalid JSON");
    }
  }
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      // Browsers never call this API; a cross-site page cannot ride on it.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== options.publicOrigin) throw new TeamError(403, "forbidden", "Cross-origin requests are refused");
      const url = new URL(req.url || "/", "http://service.invalid");
      const remote = req.socket.remoteAddress || "";
      if (req.method === "GET" && url.pathname === "/v1/info")
        return send(res, 200, { protocol: TEAM_PROTOCOL, issuer: options.oidc.issuer, redirect });
      if (req.method !== "POST") throw new TeamError(404, "not-found", "Not found");
      if (url.pathname === "/v1/auth/start") {
        app.limit("auth", remote);
        const p = fields(await body(req), ["redirectUri", "codeChallenge", "codeChallengeMethod", "invitation"]);
        const redirectUri = checkClientRedirect(options.oidc, p.redirectUri);
        if (p.codeChallengeMethod !== "S256" || typeof p.codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(p.codeChallenge))
          throw new TeamError(400, "invalid", "PKCE with S256 is required");
        if (p.invitation !== undefined && (typeof p.invitation !== "string" || p.invitation.length > 100))
          throw new TeamError(400, "invalid", "Invalid invitation");
        const tx = logins.create({ redirectUri, codeChallenge: p.codeChallenge, invitation: p.invitation?.trim() || undefined });
        const authorizationUrl = await oidc.authorizationUrl({ redirectUri, state: tx.state, nonce: tx.nonce, codeChallenge: p.codeChallenge });
        return send(res, 200, { transactionId: tx.id, state: tx.state, authorizationUrl });
      }
      if (url.pathname === "/v1/auth/finish") {
        app.limit("auth", remote);
        const p = fields(await body(req), ["transactionId", "params", "codeVerifier"]);
        const params = fields(p.params, ["code", "state", "iss", "session_state", "scope", "authuser", "prompt", "hd"]);
        for (const v of Object.values(params)) if (typeof v !== "string" || v.length > 4096) throw new TeamError(400, "invalid", "Invalid callback");
        const tx = logins.take(p.transactionId, p.codeVerifier);
        if (params.state !== tx.state) throw new TeamError(401, "unauthenticated", "The sign-in state did not match");
        const claims = await oidc.exchange({ redirectUri: tx.redirect_uri, params, state: tx.state, nonce: tx.nonce, codeVerifier: p.codeVerifier });
        const identity: TeamIdentity & { emailVerified?: boolean } = {
          issuer: claims.iss,
          subject: claims.sub,
          name: plainText(String(claims.name ?? claims.preferred_username ?? claims.email ?? "Member").slice(0, 400), TEAM_LIMITS.name, "name", false) || "Member",
          email: typeof claims.email === "string" && claims.email.length <= 254 ? claims.email : "",
          emailVerified: claims.email_verified === undefined ? undefined : claims.email_verified === true,
        };
        const tokens = transaction(db, () => {
          if (tx.invitation_hash) app.redeem(identity, tx.invitation_hash);
          db.prepare("UPDATE members SET name=?, email=?, updated_at=? WHERE issuer=? AND subject=? AND status='active'").run(
            identity.name, identity.email, new Date().toISOString(), identity.issuer, identity.subject,
          );
          if (!app.me(identity).teams.length)
            throw new TeamError(403, "not-invited", "This account is not a member of any team here. Ask an owner for an invitation.");
          const { emailVerified: _, ...who } = identity;
          return sessions.issue(who);
        });
        return send(res, 200, tokens);
      }
      if (url.pathname === "/v1/auth/refresh") {
        app.limit("auth", remote);
        const p = fields(await body(req), ["refreshToken"]);
        // Not one transaction: a detected refresh-token replay must stay revoked.
        return send(res, 200, sessions.refresh(p.refreshToken));
      }
      if (url.pathname === "/v1/auth/logout") {
        const who = sessions.authenticate(req.headers.authorization);
        sessions.revokeFamily(who.family);
        return send(res, 200, { ok: true });
      }
      const match = /^\/v1\/call\/([a-z.A-Z]+)$/.exec(url.pathname);
      if (!match) throw new TeamError(404, "not-found", "Not found");
      const { family: _, ...who } = sessions.authenticate(req.headers.authorization);
      const payload = await body(req);
      return send(res, 200, await app.call(who, match[1], payload));
    } catch (error) {
      if (error instanceof TeamError)
        return send(res, error.status, { error: error.message, code: error.code, ...(error.current !== undefined ? { current: error.current } : {}) });
      return send(res, 500, { error: "The team service could not complete this request", code: "server" });
    }
  };
  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const url = options.publicOrigin || `${options.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return {
    url,
    port,
    app,
    db,
    async stop() {
      clearInterval(pruneTimer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
export type { ProjectAccess };
