export function providerModel(
  provider: string,
  requested?: unknown,
): string | undefined {
  if (requested === undefined) return undefined;
  if (
    typeof requested !== "string" ||
    /[\r\n\0]/.test(requested) ||
    Buffer.byteLength(requested) > 200
  )
    throw new Error("Invalid provider model");
  const model = requested.trim();
  if (!model) return undefined;
  if (provider === "shell")
    throw new Error("Shell sessions do not support a model");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))
    throw new Error("Invalid provider model");
  return model;
}
/** A blank or absent prompt opens the provider interactively; nothing is submitted for the user. */
export function initialPrompt(requested: unknown): string | undefined {
  if (requested === undefined) return undefined;
  if (
    typeof requested !== "string" ||
    requested.includes("\0") ||
    Buffer.byteLength(requested) > 65536
  )
    throw new Error("Invalid initial prompt");
  return requested.trim() ? requested : undefined;
}
export interface LaunchOptions {
  prompt?: unknown;
  model?: unknown;
  /**
   * Claude conversation identity: a new `--session-id`, `--resume` of an
   * earlier one, or `--resume <id> --fork-session` (a branch with a new ID the
   * CLI chooses and reports through the SessionStart hook).
   */
  conversation?: { id: string; resume: boolean; fork?: boolean };
  /** Codex: open its own resume picker instead of a new conversation. */
  resumePicker?: boolean;
  /** Claude per-session settings JSON (status hooks); never written to global config. */
  settings?: string;
}
/** Interactive argv verified against installed CLI --help. Prompts stay literal after `--`. */
export function launchArguments(
  provider: string,
  options: LaunchOptions = {},
): string[] {
  const model = providerModel(provider, options.model);
  if (provider === "shell") return [];
  const prompt = initialPrompt(options.prompt);
  if (provider === "codex" && options.resumePicker) return ["resume"];
  const conversation =
    provider === "claude" && options.conversation
      ? options.conversation.fork
        ? ["--resume", conversationIdText(options.conversation.id), "--fork-session"]
        : options.conversation.resume
          ? ["--resume", options.conversation.id]
          : ["--session-id", options.conversation.id]
      : [];
  return [
    ...(model ? ["--model", model] : []),
    ...conversation,
    ...(provider === "claude" && options.settings
      ? ["--settings", options.settings]
      : []),
    ...(prompt ? ["--", prompt] : []),
  ];
}
/** Task attempts default to the task text; an explicit blank prompt launches interactively. */
export function providerArguments(
  provider: string,
  task: { title: string; description: string },
  requested?: unknown,
  requestedModel?: unknown,
): string[] {
  return launchArguments(provider, {
    model: requestedModel,
    prompt:
      requested === undefined
        ? [task.title, task.description].filter(Boolean).join("\n\n")
        : requested,
  });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Claude conversation IDs the app passes or accepts are lowercase UUIDs, nothing else. */
export function conversationIdText(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error("Invalid conversation ID");
  return value;
}
export const isConversationId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
/** Pane option where the SessionStart hook leaves the CLI's first start report. */
export const SESSION_START_OPTION = "@aw_session_start";
/** Bytes of hook input kept; a real SessionStart report is a few hundred bytes. */
export const SESSION_START_LIMIT = 8192;
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/**
 * Claude hook settings that record the agent's turn state as a tmux pane option.
 * The hook runs inside the session's own pane, so `$TMUX` already names the private socket.
 * Each report also stamps `@aw_activity_at` (epoch seconds) so a working state can expire.
 */
export function claudeActivitySettings(tmux: string): string {
  const set = (state: "running" | "needs" | "done") =>
    `${quote(tmux)} set-option -p @aw_activity ${state} \\; set-option -p @aw_activity_at "$(date +%s)" >/dev/null 2>&1 || true`;
  const hook = (state: "running" | "needs" | "done", matcher?: string) => [
    {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: set(state) }],
    },
  ];
  // SessionStart: the CLI writes a JSON report (session_id, transcript_path,
  // source, ...) to the hook's stdin. The hook stores it, bounded and on one
  // line, as a pane option the first time only; the core parses and validates
  // it. Nothing in the report is interpreted by the shell.
  const t = quote(tmux);
  const start =
    `r="$(head -c ${SESSION_START_LIMIT} | tr -d '\\r\\n')"; ` +
    `[ -n "$(${t} show-options -pqv ${SESSION_START_OPTION} 2>/dev/null)" ] || ` +
    `${t} set-option -p ${SESSION_START_OPTION} "$r" >/dev/null 2>&1 || true`;
  return JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: start }] }],
      UserPromptSubmit: hook("running"),
      PostToolUse: hook("running", "*"),
      Notification: hook("needs", "permission_prompt|elicitation_dialog"),
      Stop: hook("done"),
    },
  });
}
