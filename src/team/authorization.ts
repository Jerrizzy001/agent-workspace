import type { DatabaseSync } from "node:sqlite";
import type { ProjectRole, TeamRole } from "../shared/team-contracts.js";

/**
 * Team roles. A team owner manages the team and acts as admin of every team
 * project. A project admin manages that project's membership and published
 * tasks and moderates comments. A member comments and manages permitted
 * assignments. A viewer only reads. Every check runs against the database
 * inside the same transaction as the mutation it guards.
 */
export type TeamCapability =
  | "project.read"
  | "comment.create"
  | "comment.editOwn"
  | "comment.moderate"
  | "assignment.self"
  | "assignment.any"
  | "task.publish"
  | "member.manage"
  | "audit.read";
export const ROLE_CAPABILITIES: Record<ProjectRole, readonly TeamCapability[]> = {
  admin: [
    "project.read",
    "comment.create",
    "comment.editOwn",
    "comment.moderate",
    "assignment.self",
    "assignment.any",
    "task.publish",
    "member.manage",
  ],
  member: ["project.read", "comment.create", "comment.editOwn", "assignment.self"],
  viewer: ["project.read"],
};
export const can = (role: ProjectRole | null, capability: TeamCapability) =>
  !!role && ROLE_CAPABILITIES[role].includes(capability);
export const effectiveRole = (
  teamRole: TeamRole,
  projectRole: ProjectRole | null,
): ProjectRole | null => (teamRole === "owner" ? "admin" : projectRole);

export class TeamError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public current?: unknown,
  ) {
    super(message);
  }
}
export const noAccess = () =>
  new TeamError(403, "no-access", "Not found, or you no longer have access to it");
export const forbidden = (what: string) =>
  new TeamError(403, "forbidden", `Your role does not allow you to ${what}`);

export interface Identity {
  issuer: string;
  subject: string;
}
export interface MemberRow {
  id: string;
  team_id: string;
  issuer: string | null;
  subject: string | null;
  name: string;
  email: string;
  team_role: TeamRole;
  status: "invited" | "active" | "suspended";
}
export interface ProjectAccess {
  member: MemberRow;
  projectId: string;
  teamId: string;
  role: ProjectRole;
}

/** The caller's active membership of a team, or null. */
export function activeMember(db: DatabaseSync, who: Identity, teamId: string) {
  const row = db
    .prepare(
      "SELECT * FROM members WHERE team_id=? AND issuer=? AND subject=? AND status='active'",
    )
    .get(teamId, who.issuer, who.subject) as MemberRow | undefined;
  return row ?? null;
}

/**
 * Resolves the caller's current role in a team project. A missing project,
 * a project of another team, a suspended member and a removed membership all
 * give the same answer, so IDs cannot be probed.
 */
export function projectAccess(db: DatabaseSync, who: Identity, projectId: unknown): ProjectAccess {
  if (typeof projectId !== "string" || !UUID.test(projectId)) throw noAccess();
  const project = db
    .prepare("SELECT id, team_id FROM team_projects WHERE id=?")
    .get(projectId) as { id: string; team_id: string } | undefined;
  if (!project) throw noAccess();
  const member = activeMember(db, who, project.team_id);
  if (!member) throw noAccess();
  const membership = db
    .prepare("SELECT role FROM project_memberships WHERE project_id=? AND member_id=?")
    .get(project.id, member.id) as { role: ProjectRole } | undefined;
  const role = effectiveRole(member.team_role, membership?.role ?? null);
  if (!role) throw noAccess();
  return { member, projectId: project.id, teamId: project.team_id, role };
}

export function teamAccess(db: DatabaseSync, who: Identity, teamId: unknown) {
  if (typeof teamId !== "string" || !UUID.test(teamId)) throw noAccess();
  const member = activeMember(db, who, teamId);
  if (!member) throw noAccess();
  return member;
}

/** Assignment policy: admins assign any eligible member; members only themselves (or clear their own). */
export function canAssign(
  access: ProjectAccess,
  target: string | null,
  current: string | null,
) {
  if (can(access.role, "assignment.any")) return true;
  if (!can(access.role, "assignment.self")) return false;
  if (target === null) return current === access.member.id;
  return target === access.member.id && (current === null || current === access.member.id);
}

/** Which project roles an actor may grant. Admins grant up to admin; owners anything. */
export function canGrant(access: ProjectAccess, role: ProjectRole) {
  return can(access.role, "member.manage") && ["admin", "member", "viewer"].includes(role);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
