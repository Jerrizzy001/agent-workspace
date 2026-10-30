/**
 * awctl: lets an agent running inside an Agent Workspace session read its
 * folder's canvas and make the few changes the owner granted.
 *
 * It reads the grant file named by $AW_CONTROL_FILE (written by the core only
 * after the owner grants this session control), sends one JSON request line
 * to the core's private Unix socket and prints the core's JSON answer. It
 * never opens the workspace database.
 *
 * Exit codes: 0 done, 1 refused (nothing changed), 2 usage error,
 * 3 outcome unknown (retry with the same --request-id after `awctl status`).
 */
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import {
  CONTROLLER_PROTOCOL,
  CONTROL_FILE_ENV,
  GRANT_LIMITS,
  type ControllerVerb,
} from "../shared/controller-contracts.js";

const USAGE = `awctl: agent control for Agent Workspace

  awctl status
  awctl open --provider claude|codex|shell [--path <relative folder>] --request-id <id>
  awctl note create --title <text> [--body <text> | --body-file <file|->] [--request-id <id>]
  awctl note update --note <id> --revision <n> [--title <text>] [--body <text> | --body-file <file|->] [--request-id <id>]
  awctl canvas place --node <id> --x <n> --y <n> --revision <layout revision> [--request-id <id>]

Output is one JSON object. Exit 0 done, 1 refused, 2 usage, 3 outcome unknown.
Works only after the owner grants this session agent control in the desktop app.
`;
class Usage extends Error {}
function print(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function fail(error: string, message: string, outcome: "rejected" | "unknown", code: number): never {
  print({ ok: false, error, message, outcome });
  process.exit(code);
}
function parseFlags(args: string[], allowed: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) throw new Usage(`Unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (!allowed.includes(name)) throw new Usage(`Unknown option --${name}`);
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined) throw new Usage(`--${name} needs a value`);
    if (name in flags) throw new Usage(`--${name} given twice`);
    flags[name] = value;
  }
  return flags;
}
function number(flags: Record<string, string>, name: string, integer: boolean) {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)))
    throw new Usage(`--${name} must be a ${integer ? "whole " : ""}number`);
  return value;
}
function body(flags: Record<string, string>) {
  if (flags.body !== undefined && flags["body-file"] !== undefined)
    throw new Usage("Give --body or --body-file, not both");
  if (flags["body-file"] === undefined) return flags.body;
  const file = flags["body-file"];
  const bytes = fs.readFileSync(file === "-" ? 0 : file);
  if (bytes.length > GRANT_LIMITS.noteBodyBytes)
    throw new Usage(`--body-file is larger than ${GRANT_LIMITS.noteBodyBytes} bytes`);
  return bytes.toString("utf8");
}
function parse(argv: string[]): { verb: ControllerVerb; args: Record<string, unknown>; requestId?: string } {
  const [first, second, ...rest] = argv;
  if (first === "status") {
    if (second !== undefined) throw new Usage("status takes no options");
    return { verb: "status", args: {} };
  }
  if (first === "open") {
    const f = parseFlags(argv.slice(1), ["provider", "path", "request-id"]);
    if (!f.provider) throw new Usage("--provider is required");
    if (!f["request-id"]) throw new Usage("--request-id is required for open");
    return {
      verb: "open",
      args: { provider: f.provider, ...(f.path !== undefined ? { path: f.path } : {}) },
      requestId: f["request-id"],
    };
  }
  if (first === "note" && second === "create") {
    const f = parseFlags(rest, ["title", "body", "body-file", "request-id"]);
    if (f.title === undefined) throw new Usage("--title is required");
    const text = body(f);
    return {
      verb: "note.create",
      args: { title: f.title, ...(text !== undefined ? { body: text } : {}) },
      requestId: f["request-id"] || "auto-" + crypto.randomUUID(),
    };
  }
  if (first === "note" && second === "update") {
    const f = parseFlags(rest, ["note", "revision", "title", "body", "body-file", "request-id"]);
    if (!f.note) throw new Usage("--note is required");
    if (f.revision === undefined) throw new Usage("--revision is required (see awctl status)");
    const text = body(f);
    return {
      verb: "note.update",
      args: {
        note: f.note,
        revision: number(f, "revision", true),
        ...(f.title !== undefined ? { title: f.title } : {}),
        ...(text !== undefined ? { body: text } : {}),
      },
      requestId: f["request-id"] || "auto-" + crypto.randomUUID(),
    };
  }
  if (first === "canvas" && second === "place") {
    const f = parseFlags(rest, ["node", "x", "y", "revision", "request-id"]);
    if (!f.node || f.x === undefined || f.y === undefined)
      throw new Usage("--node, --x and --y are required");
    if (f.revision === undefined) throw new Usage("--revision is required (the layout revision from awctl status)");
    return {
      verb: "canvas.place",
      args: {
        node: f.node,
        x: number(f, "x", false),
        y: number(f, "y", false),
        revision: number(f, "revision", true),
      },
      requestId: f["request-id"] || "auto-" + crypto.randomUUID(),
    };
  }
  throw new Usage(first ? `Unknown command "${[first, second].filter(Boolean).join(" ")}"` : "No command given");
}
function grant(): { socket: string; token: string } {
  const file = process.env[CONTROL_FILE_ENV];
  if (!file)
    fail(
      "no_grant",
      `${CONTROL_FILE_ENV} is not set: run awctl inside a session opened by Agent Workspace`,
      "rejected",
      1,
    );
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    fail("no_grant", "Agent control has not been granted to this session (or was revoked)", "rejected", 1);
  }
  try {
    const value = JSON.parse(raw);
    if (value.v !== CONTROLLER_PROTOCOL || typeof value.socket !== "string" || typeof value.token !== "string")
      throw new Error();
    return value;
  } catch {
    fail("no_grant", "The agent control grant file is unreadable", "rejected", 1);
  }
}
function send(socketPath: string, request: unknown, mutating: boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let sent = false;
    let answer = "";
    let settled = false;
    const finish = (value: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    // Once the request left this process a mutation may have happened.
    const lost = (message: string) =>
      finish({
        ok: false,
        error: sent && mutating ? "unknown" : "unavailable",
        message: sent && mutating ? message + "; the outcome is unknown. Run awctl status, then retry with the same --request-id." : message,
        outcome: sent && mutating ? "unknown" : "rejected",
      });
    const timer = setTimeout(() => lost("No answer from Agent Workspace within 90 seconds"), 90_000);
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      // Counted as sent from here on: the core may act on a partial write.
      sent = true;
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("data", (chunk: string) => {
      answer += chunk;
      if (answer.length > 4 * 1024 * 1024) lost("Answer too large");
    });
    socket.on("end", () => {
      try {
        finish(JSON.parse(answer));
      } catch {
        lost("Agent Workspace closed the connection without an answer");
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      lost(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? "Agent Workspace is not accepting agent control requests (is the app running?)"
          : "Connection to Agent Workspace failed: " + error.message,
      ),
    );
  });
}
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    process.exit(argv.length ? 0 : 2);
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    if (error instanceof Usage) {
      process.stderr.write(USAGE);
      fail("usage", error.message, "rejected", 2);
    }
    fail("usage", error instanceof Error ? error.message : String(error), "rejected", 2);
  }
  const { socket, token } = grant();
  const response = await send(
    socket,
    {
      v: CONTROLLER_PROTOCOL,
      token,
      verb: parsed.verb,
      ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
      args: parsed.args,
    },
    parsed.verb !== "status",
  );
  print(response);
  process.exit(response.ok === true ? 0 : response.outcome === "unknown" ? 3 : 1);
}
void main();
