import type { DatabaseSync } from "node:sqlite";

/** Transactional invalidation: trigger writes roll back with their records. */
export function indexedRecords(db: DatabaseSync) {
  db.exec(`
    CREATE TEMP TABLE record_versions(kind TEXT PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TEMP TABLE record_changes(kind TEXT, id TEXT, version INTEGER, PRIMARY KEY(kind,id));
    ${["INSERT", "UPDATE", "DELETE"]
      .map((op) => {
        const row = op === "DELETE" ? "old" : "new";
        return `CREATE TEMP TRIGGER records_${op.toLowerCase()} AFTER ${op} ON main.records BEGIN
        INSERT INTO record_versions VALUES(${row}.kind, 1)
        ON CONFLICT(kind) DO UPDATE SET version=version+1;
        INSERT INTO record_changes SELECT ${row}.kind, ${row}.id, version FROM record_versions WHERE kind=${row}.kind
        ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version;
      END;`;
      })
      .join("\n")}
  `);
  const version = db.prepare(
    "SELECT version FROM record_versions WHERE kind=?",
  );
  const select = db.prepare(
    "SELECT id,value FROM records WHERE kind=? ORDER BY rowid",
  );
  const noteMetadata =
    "json_set(json_remove(value, '$.body'), '$.body', '', '$.bodyLoaded', json('false'))";
  const selectMetadata = db.prepare(
    `SELECT id,${noteMetadata} AS value FROM records WHERE kind=? ORDER BY rowid`,
  );
  const single = db.prepare("SELECT value FROM records WHERE kind=? AND id=?");
  const changed =
    db.prepare(`SELECT c.id,r.value FROM record_changes c LEFT JOIN records r ON r.kind=c.kind AND r.id=c.id
    WHERE c.kind=? AND c.version>? ORDER BY c.version`);
  const changedMetadata = db.prepare(
    `SELECT c.id, CASE WHEN r.value IS NULL THEN NULL ELSE ${noteMetadata.replaceAll("value", "r.value")} END AS value FROM record_changes c LEFT JOIN records r ON r.kind=c.kind AND r.id=c.id WHERE c.kind=? AND c.version>? ORDER BY c.version`,
  );
  const dataVersion = db.prepare("PRAGMA data_version");
  let externalVersion = (dataVersion.get() as { data_version: number })
    .data_version;
  const cache = new Map<
    string,
    { version: number; rows: any[]; byId: Map<string, any> }
  >();
  function index(kind: string, metadata = false) {
    const cacheKey = metadata ? kind + ":metadata" : kind;
    const external = (dataVersion.get() as { data_version: number })
      .data_version;
    if (external !== externalVersion) {
      cache.clear();
      externalVersion = external;
    }
    const current =
      (version.get(kind) as { version: number } | undefined)?.version ?? 0;
    let entry = cache.get(cacheKey);
    if (!entry || current < entry.version) {
      const byId = new Map<string, any>();
      for (const row of (metadata ? selectMetadata : select).all(kind) as {
        id: string;
        value: string;
      }[])
        byId.set(row.id, JSON.parse(row.value));
      entry = { version: current, rows: [...byId.values()], byId };
      cache.set(cacheKey, entry);
    } else if (entry.version !== current) {
      for (const row of (metadata ? changedMetadata : changed).all(
        kind,
        entry.version,
      ) as { id: string; value: string | null }[]) {
        if (row.value === null) entry.byId.delete(row.id);
        else entry.byId.set(row.id, JSON.parse(row.value));
      }
      entry.version = current;
      entry.rows = [...entry.byId.values()];
    }
    return entry;
  }
  return {
    // Callers edit detached records and explicitly put them; cached values never escape.
    list: (kind: string): any[] => structuredClone(index(kind).rows),
    view: (kind: string): readonly any[] => index(kind).rows,
    metadata: (kind: string): readonly any[] =>
      index(kind, kind === "notes").rows,
    invalidate: () => cache.clear(),
    get(kind: string, key: string): any {
      const row = single.get(kind, key) as { value: string } | undefined;
      const value = row ? JSON.parse(row.value) : undefined;
      if (!value) throw new Error(`${kind} not found`);
      return structuredClone(value);
    },
  };
}
