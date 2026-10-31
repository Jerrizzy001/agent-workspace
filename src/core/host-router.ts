/**
 * Routes desktop commands to the execution host that owns them.
 *
 * The local core and every connected SSH host implement `ExecutionHost`.
 * Remote records keep their own IDs and appear on the desktop under an opaque
 * per-host prefix (`ssh-<host>-<remote id>`, see host-protocol.ts), so a
 * command naming a remote folder or session goes to that host's helper and
 * nowhere else. The remote core stays authoritative for sessions,
 * generations, receipts, files, hashes and Git; this router only caches what
 * the host last reported, marks it unknown while disconnected and never
 * resends a request or relaunches anything by itself.
 */
import crypto from "node:crypto";
import {
  MAX_TERMINAL_B64,
  REMOTE_ID,
  parseQualifiedId,
  qualifyId,
  ProtocolError,
} from "../shared/host-protocol.js";
import {
  connectHost,
  hostKeyFingerprints,
  HostProblemError,
  validateHostInput,
  type ConnectOptions,
  type HostConnection,
  type HostSpec,
} from "./ssh.js";
import type {
  Command,
  Core,
  CoreEvent,
  DirectoryListing,
  ExecutionHost,
  ExecutionHostView,
  HostConnectionState,
  HostProblem,
  Project,
  SavedAttachment,
  Snapshot,
} from "../shared/contracts.js";
import type { AgentControlState } from "../shared/controller-contracts.js";

interface HostRecord {
  id: string;
  alias: string;
  label: string;
  user?: string;
  port?: number;
  helperPath: string;
  dataDir?: string;
  remoteHostId?: string;
  helperVersion?: string;
  platform?: string;
  protocol?: number;
  tools?: ExecutionHostView["tools"];
  probedAt?: string;
  /** Reconnect when the app starts (the owner left it connected). */
  autoConnect?: boolean;
  createdAt: string;
}
interface ProjectRef {
  id: string;
  hostId: string;
  remoteProjectId: string;
  name: string;
  path: string;
  cachedAt: string;
}
interface HostState {
  record: HostRecord;
  state: HostConnectionState;
  problem?: HostProblem;
  conn?: HostConnection;
  /** Last snapshot the host reported, in the host's own IDs (sanitized). */
  remote?: Snapshot;
  /** `${remoteSessionId}\0${viewerId}` for views attached (or waiting to reattach). */
  viewers: Set<string>;
  wantConnected: boolean;
  epoch: number;
  attempt: number;
  timer?: NodeJS.Timeout;
  connecting?: Promise<void>;
}

/** Commands that never run on an SSH host from this desktop. */
const REMOTE_REFUSED: Partial<Record<Command, string>> = {
  "project.add": "Register folders on an SSH host from SSH hosts.",
  "settings.read": "Settings belong to this computer.",
  "settings.write": "Settings belong to this computer.",
  "assist.status": "AI suggestions are not available for SSH folders yet.",
  "assist.preview": "AI suggestions are not available for SSH folders yet.",
  "assist.suggest": "AI suggestions are not available for SSH folders yet.",
  "assist.cancel": "AI suggestions are not available for SSH folders yet.",
};
const ID_KEYS = [
  "id",
  "projectId",
  "sessionId",
  "taskId",
  "attemptId",
  "noteId",
  "resumedFrom",
  "resumeSessionId",
];
const RETRYABLE = new Set<HostProblem["code"]>([
  "unreachable",
  "connection-lost",
  "data-in-use",
  "failed",
]);

// ---- Sanitizing what a host reports. Nothing from a host is trusted.
type Rule =
  | "id"
  | "id?"
  | "id|null"
  | "str"
  | "str?"
  | "text"
  | "text?"
  | "int"
  | "int?"
  | "num?"
  | "bool?"
  | readonly string[];
