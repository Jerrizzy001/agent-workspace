import type { AgentControlState, DesktopAgentControlAPI } from "./controller-contracts.js";
export type TaskStatus =
  "backlog" | "ready" | "in_progress" | "review" | "done";
export type Provider = "shell" | "claude" | "codex";
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  /** Removed from the folder list; files and history are untouched. */
  hidden?: boolean;
  /** Set for a folder on an SSH execution host; `path` is then a path on that host. */
  hostId?: string;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface Attempt {
  id: string;
  taskId: string;
  projectId: string;
  provider: Provider;
  model?: string;
  sessionId: string;
  worktreePath: string;
  status: "running" | "exited" | "unknown";
  createdAt: string;
}
/** Agent turn state reported by provider hooks; absent when the provider cannot report it. */
export type Activity = "running" | "needs" | "done";
export interface Session {
  id: string;
  /** Null for sessions opened directly from a folder rather than a task attempt. */
  attemptId: string | null;
  projectId: string;
  provider: Provider;
  cwd: string;
  backendName: string;
  generation: number;
  status: "running" | "exited" | "unknown";
  createdAt: string;
  model?: string;
  activity?: Activity;
  activityTracking?: boolean;
  /** Epoch ms of the last hook report; a working report is trusted only for a finite lease after it. */
  activityAt?: number;
  /** Claude conversation ID, used to resume the conversation after the process ends. */
  conversationId?: string;
  resumedFrom?: string;
  exitCode?: number;
  /** True when the final screen was saved after the process ended on its own. */
  transcript?: boolean;
  /** Owner-chosen plain-text name; absent shows the default title. */
  title?: string;
  /** Incremented on every rename; `session.rename` must name the current one. */
  titleRevision?: number;
  /** Session-board lane chosen by the owner; absent shows a default lane. */
  lane?: string;
  /** Position within the lane (ascending); absent sorts after placed cards. */
  laneOrder?: number;
  /** Incremented on every placement; `session.place` must name the current one. */
  placementRevision?: number;
  /** Set for a session running on an SSH execution host. */
  hostId?: string;
}
export interface BoardLane {
  id: string;
  name: string;
}
/** Per-folder session-board lanes. Absent until the owner first changes them. */
export interface BoardLanes {
  projectId: string;
  lanes: BoardLane[];
  /** Incremented on every lane change; lane commands must name the current one. */
  revision: number;
}
export interface Note {
  id: string;
  projectId: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** Incremented on every change (schema v5); absent in older records means 1. */
  revision?: number;
  /** "agent" when created through agent control (`awctl note create`). */
  source?: "agent";
}
export interface Layout {
  projectId: string;
  positions: Record<string, { x: number; y: number }>;
  /** Incremented on every save (schema v5); absent in older records means 1. */
  revision?: number;
  [key: string]: unknown;
}
export interface Capability {
  name: string;
  available: boolean;
  detail: string;
}
export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  attempts: Attempt[];
  sessions: Session[];
  notes: Note[];
  layouts: Layout[];
  boardLanes: BoardLanes[];
  capabilities: Capability[];
  /** SSH execution hosts known to this desktop (desktop owner only). */
  hosts?: ExecutionHostView[];
}
export type HostConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";
/** Why a host could not be used, with what the owner can do about it. */
export interface HostProblem {
  code:
    | "host-key-unknown"
    | "host-key-changed"
    | "auth-failed"
    | "unreachable"
    | "helper-missing"
    | "node-missing"
    | "protocol-mismatch"
    | "upgrade-required"
    | "data-in-use"
    | "protocol-error"
    | "connection-lost"
    | "failed";
  message: string;
  /** Host key fingerprints offered by the server, for out-of-band checking. */
  fingerprints?: string[];
}
export interface ExecutionHostView {
  id: string;
  /** OpenSSH host alias from the owner's configuration. */
  alias: string;
  label: string;
  user?: string;
  port?: number;
  /** Helper install folder on the host. */
  helperPath: string;
  /** Optional dedicated helper data folder on the host. */
  dataDir?: string;
  state: HostConnectionState;
  problem?: HostProblem;
  /** Last successful probe or connection. */
  helperVersion?: string;
  platform?: string;
  protocol?: number;
  remoteHostId?: string;
  tools?: { name: string; available: boolean; detail: string }[];
  probedAt?: string;
  /** Remote tool availability reported by the connected host's core. */
  capabilities?: Capability[];
}
export interface HostProbeResult {
  ok: boolean;
  host: ExecutionHostView;
  problem?: HostProblem;
}
export interface DesktopSSHAPI {
  list(): Promise<ExecutionHostView[]>;
  add(input: {
    alias: string;
    label?: string;
    user?: string;
    port?: number;
    helperPath?: string;
    dataDir?: string;
  }): Promise<ExecutionHostView>;
  probe(hostId: string): Promise<HostProbeResult>;
  connect(hostId: string, options?: { approveUpgrade?: boolean }): Promise<ExecutionHostView>;
  disconnect(hostId: string): Promise<ExecutionHostView>;
  browse(hostId: string, path?: string): Promise<DirectoryListing>;
  registerProject(hostId: string, path: string): Promise<Project>;
  remove(hostId: string): Promise<void>;
}
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}
export interface FileContent {
  path: string;
  content: string;
  hash: string;
}
export interface GitStatus {
  branch: string;
  files: { path: string; index: string; working: string }[];
}
export interface Worktree {
  path: string;
  branch: string;
  head: string;
  managed?: boolean;
}
export type CoreEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | {
      type: "terminal.data";
      sessionId: string;
      viewerId: string;
      sequence: number;
      data: string;
    }
  | { type: "terminal.resync"; sessionId: string; viewerId: string }
  | { type: "session.exit"; sessionId: string; exitCode: number }
  | {
      type: "core.status";
      status: "starting" | "ready" | "restarting" | "failed";
      message?: string;
    };
