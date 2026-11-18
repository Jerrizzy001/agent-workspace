import type { CoreEvent, Snapshot } from "./contracts.js";

export const RECORD_SETS = [
  "projects",
  "tasks",
  "attempts",
  "sessions",
  "notes",
  "layouts",
  "boardLanes",
  "hosts",
] as const;
type RecordSet = (typeof RECORD_SETS)[number];
export interface WorkspaceDelta {
  type: "workspace.delta";
  epoch: string;
  sequence: number;
  changes: Partial<Record<RecordSet, { upsert: any[]; remove: string[] }>>;
  capabilities?: Snapshot["capabilities"];
}
const key = (record: any) => record.id ?? record.projectId;

/** Full state once, then only changed records. A new publisher starts a new epoch. */
export function deltaPublisher(epoch: string) {
  let previous: Snapshot | undefined;
  let sequence = 0;
  return (snapshot: Snapshot): CoreEvent => {
    const nextSequence = ++sequence;
    if (!previous) {
      previous = snapshot;
      return { type: "snapshot", snapshot, epoch, sequence: nextSequence };
    }
    const changes: WorkspaceDelta["changes"] = {};
    for (const kind of RECORD_SETS) {
      if (previous[kind] === snapshot[kind]) continue;
      const old = new Map((previous[kind] ?? []).map((r) => [key(r), r]));
      const upsert = (snapshot[kind] ?? []).filter((r) => {
        const before = old.get(key(r));
        old.delete(key(r));
        return before !== r && JSON.stringify(before) !== JSON.stringify(r);
      });
      const remove = [...old.keys()];
      if (upsert.length || remove.length) changes[kind] = { upsert, remove };
    }
    const capabilities =
      JSON.stringify(previous.capabilities) !==
      JSON.stringify(snapshot.capabilities)
        ? snapshot.capabilities
        : undefined;
    previous = snapshot;
    return {
      type: "workspace.delta",
      epoch,
      sequence: nextSequence,
      changes,
      ...(capabilities ? { capabilities } : {}),
    };
  };
}

export function applyDelta(
  snapshot: Snapshot,
  delta: WorkspaceDelta,
): Snapshot {
  const next = { ...snapshot };
  for (const kind of RECORD_SETS) {
    const change = delta.changes[kind];
    if (!change) continue;
    const rows = new Map((snapshot[kind] ?? []).map((r) => [key(r), r]));
    for (const id of change.remove) rows.delete(id);
    for (const row of change.upsert) rows.set(key(row), row);
    (next as any)[kind] = [...rows.values()];
  }
  if (delta.capabilities) next.capabilities = delta.capabilities;
  return next;
}

/** IPC/WebSocket are ordered; gaps require a fresh snapshot, never a partial apply. */
export function deltaReceiver() {
  let state: Snapshot | undefined;
  let epoch: string | undefined;
  let sequence = 0;
  return {
    current: (): CoreEvent | undefined =>
      state
        ? { type: "snapshot", snapshot: state, epoch, sequence }
        : undefined,
    accept(event: CoreEvent): CoreEvent | undefined {
      if (event.type === "snapshot") {
        state = event.snapshot;
        epoch = event.epoch;
        sequence = event.sequence ?? 0;
        return event;
      }
      if (event.type !== "workspace.delta") return event;
      if (!state || event.epoch !== epoch || event.sequence !== sequence + 1)
        return undefined;
      sequence = event.sequence;
      state = applyDelta(state, event);
      return { type: "snapshot", snapshot: state, epoch, sequence };
    },
  };
}
