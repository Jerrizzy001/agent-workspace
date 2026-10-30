import type { Command } from "./contracts.js";

/**
 * Who may send each core command. "owner": only the local desktop window.
 * "remote": also a paired owner browser through the gateway, within shared
 * projects. The receiving core still validates every payload and resource.
 */
export type CommandAccess = "owner" | "remote";
export const COMMAND_POLICY: Record<Command, CommandAccess> = {
  snapshot: "remote",
  "project.add": "owner",
  "project.hide": "owner",
  "terminal.open": "remote",
  "task.create": "remote",
  "task.update": "remote",
  "attempt.start": "remote",
  "session.attach": "remote",
  "session.detach": "remote",
  "session.input": "remote",
  "session.resize": "remote",
  "session.terminate": "remote",
  "session.capture": "remote",
  "session.ack": "remote",
  "session.rename": "remote",
  "files.list": "remote",
  "files.read": "remote",
  "files.write": "remote",
  "git.status": "remote",
  "git.diff": "remote",
  "git.stage": "remote",
  "git.unstage": "remote",
  "git.commit": "remote",
  "worktree.list": "remote",
  "worktree.create": "remote",
  "layout.save": "remote",
  "note.create": "remote",
  "note.update": "remote",
};
export const remoteAllowed = (command: Command) =>
  COMMAND_POLICY[command] === "remote";