export interface DirectoryEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  hidden: boolean;
  git?: boolean;
}
export interface DirectoryListing {
  path: string;
  parent: string | null;
  home: string;
  git: boolean;
  entries: DirectoryEntry[];
  truncated: boolean;
  places: { name: string; path: string }[];
}
export const COMMANDS = [
  "snapshot",
  "project.add",
  "project.hide",
  "terminal.open",
  "task.create",
  "task.update",
  "attempt.start",
  "session.attach",
  "session.detach",
  "session.input",
  "session.resize",
  "session.terminate",
  "session.capture",
  "session.ack",
  "session.rename",
  "session.place",
  "lane.rename",
  "lane.add",
  "lane.remove",
  "files.list",
  "files.read",
  "files.write",
  "git.status",
  "git.diff",
  "git.stage",
  "git.unstage",
  "git.commit",
  "worktree.list",
  "worktree.create",
  "layout.save",
  "note.create",
  "note.update",
  "settings.read",
  "settings.write",
  "assist.status",
  "assist.preview",
  "assist.suggest",
  "assist.cancel",
] as const;
export type Command = (typeof COMMANDS)[number];
export interface RemoteConfig {
  host: string;
  port: number;
  publicOrigin?: string;
  tls: boolean;
}
export interface RemoteStatus {
  enabled: boolean;
  host: string;
  port: number;
  url: string;
  publicOrigin?: string;
  tls: boolean;
  coreStatus: "starting" | "ready" | "restarting" | "failed";
  certificateName?: string;
  keyName?: string;
  sharedProjects: { id: string; name: string }[];
}
export interface DesktopRemoteAPI {
  status(): Promise<RemoteStatus>;
  enable(config: RemoteConfig): Promise<RemoteStatus>;
  disable(): Promise<RemoteStatus>;
  pairingSecret(): Promise<string>;
  revokeSessions(): Promise<void>;
  chooseTLSFile(kind: "certificate" | "key"): Promise<RemoteStatus>;
}
export interface ClipboardImagePreview {
  /** Short-lived handle for the validated image held by the desktop main process. */
  token: string;
  width: number;
  height: number;
  bytes: number;
  /** Small PNG data URL for the confirmation dialog. */
  thumbnail: string;
}
export interface SavedAttachment {
  id: string;
  /** Absolute host path of the private PNG. */
  path: string;
  bytes: number;
  sha256: string;
}
/** Desktop owner only: reads one clipboard image after a user gesture. */
export interface ClipboardImageAPI {
  /** Null when the clipboard holds no image. */
  preview(): Promise<ClipboardImagePreview | null>;
  save(target: {
    token: string;
    sessionId: string;
    generation: number;
  }): Promise<SavedAttachment>;
  discard(token: string): Promise<void>;
}
/** Owner preferences stored by the core; never exposed through the remote gateway. */
export interface OwnerSettings {
  keepAwake: boolean;
  /** English Whisper model used for local dictation (see DICTATION_MODEL_IDS). */
  dictationModel: string;
  /** AI suggestions provider: "" (off, the default), "claude" or "codex". */
  assistProvider: string;
  /** Optional model for AI suggestions; blank uses the CLI's own default. */
  assistModel: string;
}
export type AssistProviderName = "claude" | "codex";
export interface AssistAdapterStatus {
  provider: AssistProviderName;
  state: "ready" | "unverified" | "unavailable";
  executable: string;
  version: string;
  missing: string[];
  detail: string;
}
export interface AssistStatus {
  /** "" while AI suggestions are off. */
  provider: AssistProviderName | "";
  model: string;
  adapters: AssistAdapterStatus[];
  running: boolean;
}
export interface AssistOmission {
  path: string;
  reason: "binary" | "excluded" | "size limit" | "file limit";
}
export interface AssistCommitPreview {
  kind: "commit";
  provider: AssistProviderName;
  model: string;
  /** Fingerprint of HEAD and the staged blobs the preview was read from. */
  stagedHash: string;
  files: {
    path: string;
    status: string;
    bytes: number;
    included: boolean;
    reason?: AssistOmission["reason"];
  }[];
  omitted: AssistOmission[];
  /** Exactly the text sent to the provider on stdin. */
  input: string;
  inputHash: string;
  bytes: number;
  limit: number;
}
export type AssistNameSource = "task" | "firstMessage" | "folder";
export interface AssistNamePreview {
  kind: "name";
  provider: AssistProviderName;
  model: string;
  sessionId: string;
  generation: number;
  titleRevision: number;
  /** Context the owner may choose to share; never terminal output. */
  sources: { id: AssistNameSource; label: string; text: string }[];
  input: string;
  inputHash: string;
}
export interface AssistCommitSuggestion {
  kind: "commit";
  message: string;
  stagedHash: string;
  inputHash: string;
}
export interface AssistNameSuggestion {
  kind: "name";
  name: string;
  sessionId: string;
  generation: number;
  titleRevision: number;
  inputHash: string;
}
export interface AssistCommitSelection {
  projectId: string;
  worktreePath?: string;
  exclude?: string[];
}
export interface AssistNameSelection {
  sessionId: string;
  include: AssistNameSource[];
}
/**
 * Desktop owner only: opt-in commit message and session name suggestions from
 * the owner's installed provider CLI. No route exists through the gateway.
 */