function pick(value: unknown, rules: Record<string, Rule>): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const x = v[key];
    const optional = typeof rule === "string" && rule.endsWith("?");
    if (x === undefined || (x === null && rule !== "id|null")) {
      if (optional) continue;
      return undefined;
    }
    if (typeof rule !== "string") {
      if (typeof x !== "string" || !rule.includes(x)) return undefined;
    } else if (rule.startsWith("id")) {
      if (rule === "id|null" && x === null) {
        out[key] = null;
        continue;
      }
      if (typeof x !== "string" || !REMOTE_ID.test(x)) return undefined;
    } else if (rule.startsWith("str")) {
      if (typeof x !== "string" || x.length > 4096) return undefined;
    } else if (rule.startsWith("text")) {
      if (typeof x !== "string" || x.length > 2 * 1024 * 1024) return undefined;
    } else if (rule.startsWith("int")) {
      if (!Number.isSafeInteger(x)) return undefined;
    } else if (rule === "num?") {
      if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
    } else if (rule === "bool?") {
      if (typeof x !== "boolean") return undefined;
    }
    out[key] = x;
  }
  return out;
}
const list = <T>(value: unknown, max: number, each: (v: unknown) => T | undefined) =>
  Array.isArray(value)
    ? value.slice(0, max).map(each).filter((v): v is T => v !== undefined)
    : [];
const STATUS = ["running", "exited", "unknown"] as const;
const PROVIDER = ["shell", "claude", "codex"] as const;
export function sanitizeSnapshot(raw: unknown): Snapshot {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    projects: list(s.projects, 1000, (v) =>
      pick(v, { id: "id", name: "str", path: "str", createdAt: "str", hidden: "bool?" }),
    ) as unknown as Snapshot["projects"],
    tasks: list(s.tasks, 5000, (v) =>
      pick(v, {
        id: "id",
        projectId: "id",
        title: "text",
        description: "text",
        status: ["backlog", "ready", "in_progress", "review", "done"],
        revision: "int",
        createdAt: "str",
        updatedAt: "str",
      }),
    ) as unknown as Snapshot["tasks"],
    attempts: list(s.attempts, 5000, (v) =>
      pick(v, {
        id: "id",
        taskId: "id",
        projectId: "id",
        provider: PROVIDER,
        model: "str?",
        sessionId: "id",
        worktreePath: "str",
        status: STATUS,
        createdAt: "str",
      }),
    ) as unknown as Snapshot["attempts"],
    sessions: list(s.sessions, 5000, (v) =>
      pick(v, {
        id: "id",
        attemptId: "id|null",
        projectId: "id",
        provider: PROVIDER,
        cwd: "str",
        backendName: "str",
        generation: "int",
        status: STATUS,
        createdAt: "str",
        model: "str?",
        activity: ["running", "needs", "done"],
        activityTracking: "bool?",
        activityAt: "num?",
        conversationId: "str?",
        resumedFrom: "id?",
        exitCode: "int?",
        transcript: "bool?",
        title: "str?",
        titleRevision: "int?",
        lane: "str?",
        laneOrder: "num?",
        placementRevision: "int?",
      }) ??
      // `activity` is optional; retry without it when absent.
      pick(v, {
        id: "id",
        attemptId: "id|null",
        projectId: "id",
        provider: PROVIDER,
        cwd: "str",
        backendName: "str",
        generation: "int",
        status: STATUS,
        createdAt: "str",
        model: "str?",
        activityTracking: "bool?",
        conversationId: "str?",
        resumedFrom: "id?",
        exitCode: "int?",
        transcript: "bool?",
        title: "str?",
        titleRevision: "int?",
        lane: "str?",
        laneOrder: "num?",
        placementRevision: "int?",
      }),
    ) as unknown as Snapshot["sessions"],
    notes: list(s.notes, 5000, (v) =>
      pick(v, {
        id: "id",
        projectId: "id",
        title: "text",
        body: "text",
        createdAt: "str",
        updatedAt: "str",
        revision: "int?",
        source: ["agent"],
      }) ??
      pick(v, {
        id: "id",
        projectId: "id",
        title: "text",
        body: "text",
        createdAt: "str",
        updatedAt: "str",
        revision: "int?",
      }),
    ) as unknown as Snapshot["notes"],
    layouts: list(s.layouts, 1000, (v) => {
      const base = pick(v, { projectId: "id", revision: "int?" });
      const positions = (v as Record<string, unknown> | undefined)?.positions;
      if (!base || !positions || typeof positions !== "object" || Array.isArray(positions))
        return undefined;
      const entries = Object.entries(positions as Record<string, any>)
        .slice(0, 10000)
        .filter(
          ([k, p]) => REMOTE_ID.test(k) && p && Number.isFinite(p.x) && Number.isFinite(p.y),
        )
        .map(([k, p]) => [k, { x: p.x, y: p.y }]);
      return { ...base, positions: Object.fromEntries(entries) };
    }) as unknown as Snapshot["layouts"],
    boardLanes: list(s.boardLanes, 1000, (v) => {
      const base = pick(v, { projectId: "id", revision: "int" });
      if (!base) return undefined;
      const lanes = list((v as any).lanes, 12, (l) =>
        pick(l, { id: "str", name: "str" }),
      ).filter((l) => /^[A-Za-z0-9_-]{1,64}$/.test(String(l.id)) && String(l.name).length <= 80);
      return lanes.length ? { ...base, lanes } : undefined;
    }) as unknown as Snapshot["boardLanes"],
    capabilities: list(s.capabilities, 8, (v) => {
      const c = pick(v, { name: ["tmux", "git", "claude", "codex"], detail: "str" });
      const available = (v as any)?.available;
      return c && typeof available === "boolean"
        ? { ...c, available, detail: String(c.detail).slice(0, 300) }
        : undefined;
    }) as unknown as Snapshot["capabilities"],
  };
}
function sanitizeListing(raw: unknown): DirectoryListing {
  const v = pick(raw, { path: "str", home: "str" });
  const r = raw as Record<string, unknown>;
  if (!v || (r.parent !== null && typeof r.parent !== "string"))
    throw new ProtocolError("Invalid folder listing");
  return {
    path: v.path as string,
    home: v.home as string,
    parent: (r.parent as string | null) ?? null,
    git: r.git === true,
    truncated: r.truncated === true,
    entries: list(r.entries, 2000, (e) => {
      const x = pick(e, { name: "str", path: "str", type: ["directory", "file"], hidden: "bool?" });
      return x
        ? {
            name: x.name as string,
            path: x.path as string,
            type: x.type as "directory" | "file",
            hidden: x.hidden === true,
            ...((e as any).git === true ? { git: true } : {}),
          }
        : undefined;
    }),
    places: list(r.places, 20, (p) => pick(p, { name: "str", path: "str" }) as any),
  };
}

