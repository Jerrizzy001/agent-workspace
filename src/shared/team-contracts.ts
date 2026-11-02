/**
 * Team collaboration (roadmap section 9): versioned contracts shared by the
 * self-hosted team service (`src/team/`), the desktop main process and the
 * renderer. The first release shares task metadata, comments and
 * assignments only: never paths, prompts, transcripts or terminals.
 */
export const TEAM_PROTOCOL = 1;

export type TeamRole = "owner" | "member";
export type ProjectRole = "admin" | "member" | "viewer";
export type MemberStatus = "invited" | "active" | "suspended";
export type SharedTaskStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "review"
  | "done";

/** Limits enforced by the service and checked again by the desktop. */
export const TEAM_LIMITS = {
  title: 200,
  description: 8000,
  comment: 4000,
  name: 120,
  pageSize: 200,
  requestBytes: 64 * 1024,
} as const;

/** Team-service actions (`POST /v1/call/<action>`). Nothing here reaches a core or the owner gateway. */
export const TEAM_ACTIONS = [
  "me",
  "project.create",
  "member.list",
  "member.invite",
  "member.setRole",
  "member.remove",
  "invitation.accept",
  "invitation.list",
  "invitation.revoke",
  "sharedTask.publish",
  "sharedTask.update",
  "sharedTask.remove",
  "comment.list",
  "comment.create",
  "comment.edit",
  "comment.delete",
  "assignment.set",
  "assignment.clear",
  "changes.read",
  "audit.list",
] as const;
export type TeamAction = (typeof TEAM_ACTIONS)[number];

export interface TeamIdentity {
  issuer: string;
  subject: string;
  name: string;
  email: string;
}
export interface TeamSummary {
  id: string;
  name: string;
  role: TeamRole;
  memberId: string;
}
export interface TeamProjectSummary {
  id: string;
  teamId: string;
  teamName: string;
  name: string;
  /** Effective role: team owners act as admin of every team project. */
  role: ProjectRole;
}
export interface MeResult {
  identity: TeamIdentity;
  teams: TeamSummary[];
  projects: TeamProjectSummary[];
}
export interface TeamMemberView {
  memberId: string;
  name: string;
  email: string;
  status: MemberStatus;
  teamRole: TeamRole;
  /** Present for project-scoped lists. */
  role?: ProjectRole;
}
export interface SharedTaskView {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: SharedTaskStatus;
  revision: number;
  createdBy: string;
  updatedAt: string;
  deleted: boolean;
}
export interface CommentView {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  /** Plain text; empty once deleted. */
  body: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}
export interface AssignmentView {
  taskId: string;
  memberId: string | null;
  memberName: string;
  /** 0 when the task has never been assigned. */
  revision: number;
}
export type ChangeKind = "task" | "comment" | "assignment" | "member";
export interface TeamChange {
  seq: number;
  kind: ChangeKind;
  id: string;
  /** Current state, or null when the entity no longer exists for this project. */
  value: SharedTaskView | CommentView | AssignmentView | TeamMemberView | null;
  deleted: boolean;
}
export interface ChangesPage {
  projectId: string;
  changes: TeamChange[];
  cursor: number;
  more: boolean;
  role: ProjectRole;
}
export interface InvitationCreated {
  invitationId: string;
  /** Shown once; the service stores only its hash. */
  code: string;
  expiresAt: string;
}
export interface TeamErrorBody {
  error: string;
  code:
    | "invalid"
    | "unauthenticated"
    | "no-access"
    | "forbidden"
    | "conflict"
    | "mutation-reused"
    | "rate-limited"
    | "not-found"
    | "not-invited"
    | "server";
  current?: unknown;
}
export interface TeamServiceInfo {
  protocol: number;
  issuer: string;
  /** Loopback redirect the desktop must listen on (RFC 8252 section 7.3). */
  redirect: { host: string; port: number | null; path: string };
}
export interface TeamSessionTokens {
  sessionToken: string;
  expiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  identity: TeamIdentity;
}

/* ---------- desktop (workspace:team) ---------- */

export type TeamSyncState =
  | "synced"
  | "pending"
  | "conflict"
  | "local-changes"
  | "revoked"
  | "offline";