export interface DesktopAssistAPI {
  status(): Promise<AssistStatus>;
  configure(input: {
    provider: AssistProviderName | "";
    model: string;
    acknowledged: boolean;
  }): Promise<AssistStatus>;
  previewCommit(input: AssistCommitSelection): Promise<AssistCommitPreview>;
  /** Cheap staleness check: the current staged fingerprint. */
  stagedHash(input: {
    projectId: string;
    worktreePath?: string;
  }): Promise<{ stagedHash: string }>;
  suggestCommit(
    input: AssistCommitSelection & { inputHash: string; stagedHash: string },
  ): Promise<AssistCommitSuggestion>;
  previewName(input: AssistNameSelection): Promise<AssistNamePreview>;
  suggestName(
    input: AssistNameSelection & { inputHash: string },
  ): Promise<AssistNameSuggestion>;
  cancel(): Promise<void>;
}
export interface PowerStatus {
  enabled: boolean;
  /** True while this app holds a power-save blocker. */
  active: boolean;
  /** Local sessions with a fresh working report. */
  sessions: string[];
}
export interface DesktopPowerAPI {
  status(): Promise<PowerStatus>;
  setEnabled(enabled: boolean): Promise<PowerStatus>;
  onStatus(listener: (status: PowerStatus) => void): () => void;
}
export interface DictationModelInfo {
  id: string;
  label: string;
  description: string;
  /** Bytes fetched by the download (compressed archive). */
  downloadBytes: number;
  /** Bytes kept on disk after unpacking. */
  diskBytes: number;
  installed: boolean;
  /** Archive address, publisher and license shown before consent. */
  source: string;
  provenance: string;
  license: string;
  sha256: string;
}
export interface DictationDownload {
  modelId: string;
  phase: "downloading" | "verifying" | "unpacking" | "done" | "failed";
  received: number;
  total: number;
  error?: string;
}
export interface DictationStatus {
  models: DictationModelInfo[];
  /** The owner's chosen model (settings key `dictationModel`). */
  selected: string;
  download: DictationDownload | null;
  /** "sherpa-onnx" for real local inference; "fixture" only in tests. */
  engine: string;
  engineError?: string;
  recording: boolean;
}
/**
 * Desktop owner only: local speech-to-text. Audio stays in memory and is
 * transcribed on this computer; no route exists through the remote gateway.
 */
