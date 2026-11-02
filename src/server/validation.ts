import { COMMANDS, type Command } from "../shared/contracts.js";
import { remoteAllowed } from "../shared/command-policy.js";
const fields: Record<string, string[]> = {
  snapshot: [],
  "task.create": ["projectId", "title", "description"],
  "task.update": ["taskId", "revision", "title", "description", "status"],
  "attempt.start": [
    "taskId",
    "provider",
    "model",
    "prompt",
    "worktreePath",
    "idempotencyKey",
  ],
  "terminal.open": [
    "projectId",
    "provider",
    "model",
    "prompt",
    "path",
    "worktreePath",
    "resumeSessionId",
    "idempotencyKey",
  ],
  "files.list": ["projectId", "worktreePath", "path"],
  "files.read": ["projectId", "worktreePath", "path"],
  "files.write": [
    "projectId",
    "worktreePath",
    "path",
    "content",
    "expectedHash",
  ],
  "git.status": ["projectId", "worktreePath"],
  "git.diff": ["projectId", "worktreePath", "path", "staged"],
  "git.stage": ["projectId", "worktreePath", "paths"],
  "git.unstage": ["projectId", "worktreePath", "paths"],
  "git.commit": ["projectId", "worktreePath", "message"],
  "worktree.list": ["projectId", "worktreePath"],
  "worktree.create": ["projectId", "branch"],
  "layout.save": ["projectId", "positions"],
  "note.create": ["projectId", "title", "body"],
  "note.update": ["noteId", "projectId", "title", "body", "revision"],
  "session.canvas": ["sessionId", "generation", "hidden"],
  "session.task": ["sessionId", "generation", "taskId"],
  "note.archive": ["noteId", "revision", "archived"],
  "session.rename": ["sessionId", "generation", "title", "titleRevision"],
  "session.place": [
    "sessionId",
    "generation",
    "lane",
    "order",
    "placementRevision",
  ],
  "lane.rename": ["projectId", "laneId", "name", "revision"],
  "lane.add": ["projectId", "name", "revision"],
  "lane.remove": ["projectId", "laneId", "revision"],
};
for (const name of [
  "attach",
  "detach",
  "input",
  "resize",
  "terminate",
  "capture",
  "ack",
])
  fields["session." + name] = [
    "sessionId",
    "generation",
    ...(["attach", "detach", "input", "resize", "terminate", "ack"].includes(
      name,
    )
      ? ["viewerId"]
      : []),
    ...(name === "input"
      ? ["data"]
      : name === "ack"
        ? ["sequence"]
        : ["attach", "resize"].includes(name)
          ? ["cols", "rows"]
          : []),
  ];
const required: Record<string, string[]> = {
  "task.create": ["projectId", "title"],
  "task.update": ["taskId", "revision"],
  "attempt.start": ["taskId", "idempotencyKey"],
  "terminal.open": ["projectId", "provider", "idempotencyKey"],
  "files.write": ["projectId", "path", "content", "expectedHash"],
  "note.create": ["projectId", "title"],
  "note.update": ["noteId"],
  "layout.save": ["projectId", "positions"],
  "git.commit": ["projectId", "message"],
  "worktree.create": ["projectId", "branch"],
  "session.canvas": ["hidden"],
  "session.task": ["taskId"],
  "note.archive": ["noteId", "revision", "archived"],
  "session.rename": ["title", "titleRevision"],
  "session.place": ["lane", "placementRevision"],
  "lane.rename": ["projectId", "laneId", "name", "revision"],
  "lane.add": ["projectId", "name", "revision"],
  "lane.remove": ["projectId", "laneId", "revision"],
};
export function validateCommand(
  command: unknown,
  payload: unknown,
): { command: Command; payload: Record<string, unknown> } {
  if (
    typeof command !== "string" ||
    !COMMANDS.includes(command as Command) ||
    !remoteAllowed(command as Command) ||
    !fields[command]
  )
    throw new Error("Command is not available remotely");
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Invalid payload");
  const p = payload as Record<string, unknown>;
  if (Object.keys(p).some((k) => !fields[command].includes(k)))
    throw new Error("Unexpected command field");
  for (const k of required[command] || [])
    if (p[k] === undefined) throw new Error("Missing " + k);
  if (command.startsWith("session.")) {
    if (
      typeof p.sessionId !== "string" ||
      !Number.isSafeInteger(p.generation) ||
      Number(p.generation) < 1
    )
      throw new Error("Session identity and generation required");
    if (
      fields[command].includes("viewerId") &&
      (typeof p.viewerId !== "string" || !p.viewerId || p.viewerId.length > 128)
    )
      throw new Error("Viewer identity required");
    if (
      command === "session.input" &&
      (typeof p.data !== "string" || Buffer.byteLength(p.data) > 65536)
    )
      throw new Error("Invalid terminal input");
  }
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (
      [
        "generation",
        "revision",
        "titleRevision",
        "placementRevision",
        "sequence",
        "cols",
        "rows",
      ].includes(k)
    ) {
      if (
        !Number.isSafeInteger(v) ||
        Number(v) < 0 ||
        (["cols", "rows"].includes(k) && (Number(v) < 2 || Number(v) > 500))
      )
        throw new Error("Invalid " + k);
    } else if (k === "order") {
      if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e12)
        throw new Error("Invalid order");
    } else if (k === "positions") {
      if (
        !v ||
        typeof v !== "object" ||
        Array.isArray(v) ||
        Object.keys(v).length > 10000 ||
        Object.values(v).some(
          (p: any) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y),
        )
      )
        throw new Error("Invalid positions");
    } else if (k === "paths") {
      if (
        !Array.isArray(v) ||
        v.length > 2000 ||
        v.some(
          (s) => typeof s !== "string" || s.length > 4096 || s.includes("\0"),
        )
      )
        throw new Error("Invalid paths");
    } else if (["staged", "hidden", "archived"].includes(k)) {
      if (typeof v !== "boolean") throw new Error("Invalid staged");
    } else if (k === "expectedHash" && v === null) {
      /* new file */
    } else if (
      typeof v !== "string" ||
      v.includes("\0") ||
      Buffer.byteLength(v) >
        (["content", "body", "description", "prompt"].includes(k)
          ? 2 * 1024 * 1024
          : 65536)
    )
      throw new Error("Invalid " + k);
  }
  if (
    p.provider !== undefined &&
    !["shell", "claude", "codex"].includes(String(p.provider))
  )
    throw new Error("Invalid provider");
  if (
    p.status !== undefined &&
    !["backlog", "ready", "in_progress", "review", "done"].includes(
      String(p.status),
    )
  )
    throw new Error("Invalid task status");
  return { command: command as Command, payload: { ...p } };
}
