import { backup, DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * The team service's own SQLite store and migration registry. It is never the
 * desktop's workspace.sqlite: the service owns this file alone, in its own
 * data folder, and no core or gateway opens it.
 */
export interface TeamMigration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}
export const TEAM_MIGRATIONS: readonly TeamMigration[] = [
  {
    version: 1,
    name: "team_01_members_comments_assignments",
    up: (db) =>
      db.exec(`
CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE members (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
  issuer TEXT, subject TEXT, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  team_role TEXT NOT NULL CHECK (team_role IN ('owner','member')),
  status TEXT NOT NULL CHECK (status IN ('invited','active','suspended')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX members_identity ON members(team_id, issuer, subject) WHERE subject IS NOT NULL;
CREATE TABLE invitations (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), code_hash TEXT NOT NULL UNIQUE,
  team_role TEXT NOT NULL CHECK (team_role IN ('owner','member')),
  project_id TEXT, project_role TEXT CHECK (project_role IS NULL OR project_role IN ('admin','member','viewer')),
  email TEXT NOT NULL DEFAULT '', member_id TEXT REFERENCES members(id), created_by TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_at TEXT, redeemed_by TEXT, revoked_at TEXT);
CREATE TABLE team_projects (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), name TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE project_memberships (
  project_id TEXT NOT NULL REFERENCES team_projects(id), member_id TEXT NOT NULL REFERENCES members(id),
  role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')), created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, member_id));
CREATE TABLE shared_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES team_projects(id),
  title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
  revision INTEGER NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE comments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES shared_tasks(id), project_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES members(id), body TEXT NOT NULL, revision INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deleted_by TEXT);
CREATE INDEX comments_task ON comments(task_id, created_at);
CREATE TABLE assignments (
  task_id TEXT PRIMARY KEY REFERENCES shared_tasks(id), member_id TEXT REFERENCES members(id),
  revision INTEGER NOT NULL, assigned_by TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE mutations (
  issuer TEXT NOT NULL, subject TEXT NOT NULL, id TEXT NOT NULL, action TEXT NOT NULL,
  digest TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject, id));
CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
  kind TEXT NOT NULL, entity_id TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX changes_project ON changes(project_id, seq);
CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, actor_id TEXT,
  action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE login_transactions (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, nonce TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL, invitation_hash TEXT, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE service_sessions (
  id TEXT PRIMARY KEY, family TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, rotated_at TEXT, revoked_at TEXT);
CREATE INDEX service_sessions_family ON service_sessions(family);
`),
  },
];
export const TEAM_SCHEMA_VERSION = TEAM_MIGRATIONS[TEAM_MIGRATIONS.length - 1]!.version;
TEAM_MIGRATIONS.forEach((m, index) => {
  if (m.version !== index + 1 || TEAM_MIGRATIONS.findIndex((o) => o.name === m.name) !== index)
    throw new Error("Team migration registry is out of order");
});

export function openTeamStore(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const file = path.join(dataDir, "team.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;");
  const from = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (from > TEAM_SCHEMA_VERSION) {
    db.close();
    throw new Error("Team data belongs to a newer service version");
  }
  for (const m of TEAM_MIGRATIONS.filter((m) => m.version > from)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version=${m.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return db;
}

/** Consistent online copy (safe with WAL) for the owner's backup policy. */
export async function backupTeamStore(db: DatabaseSync, target: string) {
  await backup(db, target);
  fs.chmodSync(target, 0o600);
  return target;
}

/** Runs fn inside one immediate transaction; authorization and mutation commit together. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
