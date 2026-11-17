/**
 * Connections to SSH execution hosts through the system OpenSSH client.
 *
 * The client runs unmodified with a fixed option set: `ssh -T`, strict host
 * key checking, no agent/X11/port forwarding, no connection sharing, bounded
 * timeouts and batch mode. The owner chooses only an alias from their own
 * OpenSSH configuration plus narrowly validated user/port overrides and helper
 * folders. Unknown or changed host keys are reported with fingerprints and
 * never accepted or written to any known_hosts file by the app.
 */
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  encodeFrame,
  FrameDecoder,
  HELPER_KINDS,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
  ProtocolError,
  type HostHello,
  type HostTool,
  type HelperOp,
} from "../shared/host-protocol.js";
import type { HostProblem } from "../shared/contracts.js";

export interface HostSpec {
  id: string;
  alias: string;
  user?: string;
  port?: number;
  helperPath: string;
  dataDir?: string;
}
export const DEFAULT_HELPER_PATH = "~/agent-workspace-server";
const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const USER = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
const REMOTE_PATH = /^(?:~\/|\/)[A-Za-z0-9._\/+-]{0,400}$/;

function remotePath(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !REMOTE_PATH.test(value) ||
    value.split("/").some((part) => part === "..") ||
    value.includes("//")
  )
    throw new Error(
      `${label} must be an absolute path or start with ~/, using letters, digits, ".", "_", "-", "+" and "/" only`,
    );
  return value.replace(/\/+$/, "") || "/";
}
/** Owner input for a new host. Anything that is not a plain field is refused. */
export function validateHostInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid host");
  const v = input as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        !["alias", "label", "user", "port", "helperPath", "dataDir"].includes(
          k,
        ),
    )
  )
    throw new Error("Unexpected host field");
  if (typeof v.alias !== "string" || !ALIAS.test(v.alias))
    throw new Error(
      "Enter a host alias from your SSH configuration (letters, digits, '.', '_' and '-'; it cannot start with '-')",
    );
  const label =
    v.label === undefined || v.label === ""
      ? v.alias
      : typeof v.label === "string"
        ? v.label
            .replace(/[\p{Cc}]/gu, " ")
            .trim()
            .slice(0, 60)
        : undefined;
  if (!label) throw new Error("Invalid label");
  if (
    v.user !== undefined &&
    v.user !== "" &&
    (typeof v.user !== "string" || !USER.test(v.user))
  )
    throw new Error("Invalid user name");
  if (
    v.port !== undefined &&
    (!Number.isInteger(v.port) ||
      (v.port as number) < 1 ||
      (v.port as number) > 65535)
  )
    throw new Error("Port must be a number from 1 to 65535");
  const helperPath =
    v.helperPath === undefined || v.helperPath === ""
      ? DEFAULT_HELPER_PATH
      : remotePath(v.helperPath, "Helper folder");
  const dataDir =
    v.dataDir === undefined || v.dataDir === ""
      ? undefined
      : remotePath(v.dataDir, "Data folder");
  return {
    alias: v.alias,
    label,
    ...(v.user ? { user: v.user as string } : {}),
    ...(v.port !== undefined ? { port: v.port as number } : {}),
    helperPath,
    ...(dataDir ? { dataDir } : {}),
  };
}
/** Shell-safe word for a validated remote path ("~/" becomes "$HOME"). */
function shellPath(value: string) {
  return value.startsWith("~/") ? `"$HOME"/'${value.slice(2)}'` : `'${value}'`;
}
/** The fixed remote command. Only validated install/data folders appear in it. */
export function remoteCommand(spec: Pick<HostSpec, "helperPath" | "dataDir">) {
  remotePath(spec.helperPath, "Helper folder");
  const helper =
    spec.helperPath === "/"
      ? "'/bin/aw-ssh-helper'"
      : shellPath(spec.helperPath + "/bin/aw-ssh-helper");
  if (spec.dataDir === undefined) return helper;
  remotePath(spec.dataDir, "Data folder");
  return `${helper} --data-dir ${shellPath(spec.dataDir)}`;
}
/** Owner-level options. `-F` comes only from the desktop's own environment (tests). */
function baseOptions(spec: Pick<HostSpec, "user" | "port">) {
  const config = process.env.WORKSPACE_SSH_CONFIG;
  return [
    ...(config ? ["-F", config] : []),
    ...(spec.port !== undefined ? ["-p", String(spec.port)] : []),
    ...(spec.user ? ["-l", spec.user] : []),
  ];
}
export function sshArguments(spec: HostSpec) {
  if (!ALIAS.test(spec.alias)) throw new Error("Invalid host alias");
  if (spec.user !== undefined && !USER.test(spec.user))
    throw new Error("Invalid user name");
  if (
    spec.port !== undefined &&
    (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535)
  )
    throw new Error("Invalid port");
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ForwardX11Trusted=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RequestTTY=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...baseOptions(spec),
    "--",
    spec.alias,
    remoteCommand(spec),
  ];
}
const sshBinary = () => process.env.WORKSPACE_SSH_BIN || "ssh";

