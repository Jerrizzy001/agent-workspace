import type {
  Attempt,
  Capability,
  Project,
  Provider,
  Session,
  Task,
} from "../shared/contracts";

export const providers: Provider[] = ["claude", "codex", "shell"];
export const providerName = (provider: Provider) =>
  provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Shell";
export const providerHint = (provider: Provider) =>
  provider === "claude"
    ? "Claude Code, interactive"
    : provider === "codex"
      ? "Codex CLI, interactive"
      : "Your login shell";

export type Tone = "working" | "needs" | "done" | "idle" | "ended" | "unknown";
/** What a person needs to know about a session at a glance. */
export function sessionState(session: Session): {
  label: string;
  tone: Tone;
  detail: string;
} {
  if (session.status === "exited")
    return {
      label:
        session.exitCode && session.exitCode !== 0
          ? `Exited ${session.exitCode}`
          : "Ended",
      tone: "ended",
      detail: "The process has ended.",
    };
  if (session.status === "unknown")
    return {
      label: "Unknown",
      tone: "unknown",
      detail: "The session backend could not be reached. Reconnect to check.",
    };
  if (!session.activityTracking)
    return {
      label: "Running",
      tone: "idle",
      detail:
        session.provider === "shell"
          ? "Shell is running."
          : "Running. This CLI does not report when it needs you.",
    };
  if (session.activity === "needs")
    return {
      label: "Needs you",
      tone: "needs",
      detail: "Waiting for your answer or permission in the terminal.",
    };
  if (session.activity === "running")
    return { label: "Working", tone: "working", detail: "Working on a turn." };
  if (session.activity === "done")
    return {
      label: "Done",
      tone: "done",
      detail: "Finished its turn. Waiting for your next message.",
    };
  return { label: "Ready", tone: "idle", detail: "Waiting for your first message." };
}

/** Folder-relative location of a session, e.g. "src/lib" or "/" for the folder itself. */
export function sessionLocation(session: Session, project?: Project) {
  if (project && session.cwd === project.path) return "/";
  if (project && session.cwd.startsWith(project.path + "/"))
    return session.cwd.slice(project.path.length + 1);
  const parts = session.cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || session.cwd;
}

export function sessionTitle(
  session: Session,
  attempts: Attempt[],
  tasks: Task[],
) {
  if (session.title) return session.title;
  const attempt = session.attemptId
    ? attempts.find((a) => a.id === session.attemptId)
    : undefined;
  const task = attempt ? tasks.find((t) => t.id === attempt.taskId) : undefined;
  return task ? task.title : providerName(session.provider);
}

export const isOpen = (session: Session) => session.status !== "exited";
/** Open sessions first (needs-you on top), then the most recent ended ones. */
export function orderSessions(sessions: Session[]) {
  const rank = (s: Session) =>
    s.status === "exited"
      ? 3
      : s.activity === "needs"
        ? 0
        : s.status === "unknown"
          ? 2
          : 1;
  return [...sessions].sort(
    (a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt),
  );
}

export function capability(capabilities: Capability[], provider: Provider) {
  if (provider === "shell")
    return capabilities.find((c) => c.name === "tmux");
  return capabilities.find((c) => c.name === provider);
}

export function shortPath(full: string, home?: string) {
  return home && (full === home || full.startsWith(home + "/"))
    ? "~" + full.slice(home.length)
    : full;
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