export interface TeamOutboxItem {
  mutationId: string;
  projectId: string;
  action: TeamAction;
  /** Short human summary; never a comment body from another person. */
  summary: string;
  state: "pending" | "sending" | "conflict" | "failed";
  error?: string;
  createdAt: string;
  target?: string;
}
export interface TeamLocalProject extends TeamProjectSummary {
  localProjectId: string | null;
  state: "active" | "revoked";
  cursor: number;
  truncated?: boolean;
}
export interface TeamStatus {
  /** OS-backed secret storage for the service session. Team sign-in is off without it. */
  secretStorage: { available: boolean; backend: string; detail: string };
  connected: boolean;
  serviceUrl: string;
  identity: TeamIdentity | null;
  teams: TeamSummary[];
  projects: TeamLocalProject[];
  outbox: TeamOutboxItem[];
  lastSyncAt: string | null;
  online: boolean;
  error: string | null;
  notices: string[];
}
export interface TeamTaskPreview {
  localTaskId: string;
  teamProjectId: string;
  teamProjectName: string;
  /** Exactly the JSON fields that leave this computer. */
  fields: { title: string; description: string; status: SharedTaskStatus };
  json: string;
  bytes: number;
  hash: string;
  sharedTaskId: string | null;
}
export interface TeamBoardEntry {
  sharedTaskId: string;
  teamProjectId: string;
  assignee: string | null;
  commentCount: number;
  sync: TeamSyncState;
}
export interface TeamTaskDetail {
  task: SharedTaskView;
  role: ProjectRole;
  meMemberId: string | null;
  comments: (CommentView & { pending?: boolean; mine: boolean })[];
  assignment: AssignmentView;
  members: TeamMemberView[];
  outbox: TeamOutboxItem[];
}
export interface DesktopTeamAPI {
  prepare(): Promise<TeamStatus>;
  status(): Promise<TeamStatus>;
  connect(input: {
    serviceUrl: string;
    invitation?: string;
  }): Promise<TeamStatus>;
  disconnect(): Promise<TeamStatus>;
  publishProject(input: {
    projectId: string;
    teamProjectId?: string;
    teamId?: string;
    name?: string;
  }): Promise<TeamStatus>;
  revokeProject(input: { projectId: string }): Promise<TeamStatus>;
  previewTask(input: { taskId: string }): Promise<TeamTaskPreview>;
  publishTask(input: { taskId: string; hash: string }): Promise<TeamBoardEntry>;
  unpublishTask(input: { taskId: string }): Promise<TeamStatus>;
  sync(): Promise<TeamStatus>;
  boardInfo(input: {
    projectId: string;
  }): Promise<Record<string, TeamBoardEntry>>;
  sharedTasks(input: {
    teamProjectId: string;
  }): Promise<
    (SharedTaskView & { assignee: string | null; commentCount: number })[]
  >;
  taskDetail(input: { sharedTaskId: string }): Promise<TeamTaskDetail>;
  members(input: { teamProjectId: string }): Promise<TeamMemberView[]>;
  invite(input: {
    teamProjectId: string;
    role: ProjectRole;
    email?: string;
  }): Promise<InvitationCreated>;
  setRole(input: {
    teamProjectId: string;
    memberId: string;
    role: ProjectRole;
  }): Promise<TeamMemberView[]>;
  removeMember(input: {
    teamProjectId: string;
    memberId: string;
  }): Promise<TeamMemberView[]>;
  addComment(input: {
    sharedTaskId: string;
    body: string;
  }): Promise<TeamTaskDetail>;
  editComment(input: {
    commentId: string;
    body: string;
  }): Promise<TeamTaskDetail>;
  deleteComment(input: { commentId: string }): Promise<TeamTaskDetail>;
  assign(input: {
    sharedTaskId: string;
    memberId: string | null;
  }): Promise<TeamTaskDetail>;
  resolve(input: {
    mutationId: string;
    choice: "retry" | "discard";
  }): Promise<TeamStatus>;
  onChange(listener: () => void): () => void;
}

/** Plain text: control characters (except newline and tab) and bidi overrides removed. */
export function plainText(
  value: unknown,
  max: number,
  label: string,
  multiline = true,
) {
  if (typeof value !== "string" || value.length > max * 4)
    throw new Error(`Invalid ${label}`);
  let text = value
    .replace(/\r\n?/g, "\n")
    .replace(multiline ? /[^\P{Cc}\n\t]/gu : /\p{Cc}/gu, multiline ? "" : " ")
    .replace(/[‪-‮⁦-⁩‎‏﻿]/g, "");
  if (!multiline) text = text.replace(/\s+/g, " ");
  text = text.trim();
  if ([...text].length > max)
    throw new Error(`${label} must be ${max} characters or fewer`);
  return text;
}