function capture(bin: string, args: string[], input?: string, timeout = 8000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = execFile(
        bin,
        args,
        { timeout, encoding: "utf8", maxBuffer: 512 * 1024 },
        (error, stdout, stderr) =>
          resolve({
            code: error ? ((error as any).code ?? 1) : 0,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
          }),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input ?? "");
    },
  );
}
/**
 * Fingerprints the server offers, for the owner to compare out of band. Read
 * with ssh-keyscan against the alias's effective host and port; nothing is
 * written. Hosts reached through a proxy cannot be scanned this way.
 */
export async function hostKeyFingerprints(spec: HostSpec): Promise<string[]> {
  const resolved = await capture("ssh", [
    "-G",
    ...baseOptions(spec),
    "--",
    spec.alias,
  ]);
  if (resolved.code !== 0) return [];
  const value = (key: string) =>
    resolved.stdout
      .split("\n")
      .find((l) => l.startsWith(key + " "))
      ?.slice(key.length + 1)
      .trim();
  if (
    value("proxycommand") ||
    (value("proxyjump") && value("proxyjump") !== "none")
  )
    return [];
  const hostname = value("hostname");
  const port = value("port") || "22";
  if (
    !hostname ||
    !/^[A-Za-z0-9_.:\[\]-]{1,255}$/.test(hostname) ||
    hostname.startsWith("-") ||
    !/^\d{1,5}$/.test(port)
  )
    return [];
  const scanned = await capture(
    "ssh-keyscan",
    ["-T", "6", "-p", port, "--", hostname],
    undefined,
    10000,
  );
  const keys = scanned.stdout
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
  if (!keys) return [];
  const listed = await capture("ssh-keygen", ["-l", "-f", "-"], keys + "\n");
  return listed.stdout
    .split("\n")
    .map((line) =>
      /^(\d+) (SHA256:[A-Za-z0-9+/=]+) .*\(([A-Z0-9-]+)\)\s*$/.exec(
        line.trim(),
      ),
    )
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[2]} (${m[3]})`)
    .slice(0, 8);
}

/** Turns what OpenSSH or the remote shell printed into an owner-facing problem. */
export function classifyFailure(
  spec: HostSpec,
  stderr: string,
  exitCode: number | null,
): HostProblem {
  const where = spec.alias;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)) {
    const fingerprint =
      /key sent by the remote host is\s*\n?\s*(SHA256:[A-Za-z0-9+/=]+)/.exec(
        stderr,
      );
    const type = /The fingerprint for the (\S+) key sent/.exec(stderr);
    return {
      code: "host-key-changed",
      message: `The host key for ${where} has CHANGED since you last connected. This can mean someone is intercepting the connection. The app will not connect. Check the new fingerprint with the host's administrator, then update your known_hosts yourself (for example with ssh-keygen -R) only if it is expected.`,
      ...(fingerprint
        ? { fingerprints: [`${fingerprint[1]} (${type?.[1] || "key"})`] }
        : {}),
    };
  }
  if (/host key is known for|Host key verification failed/.test(stderr))
    return {
      code: "host-key-unknown",
      message: `${where} is not in your known_hosts file, so its identity cannot be verified. Compare the fingerprint below with one obtained out of band (for example from the host's administrator or console), then connect once with "ssh ${where}" in your own terminal and accept it. The app never accepts host keys for you.`,
    };
  if (/Permission denied \(|Too many authentication failures/.test(stderr))
    return {
      code: "auth-failed",
      message: `SSH sign-in to ${where} was refused. Set up key or agent authentication for this alias in your OpenSSH configuration; password and passphrase prompts cannot be answered here.`,
    };
  if (/node-missing/.test(stderr) || exitCode === 69)
    return {
      code: "node-missing",
      message: `Node.js 24 or newer was not found on ${where}. Install it on that host (or set AW_NODE for the helper), then probe again.`,
    };
  if (
    exitCode === 127 ||
    /aw-ssh-helper.*(No such file|not found)|(No such file|not found).*aw-ssh-helper/.test(
      stderr,
    )
  )
    return {
      code: "helper-missing",
      message: `The Agent Workspace helper is not installed at ${spec.helperPath} on ${where}. On that host, extract the agent-workspace-server archive of this version there and run "npm ci" inside it, then probe again. Requirements on the host: Node 24+, tmux and Git.`,
    };
  if (
    /Could not resolve hostname|Connection refused|timed out|No route to host|Network is unreachable|Connection closed by|Connection reset|kex_exchange_identification/.test(
      stderr,
    ) ||
    exitCode === 255
  )
    return {
      code: "unreachable",
      message: `Could not reach ${where}: ${lastLine(stderr) || "the SSH connection failed"}.`,
    };
  return {
    code: "failed",
    message: `The helper on ${where} did not start${lastLine(stderr) ? ": " + lastLine(stderr) : ". Run its bin/aw-ssh-helper --version on that host, check Node 24+ and the matching server installation, then check the host again."}`,
  };
}
const lastLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/[\p{Cc}]/gu, " ").trim())
    .filter(
      (l) =>
        !!l && !/ExperimentalWarning|--trace-warnings|^at |^Node\.js v/.test(l),
    )
    .slice(-1)[0]
    ?.slice(0, 300) || "";

