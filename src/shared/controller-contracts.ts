/**
 * Agent control (roadmap section 4, authority class A).
 *
 * The owner grants one running session a short-lived capability for a fixed
 * set of verbs in that session's folder. The session's agent uses the `awctl`
 * CLI, which talks to the core over a private Unix socket with a separate,
 * line-delimited JSON protocol. It is not the core command set: no verb maps
 * to terminal input, termination, files, Git, settings, profiles, project
 * registration or grant minting.
 */
export const CONTROLLER_VERBS = [
  "status",
  "open",
  "note.create",
  "note.update",
  "canvas.place",
  "transcript.read",
] as const;
export type ControllerVerb = (typeof CONTROLLER_VERBS)[number];
export const isControllerVerb = (v: unknown): v is ControllerVerb =>
  typeof v === "string" && (CONTROLLER_VERBS as readonly string[]).includes(v);

/** Protocol version spoken by `awctl` and the core's controller socket. */
export const CONTROLLER_PROTOCOL = 1;
/** Environment variable naming the per-session grant file (set at launch). */
export const CONTROL_FILE_ENV = "AW_CONTROL_FILE";
/** Absolute path of the `awctl` launcher, also set at launch. */
export const AWCTL_ENV = "AWCTL";

export const GRANT_DEFAULTS = {
  verbs: ["status", "note.create", "note.update", "canvas.place"] as ControllerVerb[],
  expiresInMinutes: 60,
  openLimit: 3,
  ratePerMinute: 30,
};
export const GRANT_LIMITS = {
  minMinutes: 1,
  maxMinutes: 24 * 60,
  maxOpenLimit: 10,
  minRate: 1,
  maxRate: 600,
  /** Notes one grant may create, whatever its rate budget. */
  maxNotes: 50,
  noteTitleChars: 200,
  noteBodyBytes: 64 * 1024,
  coordinate: 1_000_000,
  requestBytes: 256 * 1024,
  /** Characters one `awctl transcript read` returns at most. */
  transcriptPage: 32 * 1024,
};

/** Options the owner chooses when granting; everything else is fixed by the core. */
export interface GrantRequest {
  sessionId: string;
  generation: number;
  verbs: ControllerVerb[];
  expiresInMinutes?: number;
  openLimit?: number;
  ratePerMinute?: number;
}
/** What the desktop sees about a grant. The capability itself never leaves the core. */
export interface GrantInfo {
  id: string;
  sessionId: string;
  generation: number;
  projectId: string;
  verbs: ControllerVerb[];
  createdAt: string;
  expiresAt: string;
  openLimit: number;
  ratePerMinute: number;
  /** Sessions opened through this grant that are still running. */
  openSessions: number;
  notesCreated: number;
}
/** One persisted controller audit record (schema v5, kind `controllerAudit`). */
export interface ControllerAudit {
  id: string;
  grantId: string;
  sessionId: string;
  projectId: string;
  /** A verb, or "grant" / "revoke" / "expire" for owner and lifecycle events. */
  action: string;
  outcome: "ok" | "denied" | "error" | "unknown";
  detail: string;
  /** Durable IDs the action created or changed. */
  ids?: string[];
  at: string;
}
export interface AgentControlState {
  /** False when this core cannot serve the control socket (for example on Windows). */
  available: boolean;
  /** Why a grant cannot be offered for this session, if it cannot. */
  unavailableReason?: string;
  grant: GrantInfo | null;
  audit: ControllerAudit[];
}
/** Desktop owner only. Remote browsers and agents have no route to this. */
export interface DesktopAgentControlAPI {
  list(target: { sessionId: string }): Promise<AgentControlState>;
  grant(request: GrantRequest): Promise<AgentControlState>;
  revoke(target: { sessionId: string }): Promise<AgentControlState>;
}

/** One request line sent by `awctl`. */
export interface ControllerRequest {
  v: number;
  token: string;
  verb: ControllerVerb;
  requestId?: string;
  args: Record<string, unknown>;
}
/** One response line. `outcome: "unknown"` means the mutation may or may not have happened. */
export type ControllerResponse =
  | ({ ok: true } & Record<string, unknown>)
  | {
      ok: false;
      error: string;
      message: string;
      outcome: "rejected" | "unknown";
      [key: string]: unknown;
    };
