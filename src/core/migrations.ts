import { backup, type DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { TEAM_METADATA_SQL } from "./team-cache.js";

/**
 * Ordered, named schema migrations. `PRAGMA user_version` is the applied
 * version; it is independent of the app's release version. Each migration runs
 * in its own transaction and only adds: existing rows stay as written.
 */
export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "records_receipts_events",
    up: (db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,time TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS launch_intents (key TEXT PRIMARY KEY,sessionId TEXT NOT NULL,attemptId TEXT NOT NULL);",
      ),
  },
  {
    // v2: sessions may run without a task attempt (attemptId null, launch
    // intent attemptId ""), carry provider activity, and keep a final screen
    // in "transcripts" records. Existing rows stay valid as written; the
    // version bump stops older builds from misreading attempt-less sessions.
    version: 2,
    name: "folder_sessions",
    up: (db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS launch_requests (key TEXT PRIMARY KEY,request TEXT NOT NULL);",
      ),
  },
  {
    // v3: new record kinds only. "attachments" (private pasted images:
    // sessionId, generation, path, bytes, sha256, createdAt), "ownerSettings"
    // (versioned owner preferences) and optional session title/titleRevision.
    // Nothing is rewritten; older builds refuse the store because they could
    // drop fields they do not know.
    version: 3,
    name: "roadmap_01_owner_utilities",
    up: () => {},
  },
  {
    // v4: the live session board. A new per-folder "boardLanes" record kind
    // ({projectId, lanes, revision}) and optional session lane/laneOrder/
    // placementRevision. Nothing is rewritten: a session without a lane is
    // shown in a default lane. Older builds refuse the store because a
    // rewrite of a session record there would drop its placement.
    version: 4,
    name: "board_lanes",
    up: () => {},
  },
  {
    // v5: agent control (roadmap section 4). Optional note and layout
    // `revision` (an absent one reads as 1; nothing is rewritten), note
    // `source: "agent"`, a "controllerAudit" record kind and namespaced
    // "ctl:<session>:<verb>:<request>" mutation receipts in the existing
    // receipts table. Capabilities are never stored. Older builds refuse the
    // store because their note and layout writes would drop revisions.
    version: 5,
    name: "roadmap_04_controller",
    up: () => {},
  },
  {
    // v6: SSH execution hosts (roadmap section 2). New record kinds only:
    // "executionHosts" (OpenSSH alias, label, optional user/port overrides,
    // helper install and data folders, the pinned remote helper ID and the
    // last probe) and "remoteProjectRefs" (a nonauthoritative cache of each
    // host's folders so the sidebar can list them while disconnected; the
    // remote core stays authoritative). Existing projects and sessions have
    // no host and stay local; no ID is rewritten. Keys and passphrases stay
    // with OpenSSH and are never stored. Older builds refuse the store
    // because they would show remote folders' cached paths as local ones.
    version: 6,
    name: "roadmap_03_execution_hosts",
    up: () => {},
  },
  {
    // Team metadata (roadmap section 9), the next unused number: new tables
    // only. The link to a team service (never its tokens, which stay in the
    // desktop's OS-backed secret storage), team-project and task mappings, a
    // bounded nonauthoritative cache of shared tasks, comments, assignments
    // and members, an ordered sync cursor per project and a bounded outbox.
    // Existing records, including local tasks, are not touched. Older builds
    // refuse the store so they cannot ignore a queued outbox.
    version: 7,
    name: "roadmap_05_team_metadata",
    up: (db) => db.exec(TEAM_METADATA_SQL),
  },
];
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
MIGRATIONS.forEach((m, index) => {
  if (
    m.version !== index + 1 ||
    MIGRATIONS.findIndex((other) => other.name === m.name) !== index
  )
    throw new Error("Migration registry is out of order");
});
const KEEP_BACKUPS = 3;

export const schemaVersion = (db: DatabaseSync) =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;

/**
 * Brings the store to SCHEMA_VERSION. A newer store is rejected before
 * anything is written. An existing store is first copied with SQLite's online
 * backup (consistent with WAL) to `<dataDir>/backups`. Restore by stopping the
 * app and replacing workspace.sqlite (and removing its -wal/-shm) with a copy.
 */
export async function migrate(db: DatabaseSync, dataDir: string) {
  const from = schemaVersion(db);
  if (from > SCHEMA_VERSION)
    throw new Error("Workspace data belongs to a newer app version");
  db.exec("PRAGMA journal_mode=WAL");
  // The base tables were always ensured on every start; keep that for v1 stores.
  MIGRATIONS[0]!.up(db);
  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (!pending.length) return { from, to: from };
  let saved: string | undefined;
  const populated =
    from > 0 ||
    (db.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number }).n >
      0;
  if (populated) saved = await backupDatabase(db, dataDir, from);
  for (const m of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version=${m.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { from, to: SCHEMA_VERSION, ...(saved ? { backup: saved } : {}) };
}

async function backupDatabase(db: DatabaseSync, dataDir: string, from: number) {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `workspace-v${from}-${stamp}.sqlite`);
  await backup(db, target);
  fs.chmodSync(target, 0o600);
  const stampOf = (name: string) => name.replace(/^workspace-v\d+-/, "");
  const old = fs
    .readdirSync(dir)
    .filter((name) => /^workspace-v\d+-[\dTZ-]+\.sqlite$/.test(name))
    .sort((a, b) => stampOf(b).localeCompare(stampOf(a)))
    .slice(KEEP_BACKUPS);
  for (const name of old) fs.rmSync(path.join(dir, name), { force: true });
  return target;
}
