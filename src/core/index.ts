import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { isUtf8 } from "node:buffer";
import { gitStatus, gitDiff, gitIndex, gitPath } from "./git.js";
import {
  claudeActivitySettings,
  initialPrompt,
  launchArguments,
  providerModel,
} from "./providers.js";
import { TerminalStream } from "./stream.js";
import { migrate } from "./migrations.js";
import { createAgentControl, type AgentControl } from "./agent-control.js";
import {
  ATTACHMENT_GRACE_MS,
  removeAttachmentFile,
  writeAttachment,
  type AttachmentRecord,
} from "./attachments.js";
import { run, executable, probe } from "./process.js";
import {
  ASSIST_DIFF_LIMIT,
  ASSIST_PROVIDERS,
  cleanCommitMessage,
  cleanSessionName,
  commitPrompt,
  hashText,
  namePrompt,
  probeAdapter,
  runSuggestion,
  stagedHash,
  stagedSnapshot,
  type AssistProvider,
  type AssistRun,
} from "./assist.js";
import { DICTATION_MODEL_IDS, isDictationModelId } from "../shared/dictation.js";
import { MAX_LANES, laneNameText, laneOf, lanesFor } from "../shared/board.js";
import * as pty from "node-pty";
import type {
  Activity,
  BoardLanes,
  Core,
  CoreOptions,
  Command,
  OwnerSettings,
  Snapshot,
  Session,
  SavedAttachment,
} from "../shared/contracts.js";
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function text(value: unknown, label: string, fallback = "") {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 2 * 1024 * 1024
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
const hash = (s: string | Buffer) =>
  crypto.createHash("sha256").update(s).digest("hex");
/** Plain one-line label: control, zero-width and bidi-override characters removed. */
export function sessionTitleText(value: unknown) {
  if (typeof value !== "string" || value.length > 1024)
    throw new Error("Invalid session title");
  const title = value
    .replace(/[\p{Cc}\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if ([...title].length > 80)
    throw new Error("Session title must be 80 characters or fewer");
  return title;
}
function str(v: unknown, name: string) {
  if (typeof v !== "string" || !v.trim() || v.includes("\0"))
    throw new Error(`Invalid ${name}`);
  return v;
}
export async function createCore({
  dataDir,
  emit,
}: CoreOptions): Promise<Core> {
  const requestedDataDir = path.resolve(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  dataDir = fs.realpathSync(dataDir);
  const lock = path.join(dataDir, "owner.lock");
  const acquisition = path.join(dataDir, "owner.acquire.lock");
  let ownership: DatabaseSync | undefined;
  let ownerAcquired = false;
  let db: DatabaseSync = undefined!;
  try {
    // SQLite's OS lock serializes stale PID-file recovery and releases on a crash.
    // Keep the PID files as well so a running older build still excludes this core.
    ownership = new DatabaseSync(path.join(dataDir, "owner.sqlite"));
    try {
      ownership.exec(
        "PRAGMA busy_timeout=250; CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;",
      );
    } catch (error: any) {
      if (error.errcode === 5 || error.errcode === 6)
        throw new Error("Workspace data is already owned by another core");
      throw error;
    }
    try {
      const previous = JSON.parse(fs.readFileSync(acquisition, "utf8"));
      try {
        process.kill(previous.pid, 0);
        throw new Error("Workspace ownership acquisition is in progress");
      } catch (error: any) {
        if (error.code !== "ESRCH") throw error;
      }
      fs.unlinkSync(acquisition);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.writeFileSync(acquisition, JSON.stringify({ pid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      try {
        const previous = JSON.parse(fs.readFileSync(lock, "utf8"));
        try {
          process.kill(previous.pid, 0);
          throw new Error("Workspace data is already owned by another core");
        } catch (error: any) {
          if (error.code !== "ESRCH") throw error;
        }
        fs.unlinkSync(lock);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
        flag: "wx",
        mode: 0o600,
      });
      ownerAcquired = true;
    } finally {
      fs.unlinkSync(acquisition);
    }
    db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
    await migrate(db, dataDir);
    const tmux = process.env.WORKSPACE_TMUX || executable("tmux");
    const tmuxConfig = path.join(dataDir, "tmux.conf");
    fs.writeFileSync(
      tmuxConfig,
      "set -g status off\nset -g history-limit 5000\nset -g remain-on-exit on\n",
      { mode: 0o600 },
    );
    const activeLaunches = new Set<string>();
    let controller: AgentControl = undefined!;
    let socket = path.join(
      os.tmpdir(),
      `aw-${hash(dataDir).slice(0, 20)}.sock`,
    );
    const tx = async (
      args: string[],
      targetSocket = socket,
      env?: NodeJS.ProcessEnv,
    ) => {
      if (!tmux)
        throw new Error(
          "tmux is unavailable. Install tmux and restart the workspace.",
        );
      return await run(
        tmux,
        ["-f", tmuxConfig, "-S", targetSocket, ...args],
        undefined,
        env,
      );
    };
    const list = (kind: string): any[] =>
      (
        db
          .prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid")
          .all(kind) as any[]
      ).map((r) => JSON.parse(r.value));
    const get = (kind: string, key: unknown): any => {
      const row = db
        .prepare("SELECT value FROM records WHERE kind=? AND id=?")
        .get(kind, str(key, kind + " id")) as any;
      if (!row) throw new Error(`${kind} not found`);
      return JSON.parse(row.value);
    };
    const put = (kind: string, v: any) =>
      db
        .prepare("INSERT OR REPLACE INTO records VALUES (?,?,?)")
        .run(kind, v.id || v.projectId, JSON.stringify(v));
    const attachments = new Map<
      string,
      {
        terminal: pty.IPty;
        stream: TerminalStream;
        viewers: Map<
          string,
          {
            cols: number;
            rows: number;
          }
        >;
      }
    >();
    const exitChecks = new Set<Promise<void>>();
    const sessionSocket = (s: Session | { backendSocket: string }) =>
      (s as Session & { backendSocket?: string }).backendSocket || socket;
    type PaneState = {
      dead: boolean;
      exitCode?: number;
      activity?: Activity;
      /** Epoch ms stamped by the hook that reported `activity`. */
      activityAt?: number;
    };
    /** Every session on a socket with its pane state; undefined when the socket is unreachable. */
    async function socketSessions(
      target: string,
    ): Promise<Map<string, PaneState> | undefined> {
      try {
        const sessions = new Map<string, PaneState>();
        const rows = await tx(
          [
            "list-panes",
            "-a",
            "-F",
            "#{session_name}|#{pane_dead}|#{pane_dead_status}|#{@aw_activity}|#{@aw_activity_at}",
          ],
          target,
        );
        for (const row of rows.split("\n")) {
          if (!row) continue;
          const [name, dead, status, activity, at] = row.split("|");
          const previous = sessions.get(name!);
          const reported = previous?.activity
            ? previous.activityAt
            : /^[0-9]{1,12}$/.test(at || "")
              ? Number(at) * 1000
              : undefined;
          const pane: PaneState = {
            dead: dead === "1" && (previous?.dead ?? true),
            exitCode: previous?.exitCode ?? (status ? Number(status) : undefined),
            activity:
              previous?.activity ??
              (["running", "needs", "done"].includes(activity!)
                ? (activity as Activity)
                : undefined),
            ...(reported !== undefined ? { activityAt: reported } : {}),
          };
          sessions.set(name!, pane);
        }
        return sessions;
      } catch (error: any) {
        return tmux &&
          /no server running|error connecting.*No such file/.test(
            String(error.stderr || error.message),
          )
          ? new Map()
          : undefined;
      }
    }
    const savedBackend = list("backend").find((b) => b.id === "tmux");
    if (savedBackend?.socket) socket = savedBackend.socket;
    const legacyPaths = [
      requestedDataDir,
      dataDir,
      ...(dataDir.startsWith("/private/") ? [dataDir.slice(8)] : []),
    ];
    const candidates = [
      ...new Set([
        socket,
        ...legacyPaths.map((p) =>
          path.join(os.tmpdir(), `aw-${hash(p).slice(0, 20)}.sock`),
        ),
      ]),
    ];
    const oldSessions = list("sessions").filter((s) => !s.backendSocket);
    const catalog = new Map<string, Map<string, PaneState> | undefined>();
    if (oldSessions.length) {
      await Promise.all(
        candidates.map(async (candidate) =>
          catalog.set(candidate, await socketSessions(candidate)),
        ),
      );
      const missing = oldSessions.some(
        (s) =>
          ![...catalog.values()].some((names) => names?.has(s.backendName)),
      );
      if (missing) {
        const others = fs
          .readdirSync(os.tmpdir())
          .filter((n) => /^aw-[a-f0-9]{20}\.sock$/.test(n))
          .map((n) => path.join(os.tmpdir(), n))
          .filter((p) => !catalog.has(p));
        await Promise.all(
          others.map(async (candidate) =>
            catalog.set(candidate, await socketSessions(candidate)),
          ),
        );
      }
      for (const s of oldSessions) {
        const matched = [...catalog].find(([, names]) =>
          names?.has(s.backendName),
        )?.[0];
        s.backendSocket =
          matched ||
          candidates.find(
            (candidate) => catalog.get(candidate) === undefined,
          ) ||
          candidates[0];
        put("sessions", s);
      }
      if (!savedBackend) {
        const matched = oldSessions.find((s) =>
          catalog.get(s.backendSocket)?.has(s.backendName),
        );
        if (matched) socket = matched.backendSocket;
      }
    }
    put("backend", { id: "tmux", socket });
    type Final = { exitCode?: number; transcript: boolean };
    const finalizing = new Map<string, Promise<Final>>();
    /**
     * A dead pane (remain-on-exit) keeps the process's last screen. Save it as
     * the session transcript, then remove the tmux session.
     */
    async function finalize(s: Session, exitCode?: number) {
      let pending = finalizing.get(s.id);
      if (!pending) {
        pending = (async (): Promise<Final> => {
          let saved = false;
          // tmux marks a pane dead when its terminal closes and records the
          // exit status when it reaps the process; on a loaded host that can
          // lag, and occasionally tmux never records it. Wait briefly; the
          // status stays best effort, the saved screen does not.
          for (let retry = 0; exitCode === undefined && retry < 20; retry++) {
            try {
              const status = (
                await tx(
                  [
                    "display-message",
                    "-p",
                    "-t",
                    "=" + s.backendName + ":0.0",
                    "#{pane_dead_status}",
                  ],
                  sessionSocket(s),
                )
              ).trim();
              if (/^[0-9]+$/.test(status)) exitCode = Number(status);
              else await new Promise((resolve) => setTimeout(resolve, 50));
            } catch {
              break;
            }
          }
          try {
            const data = await tx(
              [
                "capture-pane",
                "-e",
                "-p",
                "-t",
                "=" + s.backendName + ":0.0",
                "-S",
                "-2000",
              ],
              sessionSocket(s),
            );
            // Unused pane rows sit between the last output and tmux's
            // "Pane is dead" footer; drop them so the output stays in view.
            const plain = (line: string) =>
              line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
            const lines = data.split("\n");
            const dropBlank = () => {
              while (lines.length && !plain(lines[lines.length - 1]!))
                lines.pop();
            };
            dropBlank();
            const footer =
              lines.length && /^Pane is dead/.test(plain(lines[lines.length - 1]!))
                ? lines.pop()
                : undefined;
            dropBlank();
            if (footer) lines.push("", footer);
            put("transcripts", {
              id: s.id,
              data: (lines.join("\n") + "\n").slice(-256 * 1024),
              exitCode,
              savedAt: now(),
            });
            db.exec(
              "DELETE FROM records WHERE kind='transcripts' AND rowid NOT IN (SELECT rowid FROM records WHERE kind='transcripts' ORDER BY rowid DESC LIMIT 100)",
            );
            saved = true;
          } catch {}
          try {
            await tx(["kill-session", "-t", "=" + s.backendName], sessionSocket(s));
          } catch {}
          return {
            ...(Number.isInteger(exitCode) ? { exitCode } : {}),
            transcript: saved,
          };
        })().finally(() => finalizing.delete(s.id));
        finalizing.set(s.id, pending);
      }
      // Concurrent observers share one capture; each applies it to its own record.
      const result = await pending;
      if (result.exitCode !== undefined) s.exitCode = result.exitCode;
      if (result.transcript) s.transcript = true;
      return result;
    }
    const transcript = (sid: string) => {
      const row = db
        .prepare("SELECT value FROM records WHERE kind='transcripts' AND id=?")
        .get(sid) as { value: string } | undefined;
      return row
        ? (JSON.parse(row.value) as { data: string; exitCode?: number })
        : undefined;
    };
    const live = async (s: Session) => {
      let panes: string;
      try {
        panes = await tx(
          [
            "list-panes",
            "-s",
            "-t",
            "=" + s.backendName,
            "-F",
            "#{pane_dead}|#{pane_dead_status}",
          ],
          sessionSocket(s),
        );
      } catch (error: any) {
        const detail = String(error.stderr || error.message);
        return tmux &&
          /no server running|no such session|can't find session|can't find window|error connecting.*No such file/.test(
            detail,
          )
          ? "exited"
          : "unknown";
      }
      const rows = panes
        .split("\n")
        .filter(Boolean)
        .map((row) => row.split("|"));
      if (rows.length && rows.every(([dead]) => dead === "1")) {
        await finalize(s, rows[0]![1] ? Number(rows[0]![1]) : undefined);
        return "exited";
      }
      return "running";
    };
    for (const s of list("sessions")) {
      s.status = await live(s);
      if (s.status === "exited") {
        s.activity = undefined;
        delete s.activityAt;
      }
      if (s.status === "running")
        try {
          await tx(
            ["set-option", "-t", s.backendName, "status", "off"],
            sessionSocket(s),
          );
        } catch {}
      put("sessions", s);
      if (s.attemptId) {
        const a = get("attempts", s.attemptId);
        a.status = s.status;
        put("attempts", a);
      }
    }
    // Installs can change while the app runs; re-resolve PATH at most every few seconds.
    let capabilityCache: { at: number; value: Snapshot["capabilities"] } = {
      at: 0,
      value: [],
    };
    const capabilities = () => {
      if (Date.now() - capabilityCache.at < 4000) return capabilityCache.value;
      const value = ["tmux", "git", "claude", "codex"].map((name) => {
        const found = name === "tmux" ? tmux : executable(name);
        return {
          name,
          available: !!found,
          detail: !found
            ? name === "tmux"
              ? "tmux was not found. Install tmux and restart the workspace."
              : name === "git"
                ? "Git was not found. Folders still open; change review is unavailable."
                : `The ${name} command was not found on this host's PATH. Install and sign in to it, then check again.`
            : name === "tmux"
              ? "Private persistent tmux sessions"
              : name === "git"
                ? "Local Git operations"
                : found,
        };
      });
      capabilityCache = { at: Date.now(), value };
      return value;
    };
    const snapshot = (): Snapshot => ({
      projects: list("projects"),
      tasks: list("tasks"),
      attempts: list("attempts"),
      sessions: list("sessions"),
      notes: list("notes").map((n) => ({ ...n, revision: n.revision ?? 1 })),
      layouts: list("layouts").map((l) => ({
        ...l,
        revision: l.revision ?? 1,
      })),
      boardLanes: list("boardLanes"),
      capabilities: capabilities(),
    });
    // Optional Claude flags are used only when this installed version lists them.
    const claudeSupport = new Map<
      string,
      Promise<{ sessionId: boolean; settings: boolean }>
    >();
    function claudeFeatures(bin: string) {
      let key = bin;
      try {
        key += ":" + fs.statSync(bin).mtimeMs;
      } catch {}
      let features = claudeSupport.get(key);
      if (!features) {
        features = probe(bin, ["--help"]).then((help) => ({
          sessionId: /--session-id\b/.test(help),
          settings: /--settings\b/.test(help),
        }));
        claudeSupport.set(key, features);
      }
      return features;
    }
    const changed = () => {
      db.prepare("INSERT INTO events(type,time,payload) VALUES (?,?,?)").run(
        "workspace.changed",
        now(),
        "{}",
      );
      db.exec(
        "DELETE FROM events WHERE seq < (SELECT COALESCE(MAX(seq),0)-10000 FROM events)",
      );
      const s = snapshot();
      emit({ type: "snapshot", snapshot: s });
      return s;
    };
    function session(p: any) {
      const s = get("sessions", p.sessionId);
      if (p.generation !== undefined && p.generation !== s.generation)
        throw new Error("Stale session generation");
      return s as Session;
    }
    function ownedSession(p: any) {
      const s = session(p);
      if (p.generation !== s.generation)
        throw new Error("Session generation required");
      if (!attachments.get(s.id)?.viewers.has(str(p.viewerId, "viewerId")))
        throw new Error("Viewer is not attached");
      return s;
    }
    async function root(p: any) {
      const project = get("projects", p.projectId);
      const canonical = fs.realpathSync(project.path);
      if (canonical !== project.path)
        throw new Error("Project path changed; register its current location");
      if (!p.worktreePath) return canonical;
      const w = str(p.worktreePath, "worktreePath");
      const trees = await worktrees(project.path);
      if (!trees.some((t) => t.path === fs.realpathSync(w)))
        throw new Error("Worktree does not belong to project");
      return fs.realpathSync(w);
    }
    async function repository(p: any) {
      const r = await root(p);
      const top = fs.realpathSync(
        (await run("git", ["rev-parse", "--show-toplevel"], r)).trim(),
      );
      if (top !== r)
        throw new Error("Choose the repository root for Git operations");
      return r;
    }
    async function scoped(p: any, missing = false) {
      const r = await root(p);
      const target = path.resolve(r, typeof p.path === "string" ? p.path : ".");
      const real =
        missing && !fs.existsSync(target)
          ? path.join(
              fs.realpathSync(path.dirname(target)),
              path.basename(target),
            )
          : fs.realpathSync(target);
      if (real !== r && !real.startsWith(r + path.sep))
        throw new Error("Path escapes project root");
      return real;
    }
    async function worktrees(r: string) {
      return (await run("git", ["worktree", "list", "--porcelain", "-z"], r))
        .trim()
        .split("\0\0")
        .filter(Boolean)
        .map((block) => {
          const lines = block.split("\0");
          return {
            path: lines[0]!.slice(9),
            head: lines.find((l) => l.startsWith("HEAD "))?.slice(5) || "",
            branch:
              lines
                .find((l) => l.startsWith("branch "))
                ?.slice(7)
                .replace("refs/heads/", "") || "(detached)",
          };
        });
    }
    async function attach(s: Session, viewer: string, cols = 100, rows = 30) {
      const observed = await live(s);
      if (observed !== s.status) {
        if (observed === "exited") s.activity = undefined;
        recordStatus(s, observed);
        changed();
      }
      if (observed !== "running")
        throw new Error(
          observed === "unknown"
            ? "Session backend is unreachable; execution state is unknown"
            : "Session has exited",
        );
      let a = attachments.get(s.id);
      if (!a) {
        const terminal = pty.spawn(
          tmux,
          [
            "-f",
            tmuxConfig,
            "-S",
            sessionSocket(s),
            "attach-session",
            "-t",
            "=" + s.backendName,
          ],
          {
            name: "xterm-256color",
            cols,
            rows,
            env: { ...process.env, TERM: "xterm-256color" },
            cwd: s.cwd,
          },
        );
        a = {
          terminal,
          viewers: new Map(),
          stream: new TerminalStream(s.id, emit),
        };
        attachments.set(s.id, a);
        const stream = a.stream;
        terminal.onData((data) => {
          if (!closed) stream.write(data);
        });
        terminal.onExit(({ exitCode }) => {
          if (closed) return;
          const check = (async () => {
            if (attachments.get(s.id)?.terminal === terminal)
              attachments.delete(s.id);
            const current = get("sessions", s.id) as Session;
            if ((await live(current)) === "exited" && !closed) {
              current.activity = undefined;
              recordStatus(current, "exited");
              emit({ type: "session.exit", sessionId: s.id, exitCode });
              changed();
            }
          })();
          exitChecks.add(check);
          void check.catch(() => {}).finally(() => exitChecks.delete(check));
        });
      }
      if (!a.viewers.has(viewer) && a.viewers.size >= 32)
        throw new Error("Viewer limit reached");
      a.viewers.set(viewer, { cols, rows });
      a.stream.add(viewer);
      resize(s.id);
      for (let retry = 0; ; retry++) {
        try {
          await tx(
            [
              "refresh-client",
              "-t",
              (a.terminal as pty.IPty & { ptsName: string }).ptsName,
              "-R",
            ],
            sessionSocket(s),
          );
          break;
        } catch (error) {
          if (retry >= 20) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
    function resize(sid: string) {
      const a = attachments.get(sid);
      if (a?.viewers.size) {
        a.terminal.resize(
          Math.min(...[...a.viewers.values()].map((v) => v.cols)),
          Math.min(...[...a.viewers.values()].map((v) => v.rows)),
        );
      }
    }
    const queues = new Map<string, Promise<unknown>>();
    async function execute(command: Command, p: any): Promise<unknown> {
      switch (command) {
        case "snapshot":
          return snapshot();
        case "project.add": {
          const r = fs.realpathSync(str(p.path, "path"));
          if (!fs.statSync(r).isDirectory())
            throw new Error("Project must be a directory");
          let project = list("projects").find((v) => v.path === r);
          if (project?.hidden) {
            delete project.hidden;
            put("projects", project);
          }
          if (!project) {
            project = {
              id: id(),
              name: path.basename(r),
              path: r,
              createdAt: now(),
            };
            put("projects", project);
          }
          changed();
          return project;
        }
        case "project.hide": {
          const project = get("projects", p.projectId);
          if (
            list("sessions").some(
              (s) => s.projectId === project.id && s.status !== "exited",
            )
          )
            throw new Error(
              "End this folder's running sessions before removing it from the list",
            );
          project.hidden = true;
          put("projects", project);
          changed();
          return project;
        }
        case "task.create": {
          get("projects", p.projectId);
          const t = {
            id: id(),
            projectId: p.projectId,
            title: str(p.title, "title"),
            description: text(p.description, "description"),
            status: "backlog",
            revision: 1,
            createdAt: now(),
            updatedAt: now(),
          };
          put("tasks", t);
          changed();
          return t;
        }
        case "task.update": {
          const t = get("tasks", p.taskId);
          if (p.revision !== t.revision) throw new Error("Stale task revision");
          if (
            p.status !== undefined &&
            !["backlog", "ready", "in_progress", "review", "done"].includes(
              p.status,
            )
          )
            throw new Error("Invalid task status");
          for (const k of ["title", "description", "status"])
            if (p[k] !== undefined)
              t[k] =
                k === "title"
                  ? str(p[k], k)
                  : k === "description"
                    ? text(p[k], k)
                    : p[k];
          t.revision++;
          t.updatedAt = now();
          put("tasks", t);
          changed();
          return t;
        }
        case "attempt.start":
        case "terminal.open": {
          const key = str(p.idempotencyKey, "idempotencyKey");
          // attempt.start keeps its original digest so existing receipts still match.
          const digest = hash(
            (command === "terminal.open" ? command : "") + JSON.stringify(p),
          );
          const receipt = db
            .prepare("SELECT * FROM receipts WHERE key=?")
            .get(key) as any;
          if (receipt) {
            if (receipt.digest !== digest)
              throw new Error("Idempotency key reused with different request");
            if (!receipt.result) {
              const intent = db
                .prepare("SELECT * FROM launch_intents WHERE key=?")
                .get(key) as any;
              if (intent) {
                const session = get("sessions", intent.sessionId);
                if ((await live(session)) === "running") {
                  const attempt = intent.attemptId
                    ? get("attempts", intent.attemptId)
                    : undefined;
                  session.status = "running";
                  if (attempt) attempt.status = "running";
                  const result = { ...(attempt ? { attempt } : {}), session };
                  db.exec("BEGIN IMMEDIATE");
                  try {
                    put("sessions", session);
                    if (attempt) put("attempts", attempt);
                    db.prepare("UPDATE receipts SET result=? WHERE key=?").run(
                      JSON.stringify(result),
                      key,
                    );
                    db.exec("COMMIT");
                  } catch (e) {
                    db.exec("ROLLBACK");
                    throw e;
                  }
                  changed();
                  return result;
                }
              }
              throw new Error(
                "Launch outcome unknown; reconcile existing session before retrying",
              );
            }
            const result = JSON.parse(receipt.result);
            return {
              ...(result.attempt
                ? { attempt: get("attempts", result.attempt.id) }
                : {}),
              session: get("sessions", result.session.id),
            };
          }
          const task =
            command === "attempt.start" ? get("tasks", p.taskId) : undefined;
          const projectId: string = task
            ? task.projectId
            : get("projects", p.projectId).id;
          const provider = p.provider || "shell";
          if (!["shell", "claude", "codex"].includes(provider))
            throw new Error("Unsupported provider");
          const name =
            provider === "claude"
              ? "Claude"
              : provider === "codex"
                ? "Codex"
                : "Shell";
          let previous: Session | undefined;
          if (p.resumeSessionId !== undefined) {
            if (command !== "terminal.open")
              throw new Error("Resume is only available for folder sessions");
            previous = get("sessions", p.resumeSessionId) as Session;
            if (
              previous.projectId !== projectId ||
              previous.provider !== provider
            )
              throw new Error("That session does not belong to this folder");
            if (provider === "shell")
              throw new Error("A shell cannot be resumed; open a new shell");
            if (provider === "claude" && !previous.conversationId)
              throw new Error(
                "This Claude session has no saved conversation to resume",
              );
            if ((await live(previous)) !== "exited")
              throw new Error(
                "This session is still open. Switch to its terminal instead.",
              );
          }
          const bin =
            provider === "shell"
              ? process.env.SHELL ||
                (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
              : executable(provider);
          if (!bin)
            throw new Error(
              `${name} is not installed on this host. Install the ${provider} command-line tool and sign in to it, then try again.`,
            );
          if (!tmux)
            throw new Error("tmux is unavailable. Install tmux and restart.");
          const base = await root({
            projectId,
            worktreePath: p.worktreePath,
          });
          const cwd = previous
            ? previous.cwd
            : typeof p.path === "string" && p.path && p.path !== "."
              ? await scoped({
                  projectId,
                  worktreePath: p.worktreePath,
                  path: p.path,
                }).catch((error) => {
                  if (error?.code === "ENOENT")
                    throw new Error(
                      "That folder no longer exists. Choose another folder.",
                    );
                  throw error;
                })
              : base;
          let folder: fs.Stats;
          try {
            folder = fs.statSync(cwd);
          } catch {
            throw new Error(
              "That folder no longer exists. Choose another folder.",
            );
          }
          if (!folder.isDirectory())
            throw new Error("Choose a folder, not a file, to open a terminal.");
          try {
            fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
          } catch {
            throw new Error("You don't have permission to open this folder.");
          }
          const selectedModel = providerModel(provider, p.model);
          const prompt =
            task && p.prompt === undefined
              ? [task.title, task.description].filter(Boolean).join("\n\n")
              : p.prompt;
          const submitted = !!initialPrompt(prompt);
          const features =
            provider === "claude"
              ? await claudeFeatures(bin)
              : { sessionId: false, settings: false };
          const conversationId =
            provider === "claude"
              ? previous?.conversationId ||
                (features.sessionId ? id() : undefined)
              : undefined;
          const providerArgs = launchArguments(provider, {
            prompt,
            model: p.model,
            conversation: conversationId
              ? { id: conversationId, resume: !!previous }
              : undefined,
            resumePicker: provider === "codex" && !!previous,
            settings:
              provider === "claude" && features.settings
                ? claudeActivitySettings(tmux)
                : undefined,
          });
          const aid = task ? id() : "",
            sid = id();
          const s: Session & { backendSocket: string } = {
            id: sid,
            attemptId: task ? aid : null,
            projectId,
            provider,
            cwd,
            backendName: "aw-" + sid,
            backendSocket: socket,
            generation: 1,
            status: "unknown",
            createdAt: now(),
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(conversationId ? { conversationId } : {}),
            ...(provider === "claude" && features.settings
              ? {
                  activityTracking: true,
                  ...(submitted
                    ? {
                        activity: "running" as const,
                        activityAt: Math.floor(Date.now() / 1000) * 1000,
                      }
                    : {}),
                }
              : {}),
            ...(previous ? { resumedFrom: previous.id } : {}),
          };
          const a = task
            ? {
                id: aid,
                taskId: task.id,
                projectId,
                provider,
                sessionId: sid,
                worktreePath: cwd,
                ...(selectedModel ? { model: selectedModel } : {}),
                status: "unknown",
                createdAt: now(),
              }
            : undefined;
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare("INSERT INTO receipts VALUES (?,?,NULL)").run(
              key,
              digest,
            );
            put("sessions", s);
            if (a) put("attempts", a);
            db.prepare("INSERT INTO launch_intents VALUES (?,?,?)").run(
              key,
              sid,
              aid,
            );
            db.prepare("INSERT INTO launch_requests VALUES (?,?)").run(
              key,
              JSON.stringify({
                ...(task ? { taskId: task.id } : { projectId }),
                provider,
                cwd,
                executable: bin,
                arguments: providerArgs,
                ...(Object.keys(controller.launchEnvironment(sid)).length
                  ? { control: true }
                  : {}),
              }),
            );
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
          activeLaunches.add(sid);
          // Per-session environment only (never tmux's global one): where this
          // session's agent-control grant file would be, and the awctl
          // launcher. tmux gives a new session the PATH of the client that
          // creates it (`-e PATH=` is ignored), so PATH goes to that client.
          const { PATH: controlPath, ...controlVars } =
            controller.launchEnvironment(sid);
          const controlEnv = Object.entries(controlVars).flatMap(([k, v]) => [
            "-e",
            `${k}=${v}`,
          ]);
          try {
            // A server started by an older build lacks remain-on-exit from the
            // config file; without it a fast-exiting CLI loses its error output.
            await tx(["set-option", "-g", "remain-on-exit", "on"]).catch(
              () => {},
            );
            await tx(
              [
              "new-session",
              "-d",
              "-s",
              s.backendName,
              "-c",
              cwd,
              "-x",
              "100",
              "-y",
              "30",
                ...controlEnv,
                bin,
                ...providerArgs,
              ],
              socket,
              controlPath ? { ...process.env, PATH: controlPath } : undefined,
            );
            await tx([
              "set-option",
              "-t",
              s.backendName,
              "history-limit",
              "5000",
            ]);
            await tx(
              ["set-option", "-t", s.backendName, "status", "off"],
              sessionSocket(s),
            );
            if (s.activity)
              await tx([
                "set-option",
                "-p",
                "-t",
                "=" + s.backendName + ":",
                "@aw_activity",
                s.activity,
                ";",
                "set-option",
                "-p",
                "-t",
                "=" + s.backendName + ":",
                "@aw_activity_at",
                String(Math.floor((s.activityAt ?? Date.now()) / 1000)),
              ]).catch(() => {});
            // A CLI that fails at startup ends here with its output saved.
            const observed = await live(s);
            db.exec("BEGIN IMMEDIATE");
            s.status = observed === "exited" ? "exited" : "running";
            if (s.status === "exited") {
              s.activity = undefined;
              delete s.activityAt;
            }
            if (a) a.status = s.status;
            put("sessions", s);
            if (a) put("attempts", a);
            const result = { ...(a ? { attempt: a } : {}), session: s };
            db.prepare("UPDATE receipts SET result=? WHERE key=?").run(
              JSON.stringify(result),
              key,
            );
            db.exec("COMMIT");
            changed();
            return result;
          } catch (e) {
            changed();
            throw e;
          } finally {
            activeLaunches.delete(sid);
          }
        }
        case "session.attach": {
          const s = session(p);
          await attach(
            s,
            str(p.viewerId || "main", "viewerId"),
            size(p.cols, 100),
            size(p.rows, 30),
          );
          return {
            data: "",
            restoration: "tmux-redraw",
            generation: s.generation,
          };
        }
        case "session.capture": {
          const s = session(p);
          try {
            return {
              data: await tx(
                [
                  "capture-pane",
                  "-e",
                  "-p",
                  "-t",
                  "=" + s.backendName + ":0.0",
                  "-S",
                  "-2000",
                ],
                sessionSocket(s),
              ),
            };
          } catch (error) {
            // An ended process may have left its final screen behind.
            const saved = transcript(s.id);
            if (!saved) throw error;
            return { data: saved.data, exitCode: saved.exitCode, saved: true };
          }
        }
        case "session.detach": {
          const s = session(p),
            a = attachments.get(s.id);
          a?.viewers.delete(p.viewerId || "main");
          a?.stream.remove(p.viewerId || "main");
          if (a && !a.viewers.size) {
            attachments.delete(s.id);
            a.terminal.kill();
          } else resize(s.id);
          return { ok: true };
        }
        case "session.resize": {
          const s = session(p),
            a = attachments.get(s.id);
          if (!a?.viewers.has(p.viewerId || "main"))
            throw new Error("Viewer is not attached");
          a.viewers.set(p.viewerId || "main", {
            cols: size(p.cols, 100),
            rows: size(p.rows, 30),
          });
          resize(s.id);
          return { ok: true };
        }
        case "session.ack": {
          const s = session(p);
          const a = attachments.get(s.id);
          if (!a) throw new Error("Session not attached");
          a.stream.ack(str(p.viewerId, "viewerId"), p.sequence);
          return { ok: true };
        }
        case "session.rename": {
          const s = session(p);
          if (p.generation !== s.generation)
            throw new Error("Session generation required");
          if (p.titleRevision !== (s.titleRevision ?? 0))
            throw new Error("Stale session title");
          const title = sessionTitleText(p.title);
          if (title) s.title = title;
          else delete s.title;
          s.titleRevision = (s.titleRevision ?? 0) + 1;
          put("sessions", s);
          changed();
          return s;
        }
        case "session.place": {
          // Metadata only: the process, its viewers and its input are untouched.
          const s = session(p);
          if (p.generation !== s.generation)
            throw new Error("Session generation required");
          if (p.placementRevision !== (s.placementRevision ?? 0))
            throw new Error("Stale session placement");
          const board = lanesFor(list("boardLanes"), s.projectId);
          if (typeof p.lane !== "string" || !board.lanes.some((l) => l.id === p.lane))
            throw new Error("Unknown lane");
          let order: number;
          if (p.order === undefined) {
            const placed = (list("sessions") as Session[])
              .filter(
                (o) =>
                  o.id !== s.id &&
                  o.projectId === s.projectId &&
                  o.lane === p.lane &&
                  typeof o.laneOrder === "number",
              )
              .map((o) => o.laneOrder!);
            order = placed.length ? Math.max(...placed) + 1 : 1;
          } else if (
            typeof p.order !== "number" ||
            !Number.isFinite(p.order) ||
            Math.abs(p.order) > 1e12
          )
            throw new Error("Invalid lane order");
          else order = p.order;
          s.lane = p.lane;
          s.laneOrder = order;
          s.placementRevision = (s.placementRevision ?? 0) + 1;
          put("sessions", s);
          changed();
          return s;
        }
        case "session.input": {
          const s = ownedSession(p);
          if (typeof p.data !== "string" || p.data.length > 65536)
            throw new Error("Invalid terminal input");
          const a = attachments.get(s.id);
          if (!a) throw new Error("Attach terminal before sending input");
          a.terminal.write(p.data);
          return { ok: true };
        }
        case "session.terminate": {
          const s = ownedSession(p);
          await tx(
            ["kill-session", "-t", "=" + s.backendName],
            sessionSocket(s),
          );
          s.activity = undefined;
          recordStatus(s, "exited");
          changed();
          return { ok: true };
        }
        case "files.list":
          return fs
            .readdirSync(await scoped(p), { withFileTypes: true })
            .filter((e) => e.name !== ".git")
            .slice(0, 2000)
            .map((e) => ({
              name: e.name,
              path: path.join(
                typeof p.path === "string" ? p.path : ".",
                e.name,
              ),
              type: e.isDirectory() ? "directory" : "file",
            }));
        case "files.read": {
          const f = await scoped(p);
          if (!fs.statSync(f).isFile())
            throw new Error("Only regular files can be edited");
          if (fs.statSync(f).size > 2 * 1024 * 1024)
            throw new Error("File exceeds editor limit");
          const bytes = fs.readFileSync(f);
          if (bytes.includes(0) || !isUtf8(bytes))
            throw new Error("Binary or non-UTF-8 file cannot be edited");
          return {
            path: p.path,
            content: bytes.toString("utf8"),
            hash: hash(bytes),
          };
        }
        case "files.write": {
          const f = await scoped(p, true);
          if (
            typeof p.content !== "string" ||
            p.content.includes("\0") ||
            Buffer.byteLength(p.content) > 2 * 1024 * 1024
          )
            throw new Error("Invalid file content");
          const exists = fs.existsSync(f);
          if (exists && !fs.statSync(f).isFile())
            throw new Error("Only regular files can be edited");
          if (
            (exists ? hash(fs.readFileSync(f)) : null) !==
            p.expectedHash
          )
            throw new Error(
              "File conflict: file changed on disk. Reload before saving.",
            );
          const temp = f + ".aw-" + id();
          try {
            fs.writeFileSync(temp, p.content, {
              flag: "wx",
              mode: exists ? fs.statSync(f).mode : 0o600,
            });
            fs.renameSync(temp, f);
          } finally {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
          }
          return { path: p.path, content: p.content, hash: hash(p.content) };
        }
        case "git.status":
          return gitStatus(await repository(p));
        case "git.diff":
          return gitDiff(await repository(p), p.path, p.staged);
        case "git.stage":
          return gitIndex(await repository(p), p.paths, true);
        case "git.unstage":
          return gitIndex(await repository(p), p.paths, false);
        case "git.commit":
          return {
            output: await run(
              "git",
              ["commit", "-m", str(p.message, "message")],
              await repository(p),
            ),
            hash: (
              await run("git", ["rev-parse", "HEAD"], await repository(p))
            ).trim(),
          };
        case "worktree.list":
          return await worktrees(await repository(p));
        case "worktree.create": {
          const r = await repository(p);
          const branch = str(p.branch, "branch");
          await run("git", ["check-ref-format", "--branch", branch], r);
          const target = p.path
            ? path.resolve(str(p.path, "path"))
            : path.join(dataDir, "worktrees", id());
          fs.mkdirSync(path.dirname(target), { recursive: true });
          await run("git", ["worktree", "add", "-b", branch, "--", target], r);
          return (await worktrees(r)).find(
            (w) => w.path === fs.realpathSync(target),
          );
        }
        case "layout.save": {
          get("projects", p.projectId);
          if (
            !p.positions ||
            typeof p.positions !== "object" ||
            Array.isArray(p.positions) ||
            Object.keys(p.positions).length > 10000
          )
            throw new Error("Invalid layout");
          for (const v of Object.values(p.positions) as any[])
            if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y))
              throw new Error("Invalid position");
          // Revisions let agent control refuse to move nodes over an owner's
          // newer layout; the owner's own saves stay last-writer-wins.
          const current = list("layouts").find(
            (l) => l.projectId === p.projectId,
          );
          const revision = current ? (current.revision ?? 1) : 0;
          if (p.revision !== undefined && p.revision !== revision)
            throw new Error("Stale layout revision");
          put("layouts", {
            projectId: p.projectId,
            positions: p.positions,
            revision: revision + 1,
          });
          return changed();
        }
        case "lane.rename":
        case "lane.add":
        case "lane.remove": {
          const project = get("projects", p.projectId);
          const board = lanesFor(list("boardLanes"), project.id);
          if (p.revision !== board.revision) throw new Error("Stale board lanes");
          const lanes = board.lanes.map((l) => ({ ...l }));
          if (command === "lane.add") {
            if (lanes.length >= MAX_LANES)
              throw new Error(`A board has at most ${MAX_LANES} lanes`);
            lanes.push({ id: "lane-" + id().slice(0, 8), name: laneNameText(p.name) });
          } else {
            const index = lanes.findIndex((l) => l.id === p.laneId);
            if (index < 0) throw new Error("Unknown lane");
            if (command === "lane.rename") lanes[index]!.name = laneNameText(p.name);
            else {
              if (lanes.length <= 1) throw new Error("A board needs at least one lane");
              const occupied = (list("sessions") as Session[]).some(
                (s) =>
                  s.projectId === project.id && laneOf(s, board.lanes) === p.laneId,
              );
              if (occupied)
                throw new Error("Move this lane's cards to another lane before removing it");
              lanes.splice(index, 1);
            }
          }
          const next: BoardLanes = {
            projectId: project.id,
            lanes,
            revision: board.revision + 1,
          };
          put("boardLanes", next);
          changed();
          return next;
        }
        case "settings.read": {
          if (Object.keys(p).some((k) => k !== "key"))
            throw new Error("Unexpected settings field");
          const key = settingKey(p.key);
          const row = db
            .prepare("SELECT value FROM records WHERE kind='ownerSettings' AND id=?")
            .get(key) as { value: string } | undefined;
          return {
            key,
            value: row ? JSON.parse(row.value).value : ownerDefaults[key],
          };
        }
        case "settings.write": {
          const key = settingKey(p.key);
          if (Object.keys(p).some((k) => k !== "key" && k !== "value"))
            throw new Error("Unexpected settings field");
          if (typeof p.value !== typeof ownerDefaults[key])
            throw new Error("Invalid setting value");
          if (key === "dictationModel" && !isDictationModelId(p.value))
            throw new Error("Unknown dictation model");
          if (
            key === "assistProvider" &&
            !["", ...ASSIST_PROVIDERS].includes(p.value)
          )
            throw new Error("Unknown AI suggestions provider");
          if (key === "assistModel" && p.value !== "")
            providerModel("claude", p.value);
          put("ownerSettings", { id: key, value: p.value, updatedAt: now() });
          return { key, value: p.value };
        }
        case "note.create": {
          get("projects", p.projectId);
          const n = {
            id: id(),
            projectId: p.projectId,
            title: str(p.title, "title"),
            body: text(p.body, "body"),
            revision: 1,
            createdAt: now(),
            updatedAt: now(),
          };
          put("notes", n);
          changed();
          return n;
        }
        case "note.update": {
          const n = get("notes", p.noteId);
          if (p.revision !== undefined && p.revision !== (n.revision ?? 1))
            throw new Error("Stale note revision");
          if (p.title !== undefined) n.title = str(p.title, "title");
          if (p.body !== undefined) n.body = text(p.body, "body");
          n.revision = (n.revision ?? 1) + 1;
          n.updatedAt = now();
          put("notes", n);
          changed();
          return n;
        }
        case "assist.status":
          assistFields(p, []);
          return assistStatus();
        case "assist.preview":
        case "assist.suggest":
          return assist(command, p);
        case "assist.cancel":
          assistFields(p, []);
          assistRun?.cancel("Cancelled. Nothing was changed.");
          return { ok: true };
        default:
          throw new Error("Unsupported command");
      }
    }
    // Owner preferences: an allowlist of keys, each with a typed default.
    const ownerDefaults: OwnerSettings = {
      keepAwake: false,
      dictationModel: DICTATION_MODEL_IDS[0],
      assistProvider: "",
      assistModel: "",
    };
    function ownerSetting<K extends keyof OwnerSettings>(key: K): OwnerSettings[K] {
      const row = db
        .prepare("SELECT value FROM records WHERE kind='ownerSettings' AND id=?")
        .get(key) as { value: string } | undefined;
      return row ? JSON.parse(row.value).value : ownerDefaults[key];
    }
    // AI suggestions: owner-only, never automatic, one provider request per click.
    let assistRun: AssistRun | undefined;
    let assistBusy = false;
    function assistFields(p: any, keys: string[]) {
      if (Object.keys(p).some((k) => !keys.includes(k)))
        throw new Error("Unexpected AI suggestions field");
    }
    async function assistStatus() {
      const provider = ownerSetting("assistProvider");
      return {
        provider: ASSIST_PROVIDERS.includes(provider as AssistProvider)
          ? provider
          : "",
        model: ownerSetting("assistModel"),
        adapters: await Promise.all(
          ASSIST_PROVIDERS.map((name) => probeAdapter(name, executable(name))),
        ),
        running: assistBusy,
      };
    }
    async function assistAdapter() {
      const provider = ownerSetting("assistProvider") as AssistProvider | "";
      if (!provider || !ASSIST_PROVIDERS.includes(provider))
        throw new Error(
          "AI suggestions are off. Turn them on in AI suggestions settings first.",
        );
      const status = await probeAdapter(provider, executable(provider));
      if (status.state === "unavailable") throw new Error(status.detail);
      return { status, model: ownerSetting("assistModel") };
    }
    function excludeList(v: unknown) {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > 1000)
        throw new Error("Invalid excluded paths");
      return v.map(gitPath);
    }
    async function commitPreview(p: any, provider: string, model: string) {
      const r = await repository(p);
      const snap = await stagedSnapshot(r, excludeList(p.exclude));
      if (!snap.files.length)
        throw new Error("Nothing is staged. Stage the changes to describe first.");
      if (!snap.diff)
        throw new Error(
          "Every staged file is excluded or omitted, so there is nothing to send.",
        );
      const input = commitPrompt(snap.diff, snap.omitted);
      return {
        kind: "commit" as const,
        provider,
        model,
        stagedHash: snap.stagedHash,
        files: snap.files,
        omitted: snap.omitted,
        input,
        inputHash: hashText(input),
        bytes: snap.bytes,
        limit: ASSIST_DIFF_LIMIT,
      };
    }
    /** Owner-selectable naming context. Terminal output is never read. */
    function nameSources(s: Session) {
      const bounded = (value: string) =>
        value.length > 2000 ? value.slice(0, 2000) + "…" : value;
      const sources: { id: "task" | "firstMessage" | "folder"; label: string; text: string }[] = [];
      if (s.attemptId) {
        try {
          const task = get("tasks", get("attempts", s.attemptId).taskId);
          sources.push({
            id: "task",
            label: "Task title and description",
            text: bounded([task.title, task.description].filter(Boolean).join("\n\n")),
          });
        } catch {}
      }
      const launch = db
        .prepare(
          "SELECT r.request AS request FROM launch_intents i JOIN launch_requests r ON r.key=i.key WHERE i.sessionId=?",
        )
        .get(s.id) as { request: string } | undefined;
      if (launch && s.provider !== "shell") {
        try {
          const args: unknown = JSON.parse(launch.request).arguments;
          const at = Array.isArray(args) ? args.lastIndexOf("--") : -1;
          const first = at >= 0 ? (args as unknown[])[at + 1] : undefined;
          if (typeof first === "string" && first.trim())
            sources.push({ id: "firstMessage", label: "First message", text: bounded(first) });
        } catch {}
      }
      sources.push({ id: "folder", label: "Folder name", text: path.basename(s.cwd) });
      return sources;
    }
    function namePreview(p: any, provider: string, model: string) {
      const s = get("sessions", p.sessionId) as Session;
      if (
        !Array.isArray(p.include) ||
        !p.include.length ||
        p.include.length > 3 ||
        p.include.some((v: unknown) => !["task", "firstMessage", "folder"].includes(v as string))
      )
        throw new Error("Choose at least one kind of context to share");
      const sources = nameSources(s);
      const chosen = sources.filter((source) => p.include.includes(source.id));
      if (!chosen.length) throw new Error("The chosen context is not available for this session");
      const input = namePrompt(
        chosen
          .map((c) =>
            (c.id === "task" ? "Task" : c.id === "firstMessage" ? "First message" : "Folder") +
            ":\n" + c.text,
          )
          .join("\n\n"),
      );
      return {
        kind: "name" as const,
        provider,
        model,
        sessionId: s.id,
        generation: s.generation,
        titleRevision: s.titleRevision ?? 0,
        sources,
        input,
        inputHash: hashText(input),
      };
    }
    async function assist(command: "assist.preview" | "assist.suggest", p: any) {
      const kind = p.kind;
      const preview = command === "assist.preview";
      if (kind === "commit")
        assistFields(p, preview
          ? ["kind", "projectId", "worktreePath", "exclude", "hashOnly"]
          : ["kind", "projectId", "worktreePath", "exclude", "inputHash", "stagedHash"]);
      else if (kind === "name")
        assistFields(p, preview ? ["kind", "sessionId", "include"] : ["kind", "sessionId", "include", "inputHash"]);
      else throw new Error("Unknown AI suggestion kind");
      if (preview && p.hashOnly !== undefined) {
        if (p.hashOnly !== true || p.exclude !== undefined)
          throw new Error("Invalid staged fingerprint request");
        return { stagedHash: await stagedHash(await repository(p)) };
      }
      const { status, model } = await assistAdapter();
      const shown =
        kind === "commit"
          ? await commitPreview(p, status.provider, model)
          : namePreview(p, status.provider, model);
      if (preview) return shown;
      if (typeof p.inputHash !== "string" || p.inputHash !== shown.inputHash)
        throw new Error("What would be sent changed since the preview. Review the preview again.");
      if (kind === "commit" && p.stagedHash !== (shown as { stagedHash: string }).stagedHash)
        throw new Error("Staged changes changed since the preview. Review the preview again.");
      if (assistBusy) throw new Error("A suggestion is already being generated.");
      assistBusy = true;
      try {
        const text = await runSuggestion({
          status,
          model: model || undefined,
          input: shown.input,
          register: (handle) => {
            assistRun = handle;
          },
        });
        if (kind === "commit")
          return {
            kind,
            message: cleanCommitMessage(text).message,
            stagedHash: (shown as { stagedHash: string }).stagedHash,
            inputHash: shown.inputHash,
          };
        const named = shown as ReturnType<typeof namePreview>;
        return {
          kind,
          name: cleanSessionName(text),
          sessionId: named.sessionId,
          generation: named.generation,
          titleRevision: named.titleRevision,
          inputHash: shown.inputHash,
        };
      } finally {
        assistBusy = false;
        assistRun = undefined;
      }
    }
    function settingKey(v: unknown): keyof OwnerSettings {
      if (typeof v !== "string" || !Object.hasOwn(ownerDefaults, v))
        throw new Error("Unknown setting");
      return v as keyof OwnerSettings;
    }
    function size(v: unknown, fallback: number) {
      if (v === undefined) return fallback;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 2 || v > 500)
        throw new Error("Invalid terminal dimensions");
      return v;
    }
    function recordStatus(s: Session, status: Session["status"]) {
      // Another observer (reconcile, attach, launch) may have written this
      // record since `s` was read; merge into the latest so its exit status
      // and saved screen are never dropped.
      let latest: Session;
      try {
        latest = get("sessions", s.id);
      } catch {
        latest = s;
      }
      latest.status = status;
      if (s.exitCode !== undefined) latest.exitCode = s.exitCode;
      if (s.transcript) latest.transcript = true;
      if (status === "exited" || !s.activity) delete latest.activity;
      else latest.activity = s.activity;
      if (status === "exited" || s.activityAt === undefined)
        delete latest.activityAt;
      else latest.activityAt = s.activityAt;
      Object.assign(s, latest);
      put("sessions", latest);
      if (s.attemptId) {
        const a = get("attempts", s.attemptId);
        a.status = status;
        put("attempts", a);
      }
    }
    let closed = false;
    let closing: Promise<void> | undefined;
    let reconciling: Promise<void> | undefined;
    async function reconcile() {
      const candidates = list("sessions").filter(
        (s) => s.status !== "exited" && !activeLaunches.has(s.id),
      );
      if (!candidates.length || closed) return;
      const panesBySocket = new Map<
        string,
        Map<string, PaneState> | undefined
      >();
      await Promise.all(
        [...new Set(candidates.map(sessionSocket))].map(async (target) =>
          panesBySocket.set(target, await socketSessions(target)),
        ),
      );
      if (closed) return;
      let updated = false;
      for (const s of candidates) {
        if (activeLaunches.has(s.id)) continue;
        const current = get("sessions", s.id) as Session;
        if (current.status === "exited") continue;
        const panes = panesBySocket.get(sessionSocket(s));
        const pane = panes?.get(s.backendName);
        if (pane?.dead) await finalize(current, pane.exitCode);
        if (closed) return;
        const observed = panes
          ? pane && !pane.dead
            ? "running"
            : "exited"
          : "unknown";
        // Hooks write turn state into the pane; an unreachable socket keeps the last value.
        const fromPane = observed === "running" && current.activityTracking;
        const activity =
          observed === "exited"
            ? undefined
            : fromPane
              ? pane!.activity
              : current.activity;
        // The report time comes only from the hook; repeating a snapshot never renews it.
        const activityAt =
          observed === "exited"
            ? undefined
            : fromPane
              ? pane!.activityAt
              : current.activityAt;
        if (
          current.status !== observed ||
          current.activity !== activity ||
          current.activityAt !== activityAt
        ) {
          current.activity = activity;
          if (!activity) delete current.activity;
          current.activityAt = activityAt;
          if (activityAt === undefined) delete current.activityAt;
          recordStatus(current, observed);
          updated = true;
        }
      }
      if (updated) changed();
    }
    /**
     * Pasted images stay while their session may still use them. Retention
     * counts from the first time an ended (or removed) session is seen here.
     */
    function cleanupAttachments(at = Date.now()) {
      const sessions = new Map(
        (list("sessions") as Session[]).map((s) => [s.id, s]),
      );
      for (const record of list("attachments") as AttachmentRecord[]) {
        const owner = sessions.get(record.sessionId);
        if (owner && owner.status !== "exited") continue;
        if (!record.sessionEndedAt) {
          record.sessionEndedAt = new Date(at).toISOString();
          put("attachments", record);
        } else if (at - Date.parse(record.sessionEndedAt) > ATTACHMENT_GRACE_MS) {
          removeAttachmentFile(dataDir, record);
          db.prepare("DELETE FROM records WHERE kind='attachments' AND id=?").run(
            record.id,
          );
        }
      }
    }
    try {
      cleanupAttachments();
    } catch {}
    const cleanupTimer = setInterval(() => {
      try {
        cleanupAttachments();
      } catch {}
    }, 60 * 60 * 1000);
    cleanupTimer.unref();
    async function createAttachment(input: {
      sessionId: unknown;
      generation: unknown;
      data: unknown;
    }): Promise<SavedAttachment> {
      if (!(input.data instanceof Uint8Array))
        throw new Error("Invalid attachment data");
      const s = session({ sessionId: input.sessionId });
      if (input.generation !== s.generation)
        throw new Error("Stale session generation");
      if (s.status !== "running" || (await live(s)) !== "running")
        throw new Error("Session is not running");
      const saved = writeAttachment(dataDir, s.id, input.data);
      const record: AttachmentRecord = {
        id: id(),
        sessionId: s.id,
        generation: s.generation,
        mime: "image/png",
        ...saved,
        createdAt: now(),
      };
      try {
        put("attachments", record);
      } catch (error) {
        fs.rmSync(saved.path, { force: true });
        throw error;
      }
      return { id: record.id, ...saved };
    }
    const reconciliationTimer = setInterval(() => {
      if (!reconciling)
        reconciling = reconcile()
          .catch(() => {})
          .finally(() => {
            reconciling = undefined;
          });
    }, 2000);
    reconciliationTimer.unref();
    function enqueue<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
      const previous = queues.get(key) || Promise.resolve();
      const next = previous.catch(() => {}).then(fn);
      queues.set(key, next);
      return next;
    }
    function invoke(command: Command, payload: Record<string, unknown>) {
      // Suggestions only read Git and settings; a slow provider must not
      // hold up mutations, and cancel must not wait behind the run.
      if (command.startsWith("assist.")) return execute(command, payload);
      const key =
        command === "attempt.start" || command === "terminal.open"
          ? "launch"
          : command.startsWith("session.")
            ? "session:" + payload.sessionId
            : "mutations";
      return enqueue(key, () => execute(command, payload));
    }
    controller = createAgentControl({
      dataDir,
      db,
      list,
      put,
      changed,
      serialize: (fn) => enqueue("mutations", fn),
      invoke: (command, payload) => {
        if (closed) throw new Error("Core is closed");
        return invoke(command, payload);
      },
      projectRoot: (projectId) => {
        const project = get("projects", projectId);
        const canonical = fs.realpathSync(project.path);
        if (canonical !== project.path)
          throw new Error("Project path changed; register its current location");
        return canonical;
      },
      launchedWithControl: (sessionId) => {
        const row = db
          .prepare(
            "SELECT r.request FROM launch_intents i JOIN launch_requests r ON r.key=i.key WHERE i.sessionId=?",
          )
          .get(sessionId) as { request: string } | undefined;
        try {
          return !!row && JSON.parse(row.request).control === true;
        } catch {
          return false;
        }
      },
    });
    return {
      async invoke(command, payload = {}) {
        if (closed) throw new Error("Core is closed");
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new Error("Invalid payload");
        return invoke(command, payload);
      },
      async agentControl(action, payload) {
        if (closed) throw new Error("Core is closed");
        return controller.owner(action, payload);
      },
      async createAttachment(input) {
        if (closed) throw new Error("Core is closed");
        if (!input || typeof input !== "object")
          throw new Error("Invalid attachment");
        // Serialized with the session's own commands, so End cannot interleave.
        const key = "session:" + input.sessionId;
        const next = (queues.get(key) || Promise.resolve())
          .catch(() => {})
          .then(() => createAttachment(input));
        queues.set(key, next);
        return next;
      },
      close() {
        if (closing) return closing;
        closed = true;
        assistRun?.cancel("The workspace is closing.");
        clearInterval(reconciliationTimer);
        clearInterval(cleanupTimer);
        closing = (async () => {
          await controller.close().catch(() => {});
          await reconciling;
          await Promise.allSettled([...queues.values()]);
          await Promise.allSettled([...exitChecks]);
          for (const a of attachments.values())
            try {
              a.terminal.kill();
            } catch {}
          attachments.clear();
          try {
            db.close();
            fs.unlinkSync(lock);
          } finally {
            ownership!.close();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      db?.close();
    } catch {}
    try {
      if (ownerAcquired) fs.unlinkSync(lock);
    } catch {}
    try {
      ownership?.close();
    } catch {}
    throw error;
  }
}
