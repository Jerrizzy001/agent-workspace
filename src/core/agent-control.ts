import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Command, Note, Session } from "../shared/contracts.js";
import {
  AWCTL_ENV,
  CONTROLLER_PROTOCOL,
  CONTROLLER_VERBS,
  CONTROL_FILE_ENV,
  GRANT_DEFAULTS,
  GRANT_LIMITS,
  isControllerVerb,
  type AgentControlState,
  type ControllerAudit,
  type ControllerResponse,
  type ControllerVerb,
  type GrantInfo,
} from "../shared/controller-contracts.js";

/**
 * Agent control: the core side of `awctl` (roadmap section 4, class A).
 *
 * Capabilities live only in this process's memory and in one 0600 grant file
 * per session under `<dataDir>/control/grants/`. Every session launched by
 * this version gets `AW_CONTROL_FILE=<that path>` in its own tmux session
 * environment (`new-session -e`), so a process that is already running can
 * be granted later: the owner's grant writes the file, `awctl` reads it on
 * every call, and revoke deletes it and forgets the capability. A core start
 * deletes every grant file; nothing is regranted automatically.
 */
export interface ControllerHost {
  dataDir: string;
  db: DatabaseSync;
  list(kind: string): any[];
  put(kind: string, value: any): void;
  changed(): void;
  /** Runs `fn` in the core's serialized mutation queue. */
  serialize<T>(fn: () => Promise<T> | T): Promise<T>;
  /** A public core command, queued like an owner command. */
  invoke(command: Command, payload: Record<string, unknown>): Promise<unknown>;
  /** The registered folder's canonical root. */
  projectRoot(projectId: string): string;
  /** True when this session was launched with AW_CONTROL_FILE (this version or later). */
  launchedWithControl(sessionId: string): boolean;
  /**
   * `transcript.read`: the owner-approved export behind a directed link to
   * this grant's session. Failures carry `controllerCode`.
   */
  transcriptRead(
    grant: { sessionId: string; generation: number },
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
class ControllerError extends Error {
  constructor(
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
    public outcome: "rejected" | "unknown" = "rejected",
  ) {
    super(message);
  }
}
type Grant = Omit<GrantInfo, "openSessions"> & {
  tokenHash: string;
  requests: number[];
};
const sha = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");
const AUDIT_KEEP = 1000;
const MAX_LIST_ITEMS = 200;

/** Short enough for sun_path on macOS (104 bytes) and Linux (108). */
const MAX_SOCKET_PATH = 100;

function privateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Agent control directory is not a private directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error("Agent control directory belongs to another user");
  fs.chmodSync(dir, 0o700);
}
const shellQuote = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";

export function createAgentControl(host: ControllerHost) {
  const supported = process.platform !== "win32";
  const controlDir = path.join(host.dataDir, "control");
  const grantsDir = path.join(controlDir, "grants");
  const binDir = path.join(controlDir, "bin");
  let socketDir = controlDir;
  if (path.join(controlDir, "ctl.sock").length > MAX_SOCKET_PATH)
    socketDir = path.join(
      os.tmpdir(),
      "aw-ctl-" + sha(host.dataDir).slice(0, 20),
    );
  const socketPath = path.join(socketDir, "ctl.sock");
  const grants = new Map<string, Grant>(); // by tokenHash
  const bySession = new Map<string, Grant>();
  /** Why a capability stopped working, so `awctl` can say so. Bounded. */
  const ended = new Map<string, string>();
  /** Sessions opened through agent control, by source session. */
  const children = new Map<string, Set<string>>();
  const opening = new Map<string, Promise<unknown>>();
  let server: net.Server | undefined;
  let listening: Promise<void> | undefined;
  let closed = false;
  let awctl: string | undefined;

  if (supported) {
    privateDir(controlDir);
    // A core start revokes every grant: remove any grant file a previous core left.
    fs.rmSync(grantsDir, { recursive: true, force: true });
    privateDir(grantsDir);
    if (socketDir !== controlDir) privateDir(socketDir);
    fs.rmSync(socketPath, { force: true });
    const script = process.env.WORKSPACE_AWCTL;
    if (script && fs.existsSync(script)) {
      privateDir(binDir);
      const node = process.env.WORKSPACE_AWCTL_NODE || process.execPath;
      // Electron's own binary runs the CLI as plain Node; an ordinary Node ignores the flag.
      const launcher = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(node)} ${shellQuote(script)} "$@"\n`;
      const target = path.join(binDir, "awctl");
      const temp = target + "." + crypto.randomUUID();
      fs.writeFileSync(temp, launcher, { mode: 0o700 });
      fs.renameSync(temp, target);
      awctl = target;
    }
  }
  const grantFile = (sessionId: string) =>
    path.join(grantsDir, sha("session:" + sessionId).slice(0, 32) + ".json");

  /** Per-session environment for a new tmux session; no capability material. */
  function launchEnvironment(sessionId: string): Record<string, string> {
    if (!supported) return {};
    return {
      [CONTROL_FILE_ENV]: grantFile(sessionId),
      ...(awctl
        ? {
            [AWCTL_ENV]: awctl,
            PATH: binDir + path.delimiter + (process.env.PATH || ""),
          }
        : {}),
    };
  }

  function audit(
    grant: Pick<Grant, "id" | "sessionId" | "projectId">,
    action: string,
    outcome: ControllerAudit["outcome"],
    detail: string,
    ids?: string[],
  ) {
    const record: ControllerAudit = {
      id: crypto.randomUUID(),
      grantId: grant.id,
      sessionId: grant.sessionId,
      projectId: grant.projectId,
      action,
      outcome,
      detail: detail.slice(0, 300),
      ...(ids?.length ? { ids } : {}),
      at: new Date().toISOString(),
    };
    try {
      host.put("controllerAudit", record);
      host.db.exec(
        `DELETE FROM records WHERE kind='controllerAudit' AND rowid NOT IN (SELECT rowid FROM records WHERE kind='controllerAudit' ORDER BY rowid DESC LIMIT ${AUDIT_KEEP})`,
      );
    } catch {
      /* Auditing never changes an action's outcome. */
    }
  }
  function forget(grant: Grant, reason: string) {
    grants.delete(grant.tokenHash);
    if (bySession.get(grant.sessionId) === grant)
      bySession.delete(grant.sessionId);
    ended.set(grant.tokenHash, reason);
    if (ended.size > 1000) ended.delete(ended.keys().next().value!);
    try {
      fs.rmSync(grantFile(grant.sessionId), { force: true });
    } catch {}
  }
  function end(grant: Grant, action: "revoke" | "expire", reason: string) {
    forget(grant, reason);
    audit(grant, action, "ok", reason);
  }
  const sessions = () => host.list("sessions") as Session[];
  const sessionRecord = (id: string) => sessions().find((s) => s.id === id);
  function openChildren(sourceId: string) {
    const ids = children.get(sourceId);
    if (!ids?.size) return 0;
    return sessions().filter((s) => ids.has(s.id) && s.status !== "exited")
      .length;
  }
  function info(grant: Grant): GrantInfo {
    const { tokenHash: _t, requests: _r, ...rest } = grant;
    return { ...rest, openSessions: openChildren(grant.sessionId) };
  }
  /** Expired grants and grants whose session ended or changed generation stop here. */
  function sweep(at = Date.now()) {
    for (const grant of [...grants.values()]) {
      const s = sessionRecord(grant.sessionId);
      if (Date.parse(grant.expiresAt) <= at)
        end(grant, "expire", "Grant expired");
      else if (!s || s.generation !== grant.generation || s.status === "exited")
        end(grant, "revoke", "Source session ended");
    }
  }
  const sweepTimer = setInterval(() => {
    try {
      sweep();
    } catch {}
  }, 15000);
  sweepTimer.unref();

  // ---------- owner (desktop-only) actions ----------
  function state(sessionId: string): AgentControlState {
    sweep();
    const s = sessionRecord(sessionId);
    const grant = bySession.get(sessionId);
    const audits = (host.list("controllerAudit") as ControllerAudit[])
      .filter((a) => a.sessionId === sessionId)
      .slice(-20)
      .reverse();
    const unavailableReason = !supported
      ? "Agent control needs a Unix socket; it is not available on Windows."
      : !s
        ? "Session not found"
        : s.status !== "running"
          ? "Only a running session can be granted control."
          : !host.launchedWithControl(sessionId)
            ? "This session was started before agent control existed. Open a new session to use it."
            : undefined;
    return {
      available: supported,
      ...(unavailableReason ? { unavailableReason } : {}),
      grant: grant ? info(grant) : null,
      audit: audits,
    };
  }
  function exactFields(value: unknown, allowed: string[]) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid agent control request");
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some((k) => !allowed.includes(k)))
      throw new Error("Unexpected agent control field");
    if (
      typeof v.sessionId !== "string" ||
      !v.sessionId ||
      v.sessionId.length > 128
    )
      throw new Error("Session required");
    return v;
  }
  const bounded = (
    v: unknown,
    fallback: number,
    min: number,
    max: number,
    label: string,
  ) => {
    if (v === undefined) return fallback;
    if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max)
      throw new Error(`Invalid ${label}`);
    return v as number;
  };
  async function ensureListening() {
    if (!supported)
      throw new Error("Agent control is not available on this platform");
    if (server) return listening;
    server = net.createServer({ allowHalfOpen: false }, serve);
    server.maxConnections = 32;
    listening = new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => {
        server!.off("error", reject);
        try {
          fs.chmodSync(socketPath, 0o600);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    try {
      await listening;
    } catch (error) {
      server = undefined;
      listening = undefined;
      throw error;
    }
  }
  async function owner(
    action: unknown,
    payload: unknown,
  ): Promise<AgentControlState> {
    if (closed) throw new Error("Core is closed");
    if (action === "list") {
      const v = exactFields(payload, ["sessionId"]);
      return state(String(v.sessionId));
    }
    if (action === "revoke") {
      const v = exactFields(payload, ["sessionId"]);
      const grant = bySession.get(String(v.sessionId));
      if (grant) end(grant, "revoke", "Revoked by owner");
      return state(String(v.sessionId));
    }
    if (action === "allowTranscript") {
      const v = exactFields(payload, ["sessionId", "generation"]);
      const sessionId = String(v.sessionId);
      const current = state(sessionId);
      if (current.unavailableReason) throw new Error(current.unavailableReason);
      if (sessionRecord(sessionId)?.generation !== v.generation)
        throw new Error("Stale session generation");
      const existing = bySession.get(sessionId);
      if (existing) {
        // Preserve token, expiry, budgets and every existing permission. This
        // owner-only action adds just the explicitly approved read capability.
        if (!existing.verbs.includes("transcript.read")) {
          existing.verbs.push("transcript.read");
          audit(
            existing,
            "grant",
            "ok",
            "Owner allowed reading linked context",
          );
          host.changed();
        }
        return state(sessionId);
      }
      return owner("grant", {
        sessionId,
        generation: v.generation,
        verbs: ["transcript.read"],
        expiresInMinutes: 15,
      });
    }
    if (action !== "grant") throw new Error("Unsupported agent control action");
    const v = exactFields(payload, [
      "sessionId",
      "generation",
      "verbs",
      "expiresInMinutes",
      "openLimit",
      "ratePerMinute",
    ]);
    const sessionId = String(v.sessionId);
    const current = state(sessionId);
    if (current.unavailableReason) throw new Error(current.unavailableReason);
    const s = sessionRecord(sessionId)!;
    if (v.generation !== s.generation)
      throw new Error("Stale session generation");
    if (
      !Array.isArray(v.verbs) ||
      !v.verbs.length ||
      v.verbs.length > CONTROLLER_VERBS.length ||
      v.verbs.some((verb) => !isControllerVerb(verb)) ||
      new Set(v.verbs).size !== v.verbs.length
    )
      throw new Error("Choose at least one allowed action");
    const minutes = bounded(
      v.expiresInMinutes,
      GRANT_DEFAULTS.expiresInMinutes,
      GRANT_LIMITS.minMinutes,
      GRANT_LIMITS.maxMinutes,
      "expiry",
    );
    const openLimit = bounded(
      v.openLimit,
      GRANT_DEFAULTS.openLimit,
      1,
      GRANT_LIMITS.maxOpenLimit,
      "open-session limit",
    );
    const ratePerMinute = bounded(
      v.ratePerMinute,
      GRANT_DEFAULTS.ratePerMinute,
      GRANT_LIMITS.minRate,
      GRANT_LIMITS.maxRate,
      "rate budget",
    );
    await ensureListening();
    const previous = bySession.get(sessionId);
    if (previous) end(previous, "revoke", "Replaced by a new grant");
    const token = crypto.randomBytes(32).toString("base64url");
    const grant: Grant = {
      id: crypto.randomUUID(),
      sessionId,
      generation: s.generation,
      projectId: s.projectId,
      verbs: CONTROLLER_VERBS.filter((verb) =>
        (v.verbs as string[]).includes(verb),
      ),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      openLimit,
      ratePerMinute,
      notesCreated: 0,
      tokenHash: sha(token),
      requests: [],
    };
    const file = grantFile(sessionId);
    const temp = file + "." + crypto.randomUUID();
    fs.writeFileSync(
      temp,
      JSON.stringify({
        v: CONTROLLER_PROTOCOL,
        socket: socketPath,
        token,
        sessionId,
        expiresAt: grant.expiresAt,
      }),
      { mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temp, file);
    grants.set(grant.tokenHash, grant);
    bySession.set(sessionId, grant);
    audit(
      grant,
      "grant",
      "ok",
      `Allowed ${grant.verbs.join(", ")} for ${minutes} min` +
        (grant.verbs.includes("open")
          ? `, up to ${openLimit} open sessions`
          : ""),
    );
    return state(sessionId);
  }

  // ---------- agent (A) protocol ----------
  function serve(socket: net.Socket) {
    let buffer = "";
    let done = false;
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    const reply = (response: ControllerResponse) => {
      if (done) return;
      done = true;
      socket.setTimeout(0);
      socket.end(JSON.stringify(response) + "\n");
    };
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > GRANT_LIMITS.requestBytes) {
        reply(
          failure(new ControllerError("too_large", "Request is too large")),
        );
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.setTimeout(0);
      const line = buffer.slice(0, newline);
      void handle(line).then(reply, (error) => reply(failure(error)));
    });
  }
  function failure(error: unknown): ControllerResponse {
    if (error instanceof ControllerError)
      return {
        ok: false,
        error: error.code,
        message: error.message,
        outcome: error.outcome,
        ...error.extra,
      };
    return {
      ok: false,
      error: "failed",
      message:
        error instanceof Error ? error.message.slice(0, 500) : "Request failed",
      outcome: "rejected",
    };
  }
  async function handle(line: string): Promise<ControllerResponse> {
    if (closed)
      throw new ControllerError("unavailable", "Workspace core is closing");
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      throw new ControllerError("bad_request", "Request is not JSON");
    }
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new ControllerError("bad_request", "Invalid request");
    if (request.v !== CONTROLLER_PROTOCOL)
      throw new ControllerError(
        "bad_request",
        "Unsupported awctl protocol version",
      );
    if (
      typeof request.token !== "string" ||
      !request.token ||
      request.token.length > 200
    )
      throw new ControllerError(
        "unauthorized",
        "No agent control capability was presented",
      );
    const tokenHash = sha(request.token);
    const grant = grants.get(tokenHash);
    if (!grant) {
      const reason = ended.get(tokenHash);
      throw reason
        ? new ControllerError(
            reason === "Grant expired" ? "expired" : "revoked",
            `Agent control is no longer granted: ${reason}`,
          )
        : new ControllerError(
            "unauthorized",
            "Unknown agent control capability",
          );
    }
    const at = Date.now();
    if (Date.parse(grant.expiresAt) <= at) {
      end(grant, "expire", "Grant expired");
      throw new ControllerError(
        "expired",
        "Agent control is no longer granted: Grant expired",
      );
    }
    const source = sessionRecord(grant.sessionId);
    if (
      !source ||
      source.generation !== grant.generation ||
      source.status === "exited"
    ) {
      end(grant, "revoke", "Source session ended");
      throw new ControllerError(
        "revoked",
        "Agent control is no longer granted: Source session ended",
      );
    }
    const verb = request.verb;
    if (!isControllerVerb(verb))
      throw new ControllerError("unknown_verb", "Unknown awctl action");
    grant.requests = grant.requests.filter((t) => at - t < 60_000);
    if (grant.requests.length >= grant.ratePerMinute) {
      audit(grant, verb, "denied", "Rate budget exceeded");
      throw new ControllerError(
        "rate_limited",
        "Too many requests; wait a minute",
        {
          ratePerMinute: grant.ratePerMinute,
        },
      );
    }
    grant.requests.push(at);
    if (!grant.verbs.includes(verb)) {
      audit(grant, verb, "denied", "Action not granted");
      throw new ControllerError(
        "not_granted",
        `This grant does not allow "${verb}"`,
        {
          allowed: grant.verbs,
        },
      );
    }
    const args =
      request.args &&
      typeof request.args === "object" &&
      !Array.isArray(request.args)
        ? (request.args as Record<string, unknown>)
        : {};
    const requestId =
      request.requestId === undefined
        ? undefined
        : requestIdOf(request.requestId);
    try {
      const result = await dispatch(grant, verb, args, requestId);
      if (verb !== "status")
        audit(
          grant,
          verb,
          "ok",
          String(result.summary || ""),
          result.ids as string[] | undefined,
        );
      delete result.summary;
      delete result.ids;
      return { ok: true, ...(requestId ? { requestId } : {}), ...result };
    } catch (error) {
      const failed = failure(error);
      if (!failed.ok)
        audit(
          grant,
          verb,
          failed.outcome === "unknown" ? "unknown" : "error",
          failed.message,
        );
      throw error;
    }
  }
  function requestIdOf(v: unknown) {
    if (typeof v !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(v))
      throw new ControllerError(
        "bad_request",
        "--request-id must be 1-128 letters, digits, '.', '_', ':' or '-'",
      );
    return v;
  }
  function argString(
    args: Record<string, unknown>,
    key: string,
    required: boolean,
  ) {
    const v = args[key];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string")
      throw new ControllerError("bad_request", `--${key} is required`);
    return v;
  }
  function plainTitle(v: string) {
    const title = v
      .replace(/[\p{Cc}\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!title || [...title].length > GRANT_LIMITS.noteTitleChars)
      throw new ControllerError(
        "bad_request",
        `Note title must be 1-${GRANT_LIMITS.noteTitleChars} characters`,
      );
    return title;
  }
  function plainBody(v: string) {
    if (v.includes("\0") || Buffer.byteLength(v) > GRANT_LIMITS.noteBodyBytes)
      throw new ControllerError(
        "bad_request",
        `Note body must be text of at most ${GRANT_LIMITS.noteBodyBytes} bytes`,
      );
    return v;
  }
  function revisionArg(args: Record<string, unknown>) {
    const v = args.revision;
    if (!Number.isSafeInteger(v) || (v as number) < 0)
      throw new ControllerError(
        "bad_request",
        "--revision is required (see awctl status)",
      );
    return v as number;
  }
  /** Namespaced mutation receipts in the core's receipts table. */
  function receipt(
    grant: Grant,
    verb: string,
    requestId: string | undefined,
    digest: string,
  ) {
    if (!requestId) return { key: undefined, prior: undefined };
    const key = `ctl:${grant.sessionId}:${verb}:${requestId}`;
    const row = host.db
      .prepare("SELECT digest,result FROM receipts WHERE key=?")
      .get(key) as { digest: string; result: string | null } | undefined;
    if (row && row.digest !== digest)
      throw new ControllerError(
        "request_id_conflict",
        "This --request-id was already used for a different request",
      );
    return { key, prior: row?.result ? JSON.parse(row.result) : undefined };
  }
  function store(key: string | undefined, digest: string, result: unknown) {
    if (key)
      host.db
        .prepare("INSERT OR REPLACE INTO receipts VALUES (?,?,?)")
        .run(key, digest, JSON.stringify(result));
  }
  const layoutOf = (projectId: string) =>
    (
      host.list("layouts") as {
        projectId: string;
        positions: Record<string, { x: number; y: number }>;
        revision?: number;
      }[]
    ).find((l) => l.projectId === projectId);
  const layoutRevision = (projectId: string) => {
    const layout = layoutOf(projectId);
    return layout ? (layout.revision ?? 1) : 0;
  };
  function relativeLocation(root: string, cwd: string) {
    const rel = path.relative(root, cwd);
    if (!rel) return ".";
    if (rel.startsWith("..") || path.isAbsolute(rel)) return "(outside folder)";
    return rel;
  }
  function publicSession(s: Session, root: string) {
    return {
      id: s.id,
      nodeId: s.attemptId || s.id,
      provider: s.provider,
      ...(s.title ? { title: s.title } : {}),
      status: s.status,
      ...(s.activity ? { activity: s.activity } : {}),
      path: relativeLocation(root, s.cwd),
      createdAt: s.createdAt,
    };
  }
  async function dispatch(
    grant: Grant,
    verb: ControllerVerb,
    args: Record<string, unknown>,
    requestId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const projectId = grant.projectId;
    if (verb === "transcript.read") {
      try {
        return await host.transcriptRead(
          { sessionId: grant.sessionId, generation: grant.generation },
          args,
        );
      } catch (error: any) {
        if (error && typeof error.controllerCode === "string")
          throw new ControllerError(
            error.controllerCode,
            String(error.message).slice(0, 500),
          );
        throw error;
      }
    }
    const project = (
      host.list("projects") as { id: string; name: string }[]
    ).find((p) => p.id === projectId);
    if (!project) throw new ControllerError("not_found", "Folder not found");
    if (verb === "status") {
      const root = host.projectRoot(projectId);
      const own = sessions().filter((s) => s.projectId === projectId);
      const running = own.filter((s) => s.status !== "exited");
      const shown = [
        ...running,
        ...own.filter((s) => s.status === "exited").slice(-20),
      ].slice(-MAX_LIST_ITEMS);
      const notes = (host.list("notes") as Note[]).filter(
        (n) => n.projectId === projectId,
      );
      const layout = layoutOf(projectId);
      const nodeIds = new Set([
        ...shown.map((s) => s.attemptId || s.id),
        ...notes.map((n) => n.id),
      ]);
      return {
        project: { id: project.id, name: project.name },
        self: { sessionId: grant.sessionId, generation: grant.generation },
        grant: {
          verbs: grant.verbs,
          expiresAt: grant.expiresAt,
          openLimit: grant.openLimit,
          openSessions: openChildren(grant.sessionId),
          notesCreated: grant.notesCreated,
          notesLimit: GRANT_LIMITS.maxNotes,
        },
        sessions: shown.map((s) => publicSession(s, root)),
        sessionsTruncated: own.length > shown.length,
        notes: notes.slice(-MAX_LIST_ITEMS).map((n) => ({
          id: n.id,
          title: n.title,
          revision: n.revision ?? 1,
          updatedAt: n.updatedAt,
          excerpt: n.body.slice(0, 500),
          ...(n.source ? { source: n.source } : {}),
        })),
        notesTruncated: notes.length > MAX_LIST_ITEMS,
        layout: {
          revision: layout ? (layout.revision ?? 1) : 0,
          positions: Object.fromEntries(
            Object.entries(layout?.positions || {}).filter(([id]) =>
              nodeIds.has(id),
            ),
          ),
        },
      };
    }
    if (verb === "open") {
      const provider = argString(args, "provider", true)!;
      if (!["claude", "codex", "shell"].includes(provider))
        throw new ControllerError(
          "bad_request",
          "--provider must be claude, codex or shell",
        );
      const rel = argString(args, "path", false);
      if (
        rel !== undefined &&
        (rel.length > 4096 || rel.includes("\0") || path.isAbsolute(rel))
      )
        throw new ControllerError(
          "bad_request",
          "--path must be relative to the folder",
        );
      if (!requestId)
        throw new ControllerError(
          "bad_request",
          "--request-id is required for open",
        );
      // One open at a time per source session, so the fan-out check holds.
      const previous = opening.get(grant.sessionId) || Promise.resolve();
      const run = previous
        .catch(() => {})
        .then(async () => {
          const key = `ctl:${grant.sessionId}:open:${requestId}`;
          const known = host.db
            .prepare("SELECT 1 FROM receipts WHERE key=?")
            .get(key);
          if (!known && openChildren(grant.sessionId) >= grant.openLimit)
            throw new ControllerError(
              "open_limit",
              `This grant may keep at most ${grant.openLimit} opened sessions running`,
              {
                openLimit: grant.openLimit,
              },
            );
          let result: { session: Session };
          try {
            // A blank prompt: the new session opens interactively and inherits no grant.
            result = (await host.invoke("terminal.open", {
              projectId,
              provider,
              ...(rel !== undefined ? { path: rel } : {}),
              idempotencyKey: key,
            })) as { session: Session };
          } catch (error: any) {
            const message = String(error?.message || error);
            if (/Idempotency key reused/.test(message))
              throw new ControllerError(
                "request_id_conflict",
                "This --request-id was already used for a different open",
              );
            if (/outcome unknown/i.test(message))
              throw new ControllerError(
                "unknown",
                "The launch outcome is unknown; run awctl status before retrying with the same --request-id",
                {},
                "unknown",
              );
            throw new ControllerError("open_failed", message.slice(0, 500));
          }
          const child = result.session;
          if (!children.has(grant.sessionId))
            children.set(grant.sessionId, new Set());
          children.get(grant.sessionId)!.add(child.id);
          return {
            session: publicSession(child, host.projectRoot(projectId)),
            deduplicated: !!known,
            layoutRevision: layoutRevision(projectId),
            summary: `Opened ${provider} (${child.status})${known ? " (repeat)" : ""}`,
            ids: [child.id],
          };
        });
      opening.set(grant.sessionId, run);
      return run;
    }
    if (verb === "note.create") {
      const title = plainTitle(argString(args, "title", true)!);
      const body = plainBody(argString(args, "body", false) ?? "");
      const digest = sha(JSON.stringify(["note.create", title, body]));
      return host.serialize(() => {
        const { key, prior } = receipt(grant, verb, requestId, digest);
        if (prior) {
          const note = (host.list("notes") as Note[]).find(
            (n) => n.id === prior.noteId,
          );
          return {
            note: note
              ? { id: note.id, title: note.title, revision: note.revision ?? 1 }
              : { id: prior.noteId },
            deduplicated: true,
            layoutRevision: layoutRevision(projectId),
            summary: "Note already created (repeat)",
            ids: [prior.noteId],
          };
        }
        if (grant.notesCreated >= GRANT_LIMITS.maxNotes)
          throw new ControllerError(
            "note_limit",
            `This grant may create at most ${GRANT_LIMITS.maxNotes} notes`,
          );
        const stamp = new Date().toISOString();
        const note: Note = {
          id: crypto.randomUUID(),
          projectId,
          title,
          body,
          revision: 1,
          source: "agent",
          createdAt: stamp,
          updatedAt: stamp,
        };
        host.db.exec("BEGIN IMMEDIATE");
        try {
          host.put("notes", note);
          store(key, digest, { noteId: note.id });
          host.db.exec("COMMIT");
        } catch (error) {
          host.db.exec("ROLLBACK");
          throw error;
        }
        grant.notesCreated++;
        host.changed();
        return {
          note: { id: note.id, title: note.title, revision: 1 },
          layoutRevision: layoutRevision(projectId),
          summary: `Created note "${title.slice(0, 60)}"`,
          ids: [note.id],
        };
      });
    }
    if (verb === "note.update") {
      const noteId = argString(args, "note", true)!;
      const revision = revisionArg(args);
      const title =
        args.title === undefined
          ? undefined
          : plainTitle(argString(args, "title", true)!);
      const body =
        args.body === undefined
          ? undefined
          : plainBody(argString(args, "body", true)!);
      if (title === undefined && body === undefined)
        throw new ControllerError(
          "bad_request",
          "Give --title, --body or --body-file",
        );
      const digest = sha(
        JSON.stringify([
          "note.update",
          noteId,
          revision,
          title ?? null,
          body ?? null,
        ]),
      );
      return host.serialize(() => {
        const { key, prior } = receipt(grant, verb, requestId, digest);
        if (prior)
          return {
            note: prior,
            deduplicated: true,
            summary: "Note already updated (repeat)",
            ids: [noteId],
          };
        const note = (host.list("notes") as Note[]).find(
          (n) => n.id === noteId && n.projectId === projectId,
        );
        if (!note)
          throw new ControllerError("not_found", "No such note in this folder");
        const current = note.revision ?? 1;
        // Never overwrite an edit the agent has not seen.
        if (revision !== current)
          throw new ControllerError(
            "stale_revision",
            "The note changed since that revision; read it again with awctl status",
            {
              currentRevision: current,
            },
          );
        if (title !== undefined) note.title = title;
        if (body !== undefined) note.body = body;
        note.revision = current + 1;
        note.updatedAt = new Date().toISOString();
        const result = {
          id: note.id,
          title: note.title,
          revision: note.revision,
        };
        host.db.exec("BEGIN IMMEDIATE");
        try {
          host.put("notes", note);
          store(key, digest, result);
          host.db.exec("COMMIT");
        } catch (error) {
          host.db.exec("ROLLBACK");
          throw error;
        }
        host.changed();
        return {
          note: result,
          summary: `Updated note "${note.title.slice(0, 60)}"`,
          ids: [note.id],
        };
      });
    }
    // canvas.place
    const requested = argString(args, "node", true)!;
    const revision = revisionArg(args);
    const coordinate = (key: "x" | "y") => {
      const v = args[key];
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        Math.abs(v) > GRANT_LIMITS.coordinate
      )
        throw new ControllerError(
          "bad_request",
          `--${key} must be a number within ±${GRANT_LIMITS.coordinate}`,
        );
      return Math.round(v * 100) / 100;
    };
    const position = { x: coordinate("x"), y: coordinate("y") };
    const digest = sha(
      JSON.stringify(["canvas.place", requested, revision, position]),
    );
    return host.serialize(() => {
      const { key, prior } = receipt(grant, verb, requestId, digest);
      if (prior)
        return {
          ...prior,
          deduplicated: true,
          summary: "Already placed (repeat)",
          ids: [prior.node],
        };
      // Task attempts keep their attempt-keyed node id; folder sessions use the session id.
      const note = (host.list("notes") as Note[]).find(
        (n) => n.id === requested && n.projectId === projectId,
      );
      const session = sessions().find(
        (s) =>
          (s.id === requested || s.attemptId === requested) &&
          s.projectId === projectId,
      );
      const nodeId = note
        ? note.id
        : session
          ? session.attemptId || session.id
          : undefined;
      if (!nodeId)
        throw new ControllerError(
          "not_found",
          "No such canvas node in this folder",
        );
      const layout = layoutOf(projectId);
      const current = layout ? (layout.revision ?? 1) : 0;
      if (revision !== current)
        throw new ControllerError(
          "stale_revision",
          "The canvas layout changed since that revision; read it again with awctl status",
          {
            currentRevision: current,
          },
        );
      const next = {
        projectId,
        positions: { ...(layout?.positions || {}), [nodeId]: position },
        revision: current + 1,
      };
      const result = { node: nodeId, position, layoutRevision: next.revision };
      host.db.exec("BEGIN IMMEDIATE");
      try {
        host.put("layouts", next);
        store(key, digest, result);
        host.db.exec("COMMIT");
      } catch (error) {
        host.db.exec("ROLLBACK");
        throw error;
      }
      host.changed();
      return {
        ...result,
        summary: `Placed ${nodeId.slice(0, 8)} at ${position.x},${position.y}`,
        ids: [nodeId],
      };
    });
  }

  return {
    launchEnvironment,
    owner,
    /** Test and diagnostics only: where the socket lives. */
    socketPath,
    async close() {
      closed = true;
      clearInterval(sweepTimer);
      for (const grant of [...grants.values()])
        forget(grant, "Workspace core stopped");
      if (server) {
        const s = server;
        server = undefined;
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
      try {
        fs.rmSync(socketPath, { force: true });
      } catch {}
    },
  };
}
export type AgentControl = ReturnType<typeof createAgentControl>;