export class HostProblemError extends Error {
  constructor(readonly problem: HostProblem) {
    super(problem.message);
  }
}

function validHello(message: Record<string, any>): HostHello {
  const p = message.protocol;
  if (
    !p ||
    !Number.isSafeInteger(p.min) ||
    !Number.isSafeInteger(p.max) ||
    p.min > p.max ||
    typeof message.helperVersion !== "string" ||
    typeof message.platform !== "string" ||
    !Number.isSafeInteger(message.schema) ||
    !Number.isSafeInteger(message.storeSchema) ||
    typeof message.hostId !== "string" ||
    !/^([0-9a-f]{32})?$/.test(message.hostId) ||
    !Array.isArray(message.tools) ||
    message.tools.length > 8
  )
    throw new ProtocolError("The helper sent an invalid greeting");
  const text = (v: unknown, n: number) =>
    typeof v === "string" ? v.replace(/[\p{Cc}]/gu, " ").slice(0, n) : "";
  return {
    k: "hello",
    protocol: { min: p.min, max: p.max },
    helperVersion: text(message.helperVersion, 40),
    platform: text(message.platform, 20),
    arch: text(message.arch, 20),
    schema: message.schema,
    storeSchema: message.storeSchema,
    hostId: message.hostId,
    tools: message.tools
      .filter(
        (t: any) =>
          t &&
          ["node", "tmux", "git", "claude", "codex"].includes(t.name) &&
          typeof t.available === "boolean",
      )
      .map(
        (t: any) =>
          ({
            name: t.name,
            available: t.available,
            detail: text(t.detail, 160),
          }) as HostTool,
      ),
  };
}
export function negotiate(hello: HostHello) {
  const version = Math.min(hello.protocol.max, PROTOCOL_VERSION);
  if (version < Math.max(hello.protocol.min, PROTOCOL_MIN)) return undefined;
  return version;
}

