/**
 * A stand-in for the `claude` CLI used by tests and verification scripts. It
 * never contacts a provider. It honors CLAUDE_CONFIG_DIR the way the real CLI
 * does for storage (falling back to ~/.claude), writes a Claude-style JSONL
 * transcript under `<config>/projects/<folder>/<conversation id>.jsonl`, and
 * runs the hook commands it was given with `--settings` (SessionStart with the
 * documented JSON on stdin, UserPromptSubmit and Stop around each turn).
 *
 * Install as `claude` with a shebang that requires this file. Environment:
 *   CLAUDE_FIXTURE_LOG      append {args, cwd, env} per start
 *   CLAUDE_FIXTURE_CONTROL  JSON file with {"mode": ...}, read at start:
 *     "normal" (default) | "exit-before-report" | "report-original" |
 *     "no-report" | "partial-line"
 *   CLAUDE_FIXTURE_NO_FORK  when set, --help omits --fork-session
 * Each line typed into its terminal becomes one turn with a fixed reply.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  console.log(
    args.includes("--help")
      ? "--json Output authentication status"
      : JSON.stringify({
          loggedIn: true,
          email: "fixture@example.invalid",
          authMethod: "fixture",
          accessToken: "NEVER_RETURN_FIXTURE_TOKEN",
        }),
  );
  process.exit(0);
}

if (args[0] === "--help") {
  process.stdout.write(
    [
      "Usage: claude [options] [command] [prompt]",
      "  --model <model>",
      "  -r, --resume [value]     Resume a conversation by session ID",
      process.env.CLAUDE_FIXTURE_NO_FORK
        ? ""
        : "  --fork-session           When resuming, create a new session ID",
      "  --session-id <uuid>",
      "  --settings <file-or-json>",
      "",
    ].join("\n"),
  );
  process.exit(0);
}
const configDir =
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
let control = {};
try {
  control = JSON.parse(
    fs.readFileSync(process.env.CLAUDE_FIXTURE_CONTROL, "utf8"),
  );
} catch {}
const mode = control.mode || "normal";
if (process.env.CLAUDE_FIXTURE_LOG)
  fs.appendFileSync(
    process.env.CLAUDE_FIXTURE_LOG,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      pid: process.pid,
      env: {
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
        HOME: process.env.HOME ?? null,
      },
    }) + "\n",
  );
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
};
const settings = flag("--settings")
  ? JSON.parse(flag("--settings"))
  : { hooks: {} };
const resumed = flag("--resume");
const forking = args.includes("--fork-session");
const dash = args.indexOf("--");
const prompt = dash >= 0 ? args[dash + 1] : undefined;
const id = forking
  ? crypto.randomUUID()
  : resumed || flag("--session-id") || crypto.randomUUID();
const folder = path.join(
  configDir,
  "projects",
  process.cwd().replace(/[^A-Za-z0-9]/g, "-"),
);
const transcript = path.join(folder, id + ".jsonl");
fs.mkdirSync(folder, { recursive: true });
// Claude's own settings file, so a profile folder is no longer empty.
fs.writeFileSync(
  path.join(configDir, "fixture-settings.json"),
  JSON.stringify({ fixture: true }) + "\n",
);
if (forking) {
  // Copy the original conversation, as a branch starts from it.
  const projects = path.join(configDir, "projects");
  for (const dir of fs.readdirSync(projects)) {
    const source = path.join(projects, dir, resumed + ".jsonl");
    if (fs.existsSync(source)) {
      const lines = fs
        .readFileSync(source, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.stringify({ ...JSON.parse(line), sessionId: id });
          } catch {
            return "";
          }
        })
        .filter(Boolean);
      fs.writeFileSync(transcript, lines.map((l) => l + "\n").join(""));
      break;
    }
  }
}
const run = (event, input) => {
  for (const entry of settings.hooks?.[event] || [])
    for (const hook of entry.hooks || [])
      try {
        execSync(hook.command, {
          input: JSON.stringify(input),
          stdio: ["pipe", "ignore", "ignore"],
          shell: "/bin/sh",
        });
      } catch {}
};
if (mode === "exit-before-report") {
  process.stderr.write("fixture claude: failed before starting\n");
  process.exit(4);
}
const base = {
  session_id: id,
  transcript_path: transcript,
  cwd: process.cwd(),
};
if (mode !== "no-report")
  run("SessionStart", {
    ...base,
    hook_event_name: "SessionStart",
    source: resumed ? "resume" : "startup",
    ...(mode === "report-original" ? { session_id: resumed || id } : {}),
  });
const record = (type, text) =>
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      type,
      sessionId: id,
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message:
        type === "user"
          ? { role: "user", content: text }
          : { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n",
  );
function turn(text) {
  run("UserPromptSubmit", {
    ...base,
    hook_event_name: "UserPromptSubmit",
    prompt: text,
  });
  record("user", text);
  if (text === "/fixture-error") {
    record("assistant", "Fixture API error: requested model unavailable");
    process.stdout.write("Fixture API error: requested model unavailable\r\n");
    run("StopFailure", {
      ...base,
      hook_event_name: "StopFailure",
      error: "model_not_found",
    });
    return;
  }

  record("assistant", `Fixture reply to: ${text}`);
  if (mode === "partial-line")
    fs.appendFileSync(
      transcript,
      '{"type":"assistant","message":{"role":"assis',
    );
  run("Stop", { ...base, hook_event_name: "Stop" });
}
process.stdout.write(
  `fixture claude ${id.slice(0, 8)} (${forking ? "branch" : resumed ? "resumed" : "new"})\r\n`,
);
if (prompt) turn(prompt);
let typed = "";
process.stdin.setEncoding("utf8");
try {
  process.stdin.setRawMode?.(false);
} catch {}
process.stdin.on("data", (chunk) => {
  typed += chunk;
  let at;
  while ((at = typed.search(/[\r\n]/)) >= 0) {
    const line = typed.slice(0, at).trim();
    typed = typed.slice(at + 1);
    if (line === "/exit") process.exit(0);
    if (line) turn(line);
  }
});
setInterval(() => {}, 1000);