/** Remote IDs to desktop IDs in a result (lane IDs are per folder and stay as they are). */
function toLocal(hostId: string, value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => toLocal(hostId, v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "lanes") out[key] = v;
    else if (key === "positions" && v && typeof v === "object" && !Array.isArray(v))
      out[key] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => REMOTE_ID.test(k))
          .map(([k, p]) => [qualifyId(hostId, k), p]),
      );
    else if (ID_KEYS.includes(key) && typeof v === "string")
      out[key] = REMOTE_ID.test(v) ? qualifyId(hostId, v) : "invalid";
    else out[key] = toLocal(hostId, v, depth + 1);
  }
  return out;
}
/** The host a payload addresses, or undefined for local. Mixing hosts is refused. */
export function routeOf(payload: Record<string, unknown>) {
  let host: string | undefined;
  let local = false;
  const see = (value: unknown) => {
    if (typeof value !== "string") return;
    const parsed = parseQualifiedId(value);
    if (!parsed) local = true;
    else if (host && host !== parsed.hostId)
      throw new Error("These items belong to different hosts");
    else host = parsed.hostId;
  };
  for (const key of ID_KEYS) see(payload[key]);
  const positions = payload.positions;
  if (positions && typeof positions === "object" && !Array.isArray(positions))
    for (const key of Object.keys(positions)) see(key);
  if (host && local) throw new Error("These items belong to different hosts");
  return host;
}
function toRemote(hostId: string, payload: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...payload };
  for (const key of ID_KEYS) {
    if (typeof out[key] !== "string") continue;
    const parsed = parseQualifiedId(out[key]);
    if (!parsed || parsed.hostId !== hostId)
      throw new Error("This item belongs to a different host");
    out[key] = parsed.remoteId;
  }
  if (out.positions && typeof out.positions === "object" && !Array.isArray(out.positions))
    out.positions = Object.fromEntries(
      Object.entries(out.positions as Record<string, unknown>).map(([k, p]) => {
        const parsed = parseQualifiedId(k);
        if (!parsed || parsed.hostId !== hostId)
          throw new Error("This item belongs to a different host");
        return [parsed.remoteId, p];
      }),
    );
  return out;
}