export interface HostConnection {
  hello: HostHello;
  protocol: number;
  remoteHostId: string;
  request(
    op: HelperOp,
    fields: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  /** Deliberate close: the helper exits, remote tmux sessions keep running. */
  close(): Promise<void>;
  /** Test hook: the ssh client process. */
  readonly child: ChildProcessWithoutNullStreams;
  /** Called after each request frame is written (tests only). */
  onRequestSent?: (op: HelperOp, fields: Record<string, unknown>) => void;
}
export interface ConnectOptions {
  /** Stop after the greeting (read-only probe): no core starts on the host. */
  probeOnly?: boolean;
  approveUpgrade?: boolean;
  /** Pinned helper ID; a different one is refused. */
  expectRemoteHostId?: string;
  onEvent?: (event: Record<string, any>) => void;
  /** Unexpected loss (not after close()). */
  onLost?: (problem: HostProblem) => void;
  timeoutMs?: number;
}
/**
 * Starts `ssh -T alias helper`, reads the greeting and (unless probing)
 * negotiates and starts the remote core. Rejects with HostProblemError.
 */
export function connectHost(spec: HostSpec, options: ConnectOptions = {}) {
  return new Promise<HostConnection>((resolve, reject) => {
    const child = spawn(sshBinary(), sshArguments(spec), {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16384) stderr += chunk.toString("utf8");
    });
    const decoder = new FrameDecoder(HELPER_KINDS, { seekPreamble: true });
    let phase: "hello" | "ready" | "open" | "closed" = "hello";
    let hello: HostHello | undefined;
    let protocol = 0;
    let deliberate = false;
    let nextId = 0;
    const pending = new Map<
      number,
      {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    const timer = setTimeout(
      () =>
        fail({
          code: "unreachable",
          message: `${spec.alias} did not answer in time${lastLine(stderr) ? ": " + lastLine(stderr) : ""}.`,
        }),
      options.timeoutMs ?? 45000,
    );
    const write = (message: { k: string } & Record<string, unknown>) => {
      if (!child.stdin.writable) throw new Error("Connection closed");
      child.stdin.write(encodeFrame(message));
    };
    let problemSent = false;
    function fail(problem: HostProblem) {
      if (phase === "closed") return;
      const wasOpen = phase === "open";
      phase = "closed";
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {}
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(
          new Error(
            `The connection to ${spec.alias} was lost before the host answered; the outcome is unknown. Reconnect and check the session or file before retrying.`,
          ),
        );
      }
      pending.clear();
      if (!wasOpen) reject(new HostProblemError(problem));
      else if (!deliberate && !problemSent) {
        problemSent = true;
        options.onLost?.(problem);
      }
    }
    // ssh can exit while a frame is being written; the close handler then
    // reports the lost connection, so a broken pipe must not crash the core.
    child.stdin.on("error", () => {});
    child.on("error", (error) =>
      fail({
        code: "failed",
        message: `The system ssh client could not be started: ${error.message}. Install OpenSSH.`,
      }),
    );
    child.on("close", (code) => {
      if (phase === "closed") return;
      if (phase === "open")
        fail({
          code: "connection-lost",
          message: `The connection to ${spec.alias} closed${lastLine(stderr) ? ": " + lastLine(stderr) : ""}. Remote sessions keep running on the host.`,
        });
      else fail(classifyFailure(spec, stderr, code));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (phase === "closed") return;
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        fail({
          code: "protocol-error",
          message: `${spec.alias} sent data the app does not accept (${(error as Error).message}). The connection was closed.`,
        });
        return;
      }
      for (const message of messages) {
        if ((phase as string) === "closed") return;
        try {
          handle(message);
        } catch (error) {
          fail({
            code: "protocol-error",
            message: `${spec.alias} broke the helper protocol (${(error as Error).message}). The connection was closed.`,
          });
          return;
        }
      }
    });
    function handle(message: Record<string, any>) {
      if (message.k === "fatal") {
        const text =
          typeof message.error === "string"
            ? message.error.slice(0, 2000)
            : "Helper failed";
        const code = /^upgrade-required: /.test(text)
          ? "upgrade-required"
          : /^data-in-use: /.test(text)
            ? "data-in-use"
            : /Protocol .* is not supported/.test(text)
              ? "protocol-mismatch"
              : "failed";
        fail({ code, message: text.replace(/^[a-z-]+: /, "") });
        return;
      }
      if (phase === "hello") {
        if (message.k !== "hello")
          throw new ProtocolError("Expected a greeting");
        hello = validHello(message);
        const version = negotiate(hello);
        if (version === undefined) {
          fail({
            code: "protocol-mismatch",
            message: `The helper on ${spec.alias} (version ${hello.helperVersion}) speaks protocol ${hello.protocol.min}-${hello.protocol.max}; this app speaks ${PROTOCOL_MIN}-${PROTOCOL_VERSION}. Install the helper from this app version's server archive.`,
          });
          return;
        }
        protocol = version;
        const node = hello.tools.find((t) => t.name === "node");
        if (node && !node.available) {
          fail({
            code: "node-missing",
            message: `${node.detail || "Node.js is too old"} (${spec.alias}). Install Node 24 or newer there, or point AW_NODE at it for the helper.`,
          });
          return;
        }
        if (options.probeOnly) {
          deliberate = true;
          phase = "open";
          clearTimeout(timer);
          try {
            write({ k: "bye" });
            child.stdin.end();
          } catch {}
          resolve(connection());
          return;
        }
        if (
          options.expectRemoteHostId &&
          hello.hostId &&
          hello.hostId !== options.expectRemoteHostId
        ) {
          fail({
            code: "failed",
            message: `The helper data on ${spec.alias} belongs to a different installation than the one this app paired with. Check the host and data folder, or remove and add the host again.`,
          });
          return;
        }
        phase = "ready";
        write({
          k: "start",
          protocol,
          ...(options.approveUpgrade ? { approveUpgrade: true } : {}),
        });
        return;
      }
      if (phase === "ready") {
        if (message.k !== "ready")
          throw new ProtocolError("Expected the helper to start");
        if (
          typeof message.hostId !== "string" ||
          !/^[0-9a-f]{32}$/.test(message.hostId) ||
          message.protocol !== protocol
        )
          throw new ProtocolError("Invalid start answer");
        if (
          options.expectRemoteHostId &&
          message.hostId !== options.expectRemoteHostId
        ) {
          fail({
            code: "failed",
            message: `The helper data on ${spec.alias} belongs to a different installation than the one this app paired with.`,
          });
          return;
        }
        hello!.hostId = message.hostId;
        phase = "open";
        clearTimeout(timer);
        resolve(connection());
        return;
      }
      if (message.k === "res") {
        const entry = pending.get(message.id);
        if (!entry) throw new ProtocolError("Answer to an unknown request");
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (typeof message.error === "string")
          entry.reject(new Error(message.error.slice(0, 2000)));
        else entry.resolve(message.result);
        return;
      }
      if (message.k === "evt") {
        if (!message.event || typeof message.event !== "object")
          throw new ProtocolError("Invalid event");
        options.onEvent?.(message.event);
        return;
      }
      throw new ProtocolError("Unexpected message");
    }
    function connection(): HostConnection {
      const self: HostConnection = {
        hello: hello!,
        protocol,
        remoteHostId: hello!.hostId,
        child,
        request(op, fields, timeoutMs = fields.command === "git.commit" ? 180_000 : 90_000) {
          if (phase !== "open" || deliberate)
            return Promise.reject(new Error(`${spec.alias} is not connected`));
          const id = ++nextId;
          return new Promise((resolveRequest, rejectRequest) => {
            const t = setTimeout(() => {
              pending.delete(id);
              rejectRequest(
                new Error(
                  `${spec.alias} did not answer in time; the outcome is unknown. Check before retrying.`,
                ),
              );
            }, timeoutMs);
            pending.set(id, {
              resolve: resolveRequest,
              reject: rejectRequest,
              timer: t,
            });
            try {
              write({ k: "req", id, op, ...fields });
              self.onRequestSent?.(op, fields);
            } catch (error) {
              clearTimeout(t);
              pending.delete(id);
              rejectRequest(new Error(`${spec.alias} is not connected`));
            }
          });
        },
        close() {
          deliberate = true;
          return new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              fail({ code: "failed", message: "closed" });
              done();
              return;
            }
            child.once("close", () => done());
            try {
              write({ k: "bye" });
              child.stdin.end();
            } catch {}
            const kill = setTimeout(() => {
              try {
                child.kill("SIGTERM");
              } catch {}
            }, 3000);
            kill.unref();
          }).then(() => {
            if ((phase as string) !== "closed")
              fail({ code: "failed", message: "closed" });
          });
        },
      };
      return self;
    }
  });
}
