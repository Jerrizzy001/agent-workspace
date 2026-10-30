export type TaskStatus =
  "backlog" | "ready" | "in_progress" | "review" | "done";
export type Provider = "shell" | "claude" | "codex";
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
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
export interface Session {
  id: string;
  attemptId: string | null;
  projectId: string;
  provider: Provider;
  cwd: string;
  backendName: string;
  generation: number;
  status: "running" | "exited" | "unknown";
  createdAt: string;
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
export const COMMANDS = [
  "snapshot",
  "project.add",
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
export interface WorkspaceAPI {
  invoke<T = unknown>(
    command: Command,
    payload?: Record<string, unknown>,
  ): Promise<T>;
  subscribe(listener: (event: CoreEvent) => void): () => void;
  chooseDirectory(): Promise<string | null>;
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
  close(): void | Promise<void>;
}
