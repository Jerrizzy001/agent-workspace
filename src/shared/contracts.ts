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
}
export interface Note {
  id: string;
  projectId: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
export interface Layout {
  projectId: string;
  positions: Record<string, { x: number; y: number }>;
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
  capabilities: Capability[];
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
  close(): void | Promise<void>;
}