export interface DesktopDictationAPI {
  status(): Promise<DictationStatus>;
  /** Explicit, consented download of one model from its pinned address. */
  downloadModel(modelId: string): Promise<DictationStatus>;
  start(): Promise<{ recordingId: string; modelId: string }>;
  /** One phrase of 16 kHz mono 16-bit PCM; resolves with its cleaned text. */
  phrase(input: {
    recordingId: string;
    sequence: number;
    pcm: Int16Array;
  }): Promise<{ text: string }>;
  stop(recordingId: string): Promise<void>;
  onStatus(listener: (status: DictationStatus) => void): () => void;
}
export interface WorkspaceAPI {
  invoke<T = unknown>(
    command: Command,
    payload?: Record<string, unknown>,
  ): Promise<T>;
  subscribe(listener: (event: CoreEvent) => void): () => void;
  chooseDirectory(): Promise<string | null>;
  /** Desktop owner only: lists a host folder for in-app navigation. */
  browseDirectory?(path?: string): Promise<DirectoryListing>;
  remote?: DesktopRemoteAPI;
  clipboardImage?: ClipboardImageAPI;
  /** Desktop owner only: keep the computer awake while local agents work. */
  power?: DesktopPowerAPI;
  /** Desktop owner only: local voice dictation into a terminal. */
  dictation?: DesktopDictationAPI;
  /** Desktop owner only: grant a session's agent the `awctl` CLI. */
  agentControl?: DesktopAgentControlAPI;
  /** Desktop owner only: opt-in AI commit messages and session names. */
  assist?: DesktopAssistAPI;
  /** Desktop owner only: SSH execution hosts and their folders. */
  ssh?: DesktopSSHAPI;
}
declare global {
  interface Window {
    workspace: WorkspaceAPI;
  }
}
export interface CoreOptions {
  dataDir: string;
  emit: (event: CoreEvent) => void;
}
export interface Core {
  invoke(command: Command, payload?: Record<string, unknown>): Promise<unknown>;
  /** Trusted desktop broker only; never reachable as a public command. */
  createAttachment(input: {
    sessionId: string;
    generation: number;
    data: Uint8Array;
  }): Promise<SavedAttachment>;
  /** Trusted desktop broker only: grant, revoke and list agent control. */
  agentControl(action: unknown, payload: unknown): Promise<AgentControlState>;
  /** Trusted desktop host router only: stored SSH hosts and remote folder references. */
  hostRecords(action: unknown, payload?: unknown): Promise<unknown>;
  close(): void | Promise<void>;
}
/**
 * Where project commands execute. The local core and each connected SSH host
 * implement it; the host router picks one per command from opaque IDs.
 */
export interface ExecutionHost {
  readonly id: string;
  invoke(command: Command, payload: Record<string, unknown>): Promise<unknown>;
}
