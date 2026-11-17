import type { Command } from "./contracts.js";
import type { ControllerVerb } from "./controller-contracts.js";

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
  "task.delete": "owner",
  "note.read": "remote",
  "note.delete": "owner",
  "history.prune": "owner",
  "history.list": "owner",
  "history.restore": "owner",
  "backup.export": "owner",
  "worktree.remove": "owner",
  "attempt.start": "remote",
  "session.attach": "remote",
  "session.detach": "remote",
  "session.input": "remote",
  "session.resize": "remote",
  "session.terminate": "remote",
  "session.capture": "remote",
  "session.ack": "remote",
  "session.rename": "remote",
  "session.canvas": "remote",
  "session.confirmIdle": "owner",
  "session.task": "remote",
  "session.place": "remote",
  "lane.rename": "remote",
  "lane.add": "remote",
  "lane.remove": "remote",
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
  "note.archive": "remote",
  "settings.read": "owner",
  "settings.write": "owner",
  // AI suggestions spend the owner's provider usage: desktop window only.
  "assist.status": "owner",
  "assist.preview": "owner",
  "assist.suggest": "owner",
  "assist.cancel": "owner",
  // Branches and transcript links (roadmap section 3): desktop owner only
  // until an explicit sharing policy exists. Profiles have no command at all;
  // they go through the owner-only `workspace:profiles` channel.
  "conversation.fork": "owner",
  "transcript.preview": "owner",
  "transcript.link": "owner",
  "transcript.revoke": "owner",
  "transcript.list": "owner",
};
export const remoteAllowed = (command: Command) =>
  COMMAND_POLICY[command] === "remote";

/**
 * Class A (agent control) is not a core command and has no entry above: the
 * desktop grants it through the owner-only `workspace:agent-control` IPC, and
 * `awctl` speaks a separate protocol on a private Unix socket. Each verb wraps
 * at most one existing behaviour, listed here so tests can check that no verb
 * reaches terminal input, termination, files, Git, settings or projects.
 */
export const CONTROLLER_WRAPS: Record<ControllerVerb, Command | null> = {
  status: null,
  open: "terminal.open",
  "note.create": "note.create",
  "note.update": "note.update",
  "canvas.place": "layout.save",
  // Reads an owner-approved export through a directed link; no core command.
  "transcript.read": null,
};