export interface HostRouterOptions {
  local: Core;
  emit: (event: CoreEvent) => void;
  /** Delays between automatic reconnection attempts after an unexpected loss. */
  reconnectDelays?: number[];
  /** Connect hosts the owner left connected (default true). */
  autoConnect?: boolean;
}
export interface HostRouter {
  invoke(command: Command, payload?: Record<string, unknown>): Promise<unknown>;
  createAttachment: Core["createAttachment"];
  agentControl(action: unknown, payload: unknown): Promise<AgentControlState>;
  /** Desktop owner only (`workspace:ssh`). */
  ssh(action: unknown, payload?: unknown): Promise<unknown>;
  /** Events from the local core. */
  onLocalEvent(event: CoreEvent): void;
  /** Tests: the live connection of a host. */
  connection(hostId: string): HostConnection | undefined;
  hosts(): ExecutionHost[];
  close(): Promise<void>;
}

export async function createHostRouter(options: HostRouterOptions): Promise<HostRouter> {
  const { local, emit } = options;
  const delays = options.reconnectDelays ?? [1000, 2000, 4000, 8000, 15000];
  const stored = (await local.hostRecords("list")) as {
    hosts: HostRecord[];
    projectRefs: ProjectRef[];
  };
  const hosts = new Map<string, HostState>();
  for (const record of stored.hosts)
    hosts.set(record.id, {
      record,
      state: "disconnected",
      viewers: new Set(),
      wantConnected: false,
      epoch: 0,
      attempt: 0,
    });
  let refs = stored.projectRefs;
  let localSnapshot = (await local.invoke("snapshot")) as Snapshot;
  let closed = false;

  const spec = (h: HostState): HostSpec => ({
    id: h.record.id,
    alias: h.record.alias,
    helperPath: h.record.helperPath,
    ...(h.record.user ? { user: h.record.user } : {}),
    ...(h.record.port !== undefined ? { port: h.record.port } : {}),
    ...(h.record.dataDir ? { dataDir: h.record.dataDir } : {}),
  });
  const view = (h: HostState): ExecutionHostView => {
    const r = h.record;
    return {
      id: r.id,
      alias: r.alias,
      label: r.label,
      ...(r.user ? { user: r.user } : {}),
      ...(r.port !== undefined ? { port: r.port } : {}),
      helperPath: r.helperPath,
      ...(r.dataDir ? { dataDir: r.dataDir } : {}),
      state: h.state,
      ...(h.problem ? { problem: h.problem } : {}),
      ...(r.helperVersion ? { helperVersion: r.helperVersion } : {}),
      ...(r.platform ? { platform: r.platform } : {}),
      ...(r.protocol ? { protocol: r.protocol } : {}),
      ...(r.remoteHostId ? { remoteHostId: r.remoteHostId } : {}),
      ...(r.tools ? { tools: r.tools } : {}),
      ...(r.probedAt ? { probedAt: r.probedAt } : {}),
      ...(h.state === "connected" && h.remote
        ? { capabilities: h.remote.capabilities }
        : {}),
    };
  };
  function remotePart(h: HostState) {
    const id = h.record.id;
    const connected = h.state === "connected";
    if (!h.remote) {
      const projects = refs
        .filter((r) => r.hostId === id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          path: r.path,
          createdAt: r.cachedAt,
          hostId: id,
        }));
      return { projects, tasks: [], attempts: [], sessions: [], notes: [], layouts: [], boardLanes: [] };
    }
    const t = toLocal(id, h.remote) as Snapshot;
    return {
      projects: t.projects.map((p) => ({ ...p, hostId: id })),
      tasks: t.tasks,
      attempts: t.attempts.map((a) => (connected ? a : { ...a, status: "unknown" as const })),
      sessions: t.sessions.map((s) => {
        if (connected) return { ...s, hostId: id };
        // Cached, not authoritative: a disconnected host's sessions are unknown.
        const { activity: _a, activityAt: _b, ...rest } = s;
        return { ...rest, hostId: id, status: s.status === "exited" ? s.status : ("unknown" as const) };
      }),
      notes: t.notes,
      layouts: t.layouts,
      boardLanes: t.boardLanes,
    };
  }
  function merged(): Snapshot {
    const out: Snapshot = {
      ...localSnapshot,
      projects: [...localSnapshot.projects],
      tasks: [...localSnapshot.tasks],
      attempts: [...localSnapshot.attempts],
      sessions: [...localSnapshot.sessions],
      notes: [...localSnapshot.notes],
      layouts: [...localSnapshot.layouts],
      boardLanes: [...localSnapshot.boardLanes],
      hosts: [...hosts.values()].map(view),
    };
    for (const h of hosts.values()) {
      const part = remotePart(h);
      out.projects.push(...part.projects);
      out.tasks.push(...part.tasks);
      out.attempts.push(...part.attempts);
      out.sessions.push(...part.sessions);
      out.notes.push(...part.notes);
      out.layouts.push(...part.layouts);
      out.boardLanes.push(...part.boardLanes);
    }
    return out;
  }
  const publish = () => {
    if (!closed) emit({ type: "snapshot", snapshot: merged() });
  };
  async function saveRecord(h: HostState) {
    await local.hostRecords("putHost", h.record);
  }
  async function updateRefs(h: HostState) {
    if (!h.remote) return;
    const id = h.record.id;
    const next: ProjectRef[] = h.remote.projects
      .filter((p) => !p.hidden)
      .map((p) => ({
        id: qualifyId(id, p.id),
        hostId: id,
        remoteProjectId: p.id,
        name: p.name,
        path: p.path,
        cachedAt: p.createdAt,
      }));
    const current = refs.filter((r) => r.hostId === id);
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    await local.hostRecords("putProjectRefs", { hostId: id, refs: next });
    refs = [...refs.filter((r) => r.hostId !== id), ...next];
  }
  /** Views attached to a host's sessions reattach (or show the loss) through their resync path. */
  function resyncViewers(h: HostState) {
    for (const key of h.viewers) {
      const [remoteSessionId, viewerId] = key.split("\0");
      emit({
        type: "terminal.resync",
        sessionId: qualifyId(h.record.id, remoteSessionId!),
        viewerId: viewerId!,
      });
    }
  }
  function onRemoteEvent(h: HostState, epoch: number, event: Record<string, any>) {
    if (h.epoch !== epoch || closed) return;
    const id = h.record.id;
    const viewerKey = () => {
      if (
        typeof event.sessionId !== "string" ||
        !REMOTE_ID.test(event.sessionId) ||
        typeof event.viewerId !== "string" ||
        event.viewerId.length > 128
      )
        throw new ProtocolError("Invalid terminal event");
      return event.sessionId + "\0" + event.viewerId;
    };
    switch (event.type) {
      case "snapshot":
        h.remote = sanitizeSnapshot(event.snapshot);
        void updateRefs(h).catch(() => {});
        publish();
        return;
      case "terminal.data": {
        const key = viewerKey();
        if (
          !Number.isSafeInteger(event.sequence) ||
          typeof event.b64 !== "string" ||
          event.b64.length > MAX_TERMINAL_B64 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(event.b64)
        )
          throw new ProtocolError("Invalid terminal data");
        if (!h.viewers.has(key)) return;
        emit({
          type: "terminal.data",
          sessionId: qualifyId(id, event.sessionId),
          viewerId: event.viewerId,
          sequence: event.sequence,
          data: Buffer.from(event.b64, "base64").toString("utf8"),
        });
        return;
      }
      case "terminal.resync": {
        const key = viewerKey();
        if (h.viewers.has(key))
          emit({
            type: "terminal.resync",
            sessionId: qualifyId(id, event.sessionId),
            viewerId: event.viewerId,
          });
        return;
      }
      case "session.exit":
        if (
          typeof event.sessionId !== "string" ||
          !REMOTE_ID.test(event.sessionId) ||
          !Number.isSafeInteger(event.exitCode)
        )
          throw new ProtocolError("Invalid exit event");
        emit({
          type: "session.exit",
          sessionId: qualifyId(id, event.sessionId),
          exitCode: event.exitCode,
        });
        return;
      default:
        // Deny anything else: the connection ends.
        throw new ProtocolError("Unsupported event kind");
    }
  }
  function lost(h: HostState, epoch: number, problem: HostProblem) {
    if (h.epoch !== epoch || closed) return;
    h.conn = undefined;
    h.problem = problem;
    h.state = h.wantConnected ? "reconnecting" : "disconnected";
    resyncViewers(h);
    publish();
    if (h.wantConnected) schedule(h);
  }
  function schedule(h: HostState) {
    clearTimeout(h.timer);
    if (closed || !h.wantConnected) return;
    if (h.attempt >= delays.length) {
      h.state = "disconnected";
      h.wantConnected = false;
      publish();
      return;
    }
    const delay = delays[h.attempt++]!;
    h.state = "reconnecting";
    h.timer = setTimeout(() => void connect(h).catch(() => {}), delay);
    h.timer.unref?.();
  }
  function connect(h: HostState, extra: Pick<ConnectOptions, "approveUpgrade"> = {}) {
    if (h.connecting) return h.connecting;
    if (h.state === "connected" && h.conn) return Promise.resolve();
    clearTimeout(h.timer);
    const epoch = ++h.epoch;
    const reconnecting = h.attempt > 0;
    h.state = reconnecting ? "reconnecting" : "connecting";
    publish();
    h.connecting = (async () => {
      // A loss before the connection is in use is reported by this attempt.
      let early: HostProblem | undefined;
      let live = false;
      try {
        const conn = await connectHost(spec(h), {
          ...extra,
          ...(h.record.remoteHostId ? { expectRemoteHostId: h.record.remoteHostId } : {}),
          onEvent: (event) => onRemoteEvent(h, epoch, event),
          onLost: (problem) => {
            if (live) lost(h, epoch, problem);
            else early = problem;
          },
        });
        if (closed || h.epoch !== epoch || !h.wantConnected) {
          await conn.close();
          if (h.epoch === epoch) {
            h.state = "disconnected";
            publish();
          }
          return;
        }
        const snapshot = await conn.request("invoke", { command: "snapshot", payload: {} });
        if (h.epoch !== epoch) return;
        if (early) throw new HostProblemError(early);
        live = true;
        h.conn = conn;
        h.remote = sanitizeSnapshot(snapshot);
        h.state = "connected";
        h.problem = undefined;
        h.attempt = 0;
        Object.assign(h.record, {
          remoteHostId: h.record.remoteHostId || conn.remoteHostId,
          helperVersion: conn.hello.helperVersion,
          platform: conn.hello.platform,
          protocol: conn.protocol,
          tools: conn.hello.tools,
          probedAt: new Date().toISOString(),
          autoConnect: true,
        });
        await saveRecord(h).catch(() => {});
        await updateRefs(h).catch(() => {});
        publish();
        // Views of this host's sessions reattach to the same remote tmux sessions.
        resyncViewers(h);
      } catch (error) {
        if (h.epoch !== epoch) return;
        clearTimeout(h.timer);
        h.conn = undefined;
        h.problem =
          early ??
          (error instanceof HostProblemError
            ? error.problem
            : { code: "failed", message: (error as Error).message });
        if (h.problem.code === "host-key-unknown")
          h.problem.fingerprints = await hostKeyFingerprints(spec(h)).catch(() => []);
        if (h.wantConnected && h.attempt > 0 && RETRYABLE.has(h.problem.code)) schedule(h);
        else {
          h.state = "disconnected";
          h.wantConnected = false;
          publish();
        }
      } finally {
        if (h.epoch === epoch) h.connecting = undefined;
      }
    })();
    return h.connecting;
  }
  async function disconnect(h: HostState) {
    h.wantConnected = false;
    h.attempt = 0;
    clearTimeout(h.timer);
    h.epoch++;
    h.connecting = undefined;
    const conn = h.conn;
    h.conn = undefined;
    h.state = "disconnected";
    h.problem = undefined;
    if (conn) await conn.close().catch(() => {});
    resyncViewers(h);
    publish();
  }
  function host(hostId: unknown) {
    const h = typeof hostId === "string" ? hosts.get(hostId) : undefined;
    if (!h) throw new Error("That SSH host is not in your list");
    return h;
  }
  function connected(h: HostState) {
    if (h.state !== "connected" || !h.conn)
      throw new Error(
        `${h.record.label} is not connected. Connect it from SSH hosts; its sessions keep running on the host.`,
      );
    return h.conn;
  }
  const fields = (payload: unknown, keys: string[]) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid SSH request");
    const v = payload as Record<string, unknown>;
    if (Object.keys(v).some((k) => !keys.includes(k))) throw new Error("Unexpected SSH field");
    return v;
  };

  async function routeInvoke(command: Command, payload: Record<string, unknown>) {
    if (command === "snapshot") {
      localSnapshot = (await local.invoke("snapshot")) as Snapshot;
      return merged();
    }
    const hostId = routeOf(payload);
    if (!hostId) return local.invoke(command, payload);
    const h = hosts.get(hostId);
    if (!h) throw new Error("That SSH host was removed from your list");
    const refused = REMOTE_REFUSED[command];
    if (refused) throw new Error(refused);
    const remotePayload = toRemote(hostId, payload);
    const key =
      typeof remotePayload.sessionId === "string" && typeof remotePayload.viewerId === "string"
        ? remotePayload.sessionId + "\0" + remotePayload.viewerId
        : undefined;
    if (command === "session.detach" && key) h.viewers.delete(key);
    if (command === "session.attach" && key) {
      if (!h.viewers.has(key) && h.viewers.size >= 256) throw new Error("Viewer limit reached");
      h.viewers.add(key);
    }
    if (h.state !== "connected" || !h.conn) {
      if (command === "session.detach") return { ok: true };
      throw new Error(
        `${h.record.label} is not connected. Its sessions keep running on the host; reconnect from SSH hosts to continue.`,
      );
    }
    const conn = h.conn;
    try {
      // Removing a folder from the list is owner management on the host.
      const result =
        command === "project.hide"
          ? await conn.request("hide", { projectId: remotePayload.projectId })
          : await conn.request("invoke", { command, payload: remotePayload });
      if (command === "layout.save") {
        h.remote = sanitizeSnapshot(result);
        return merged();
      }
      return toLocal(hostId, result);
    } catch (error) {
      if (command === "session.attach" && key && h.conn === conn && h.state === "connected")
        h.viewers.delete(key);
      throw error;
    }
  }

  const router: HostRouter = {
    async invoke(command, payload = {}) {
      if (closed) throw new Error("Core is closed");
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("Invalid payload");
      return routeInvoke(command, payload);
    },
    async createAttachment(input) {
      if (parseQualifiedId(input?.sessionId))
        throw new Error(
          "Pasting images into SSH sessions is not available yet. Nothing was sent; the image stays on this computer.",
        );
      return local.createAttachment(input) as Promise<SavedAttachment>;
    },
    async agentControl(action, payload) {
      if (
        payload &&
        typeof payload === "object" &&
        parseQualifiedId((payload as Record<string, unknown>).sessionId)
      )
        throw new Error("Agent control is only available for sessions on this computer.");
      return local.agentControl(action, payload);
    },
    async ssh(action, payload = {}) {
      if (closed) throw new Error("Core is closed");
      switch (action) {
        case "list":
          fields(payload, []);
          return [...hosts.values()].map(view);
        case "add": {
          const input = validateHostInput(payload);
          if (hosts.size >= 32) throw new Error("At most 32 SSH hosts can be added");
          if (
            [...hosts.values()].some(
              (h) =>
                h.record.alias === input.alias &&
                h.record.user === input.user &&
                h.record.port === input.port &&
                (h.record.dataDir ?? "") === (input.dataDir ?? ""),
            )
          )
            throw new Error("That host is already in your list");
          let id: string;
          do id = crypto.randomBytes(4).toString("hex");
          while (hosts.has(id));
          const record: HostRecord = { id, ...input, createdAt: new Date().toISOString() };
          await local.hostRecords("putHost", record);
          const h: HostState = {
            record,
            state: "disconnected",
            viewers: new Set(),
            wantConnected: false,
            epoch: 0,
            attempt: 0,
          };
          hosts.set(id, h);
          publish();
          return view(h);
        }
        case "probe": {
          const h = host(fields(payload, ["hostId"]).hostId);
          try {
            const conn = await connectHost(spec(h), { probeOnly: true });
            Object.assign(h.record, {
              helperVersion: conn.hello.helperVersion,
              platform: conn.hello.platform,
              protocol: conn.protocol,
              tools: conn.hello.tools,
              probedAt: new Date().toISOString(),
            });
            await saveRecord(h);
            if (h.state !== "connected") h.problem = undefined;
            publish();
            return { ok: true, host: view(h) };
          } catch (error) {
            const problem: HostProblem =
              error instanceof HostProblemError
                ? error.problem
                : { code: "failed", message: (error as Error).message };
            if (problem.code === "host-key-unknown")
              problem.fingerprints = await hostKeyFingerprints(spec(h)).catch(() => []);
            if (h.state !== "connected") h.problem = problem;
            publish();
            return { ok: false, host: view(h), problem };
          }
        }
        case "connect": {
          const v = fields(payload, ["hostId", "approveUpgrade"]);
          if (v.approveUpgrade !== undefined && typeof v.approveUpgrade !== "boolean")
            throw new Error("Invalid SSH request");
          const h = host(v.hostId);
          h.wantConnected = true;
          h.attempt = 0;
          await connect(h, v.approveUpgrade ? { approveUpgrade: true } : {});
          return view(h);
        }
        case "disconnect": {
          const h = host(fields(payload, ["hostId"]).hostId);
          h.record.autoConnect = false;
          await saveRecord(h).catch(() => {});
          await disconnect(h);
          return view(h);
        }
        case "browse": {
          const v = fields(payload, ["hostId", "path"]);
          const h = host(v.hostId);
          if (v.path !== undefined && (typeof v.path !== "string" || v.path.length > 4096))
            throw new Error("Choose a folder from the list");
          return sanitizeListing(
            await connected(h).request("browse", v.path === undefined ? {} : { path: v.path }),
          );
        }
        case "registerProject": {
          const v = fields(payload, ["hostId", "path"]);
          const h = host(v.hostId);
          if (typeof v.path !== "string" || !v.path.startsWith("/") || v.path.length > 4096)
            throw new Error("Choose an absolute folder path on the host");
          const conn = connected(h);
          const project = pick(await conn.request("register", { path: v.path }), {
            id: "id",
            name: "str",
            path: "str",
            createdAt: "str",
          });
          if (!project) throw new ProtocolError("Invalid folder");
          h.remote = sanitizeSnapshot(
            await conn.request("invoke", { command: "snapshot", payload: {} }),
          );
          await updateRefs(h);
          publish();
          return { ...(toLocal(h.record.id, project) as Project), hostId: h.record.id };
        }
        case "remove": {
          const h = host(fields(payload, ["hostId"]).hostId);
          await disconnect(h);
          await local.hostRecords("removeHost", { id: h.record.id });
          hosts.delete(h.record.id);
          refs = refs.filter((r) => r.hostId !== h.record.id);
          publish();
          return { ok: true };
        }
        default:
          throw new Error("Unsupported SSH action");
      }
    },
    onLocalEvent(event) {
      if (closed) return;
      if (event.type === "snapshot") {
        localSnapshot = event.snapshot;
        emit({ type: "snapshot", snapshot: merged() });
      } else emit(event);
    },
    connection: (hostId) => hosts.get(hostId)?.conn,
    hosts: () => [
      { id: "local", invoke: (c, p) => local.invoke(c, p) },
      ...[...hosts.values()].map(
        (h): ExecutionHost => ({
          id: h.record.id,
          invoke: async (command, payload) =>
            toLocal(h.record.id, await connected(h).request("invoke", { command, payload })),
        }),
      ),
    ],
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(
        [...hosts.values()].map(async (h) => {
          clearTimeout(h.timer);
          h.wantConnected = false;
          h.epoch++;
          const conn = h.conn;
          h.conn = undefined;
          await conn?.close();
        }),
      );
    },
  };
  if (options.autoConnect !== false)
    for (const h of hosts.values())
      if (h.record.autoConnect) {
        h.wantConnected = true;
        void connect(h).catch(() => {});
      }
  return router;
}
