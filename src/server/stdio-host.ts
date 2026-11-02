import { isDirectEntry } from "../shared/entrypoint.js";
/**
 * SSH helper: a fixed, versioned stdio entrypoint that runs a normal core on
 * this (execution) host and speaks the framed protocol in
 * `src/shared/host-protocol.ts` on stdin/stdout. The desktop starts it with
 * `ssh -T <alias> <install>/bin/aw-ssh-helper [--data-dir DIR]`; folders,
 * prompts and branches only ever travel inside frames.
 *
 * It exposes the ordinary project commands a paired browser may use (the same
 * allowlist and field checks as the gateway), plus folder browsing and folder
 * registration for the desktop owner. Settings, AI suggestions, attachments,
 * agent-control grants and every desktop service are not reachable here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createCore } from "../core/index.js";
import { SCHEMA_VERSION } from "../core/migrations.js";
import { executable, probe } from "../core/process.js";
import { listDirectory, loginShellPath } from "../desktop/folders.js";
import { validateCommand } from "./validation.js";
import {
  encodeFrame,
  FrameDecoder,
  HELPER_OPS,
  LOCAL_KINDS,
  MAX_IN_FLIGHT,
  PREAMBLE,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
  ProtocolError,
  type HostHello,
  type HostTool,
} from "../shared/host-protocol.js";
import type { Core, CoreEvent } from "../shared/contracts.js";

const HELP = `Agent Workspace SSH helper (Node 24+)
Started by the desktop app over \`ssh -T\`; it speaks a framed protocol on stdin/stdout.
--data-dir PATH   Dedicated helper data folder (default ~/.agent-workspace-ssh).
                  Never point it at a standalone server's data folder.
--version         Print the helper and protocol versions.
`;

function helperVersion() {
  for (const candidate of ["../../package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(new URL(candidate, import.meta.url), "utf8"),
      );
      if (typeof pkg.version === "string") return pkg.version as string;
    } catch {}
  }
  return "0.0.0";
}

const printable = (value: string) =>
  value
    .replace(/[\p{Cc}\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .trim()
    .slice(0, 160);

async function tools(): Promise<HostTool[]> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const entries: HostTool[] = [
    {
      name: "node",
      available: nodeMajor >= 24,
      detail:
        nodeMajor >= 24
          ? "Node " + process.versions.node
          : `Node ${process.versions.node} is too old; the helper needs Node 24 or newer on this host`,
    },
  ];
  const checks: [HostTool["name"], string[]][] = [
    ["tmux", ["-V"]],
    ["git", ["--version"]],
    ["claude", ["--version"]],
    ["codex", ["--version"]],
  ];
  const found = await Promise.all(
    checks.map(async ([name, args]) => {
      const bin =
        name === "tmux" ? process.env.WORKSPACE_TMUX || executable(name) : executable(name);
      if (!bin)
        return {
          name,
          available: false,
          detail: `${name} was not found on this host's PATH`,
        };
      const line = printable((await probe(bin, args, 4000)).split("\n")[0] || "");
      return { name, available: true, detail: line || bin };
    }),
  );
  return [...entries, ...found];
}

function storeSchema(dataDir: string) {
  const file = path.join(dataDir, "workspace.sqlite");
  if (!fs.existsSync(file)) return 0;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
    } finally {
      db.close();
    }
  } catch {
    return -1;
  }
}

function existingHostId(dataDir: string) {
  try {
    const value = fs.readFileSync(path.join(dataDir, "helper-host-id"), "utf8").trim();
    return /^[0-9a-f]{32}$/.test(value) ? value : "";
  } catch {
    return "";
  }
}

export async function runStdioHost(
  args = process.argv.slice(2),
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
) {
  let dataDir = path.join(os.homedir(), ".agent-workspace-ssh");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      process.stderr.write(HELP);
      return 0;
    }
    if (arg === "--version") {
      process.stderr.write(
        `agent-workspace-ssh-helper ${helperVersion()} protocol ${PROTOCOL_MIN}-${PROTOCOL_VERSION}\n`,
      );
      return 0;
    }
    if (arg === "--data-dir" && args[i + 1] && path.isAbsolute(args[i + 1]!)) {
      dataDir = path.resolve(args[++i]!);
      continue;
    }
    process.stderr.write("Invalid option; use --help\n");
    return 64;
  }
  // stdout carries only frames.
  for (const method of ["log", "info", "warn", "debug"] as const)
    console[method] = (...values: unknown[]) =>
      process.stderr.write(values.map(String).join(" ") + "\n");
  // tmux needs a UTF-8 locale to pass non-ASCII through.
  if (!process.env.LC_ALL && !process.env.LC_CTYPE && !process.env.LANG)
    process.env.LANG = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  // Provider CLIs are found through this host's own PATH plus its login
  // shell's (nvm, Volta, Bun and profile additions), as on the desktop.
  const login = await loginShellPath();
  if (login)
    process.env.PATH = [
      ...new Set([
        ...(process.env.PATH || "").split(path.delimiter),
        ...login.split(path.delimiter),
      ]),
    ]
      .filter((entry) => entry && path.isAbsolute(entry))
      .join(path.delimiter);

  const output = io.output;
  let broken = false;
  const send = (message: { k: string } & Record<string, unknown>) => {
    if (broken) return;
    let frame: Buffer;
    try {
      frame = encodeFrame(message);
    } catch {
      // An oversized result becomes a bounded error instead of a huge frame.
      if (message.k === "res")
        frame = encodeFrame({
          k: "res",
          id: message.id,
          error: "The result is too large to send over SSH",
        });
      else return;
    }
    output.write(frame);
    // The desktop is not reading: give up rather than buffer without bound.
    if ((output as NodeJS.WriteStream).writableLength > 64 * 1024 * 1024) {
      broken = true;
      void shutdown(3);
    }
  };
  let core: Core | undefined;
  let started = false;
  let stopping: Promise<never> | undefined;
  const shutdown = (code: number): Promise<never> => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await core?.close();
      } catch {}
      await new Promise<void>((resolve) => output.write("", () => resolve()));
      process.exit(code);
    })();
    return stopping;
  };
  const fatal = (message: string, code = 2) => {
    send({ k: "fatal", error: message.slice(0, 2000) });
    return shutdown(code);
  };

  output.write(PREAMBLE);
  const hello: HostHello = {
    k: "hello",
    protocol: { min: PROTOCOL_MIN, max: PROTOCOL_VERSION },
    helperVersion: helperVersion(),
    platform: process.platform,
    arch: process.arch,
    schema: SCHEMA_VERSION,
    storeSchema: storeSchema(dataDir),
    hostId: existingHostId(dataDir),
    tools: await tools(),
  };
  send(hello as unknown as { k: string } & Record<string, unknown>);

  const emit = (event: CoreEvent) => {
    if (!started) return;
    if (event.type === "terminal.data")
      send({
        k: "evt",
        event: {
          type: "terminal.data",
          sessionId: event.sessionId,
          viewerId: event.viewerId,
          sequence: event.sequence,
          b64: Buffer.from(event.data, "utf8").toString("base64"),
        },
      });
    else if (event.type !== "core.status") send({ k: "evt", event });
  };

  async function start(message: Record<string, any>) {
    if (
      !Number.isSafeInteger(message.protocol) ||
      message.protocol < PROTOCOL_MIN ||
      message.protocol > PROTOCOL_VERSION
    )
      return fatal(
        `Protocol ${String(message.protocol).slice(0, 12)} is not supported by this helper (${PROTOCOL_MIN}-${PROTOCOL_VERSION}). Install a matching helper version.`,
      );
    if (message.approveUpgrade !== undefined && typeof message.approveUpgrade !== "boolean")
      return fatal("Invalid start request");
    const existing = storeSchema(dataDir);
    if (existing < 0)
      return fatal("The helper data folder could not be read on this host.");
    if (existing > SCHEMA_VERSION)
      return fatal(
        "upgrade-required: The helper data on this host belongs to a newer version. Install the matching helper version.",
      );
    if (existing > 0 && existing < SCHEMA_VERSION && message.approveUpgrade !== true)
      return fatal(
        `upgrade-required: The helper data on this host uses schema ${existing}; this helper writes ${SCHEMA_VERSION}. Approve the upgrade to continue (a backup is kept on the host).`,
      );
    try {
      core = await createCore({ dataDir, emit });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return fatal(
        /already owned|acquisition is in progress/.test(text)
          ? "data-in-use: Another Agent Workspace core is using this helper data folder on the host."
          : "The helper could not start its core: " + text,
      );
    }
    const idFile = path.join(dataDir, "helper-host-id");
    let hostId = existingHostId(dataDir);
    if (!hostId) {
      hostId = crypto.randomBytes(16).toString("hex");
      fs.writeFileSync(idFile, hostId + "\n", { mode: 0o600 });
    }
    started = true;
    send({
      k: "ready",
      protocol: message.protocol,
      hostId,
      schema: SCHEMA_VERSION,
      helperVersion: hello.helperVersion,
    });
  }

  let inFlight = 0;
  async function request(message: Record<string, any>) {
    const id = message.id;
    if (!Number.isSafeInteger(id) || id < 1)
      throw new ProtocolError("Request ID is invalid");
    if (!started || !core) throw new ProtocolError("Request before start");
    if (!HELPER_OPS.includes(message.op))
      throw new ProtocolError("Unsupported operation");
    if (inFlight >= MAX_IN_FLIGHT) {
      send({ k: "res", id, error: "The host is busy; try again" });
      return;
    }
    inFlight++;
    try {
      let result: unknown;
      if (message.op === "invoke") {
        const { command, payload } = validateCommand(
          message.command,
          message.payload ?? {},
        );
        result = await core.invoke(command, payload);
      } else if (message.op === "browse") {
        if (message.path !== undefined && typeof message.path !== "string")
          throw new Error("Choose a folder from the list");
        result = await listDirectory(message.path);
      } else if (message.op === "hide") {
        if (typeof message.projectId !== "string" || message.projectId.length > 128)
          throw new Error("Invalid folder");
        result = await core.invoke("project.hide", { projectId: message.projectId });
      } else {
        if (
          typeof message.path !== "string" ||
          !path.isAbsolute(message.path) ||
          message.path.length > 4096 ||
          message.path.includes("\0")
        )
          throw new Error("Choose an absolute folder path on the host");
        result = await core.invoke("project.add", { path: message.path });
      }
      send({ k: "res", id, ok: true, result: result ?? null });
    } catch (error) {
      send({
        k: "res",
        id,
        error: (error instanceof Error ? error.message : "Operation failed").slice(0, 2000),
      });
    } finally {
      inFlight--;
    }
  }

  const decoder = new FrameDecoder(LOCAL_KINDS);
  let startTimer: NodeJS.Timeout | undefined = setTimeout(
    () => void fatal("No start request arrived", 4),
    30000,
  );
  io.input.on("data", (chunk: Buffer) => {
    if (stopping) return;
    let messages;
    try {
      messages = decoder.push(Buffer.from(chunk));
    } catch (error) {
      void fatal(error instanceof Error ? error.message : "Protocol error");
      return;
    }
    for (const message of messages) {
      if (message.k === "bye") {
        void shutdown(0);
        return;
      }
      if (message.k === "start") {
        if (startTimer === undefined) {
          void fatal("Duplicate start request");
          return;
        }
        clearTimeout(startTimer);
        startTimer = undefined;
        void start(message);
        continue;
      }
      void request(message).catch((error) =>
        fatal(error instanceof Error ? error.message : "Protocol error"),
      );
    }
  });
  // Disconnecting only stops this helper; tmux sessions keep running.
  io.input.on("end", () => void shutdown(0));
  io.input.on("error", () => void shutdown(0));
  output.on("error", () => {
    broken = true;
    void shutdown(0);
  });
  return new Promise<number>(() => {});
}

if (isDirectEntry(import.meta.url)) {
  void runStdioHost().then(
    (code) => {
      if (typeof code === "number") process.exit(code);
    },
    (error) => {
      process.stderr.write(
        "Agent Workspace SSH helper: " + String(error?.message || error).slice(0, 512) + "\n",
      );
      process.exit(1);
    },
  );
}
