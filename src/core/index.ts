import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { isUtf8 } from "node:buffer";
import { gitStatus, gitDiff, gitIndex } from "./git.js";
import { providerArguments, providerModel } from "./providers.js";
import { TerminalStream } from "./stream.js";
import { run, executable } from "./process.js";
import * as pty from "node-pty";
import type {
  Core,
  CoreOptions,
  Command,
  Snapshot,
  Session,
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
    if (
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version > 1
    )
      throw new Error("Workspace data belongs to a newer app version");
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,time TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS launch_intents (key TEXT PRIMARY KEY,sessionId TEXT NOT NULL,attemptId TEXT NOT NULL); CREATE TABLE IF NOT EXISTS launch_requests (key TEXT PRIMARY KEY,request TEXT NOT NULL); PRAGMA user_version=1;",
    );
    const tmux = process.env.WORKSPACE_TMUX || executable("tmux");
    const tmuxConfig = path.join(dataDir, "tmux.conf");
    fs.writeFileSync(
      tmuxConfig,
      "set -g status off\nset -g history-limit 5000\n",
      { mode: 0o600 },
    );
    const activeLaunches = new Set<string>();
    let socket = path.join(
      os.tmpdir(),
      `aw-${hash(dataDir).slice(0, 20)}.sock`,
    );
    const tx = async (args: string[], targetSocket = socket) => {
      if (!tmux)
        throw new Error(
          "tmux is unavailable. Install tmux and restart the workspace.",
        );
      return await run(tmux, ["-f", tmuxConfig, "-S", targetSocket, ...args]);
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
    async function socketSessions(
      target: string,
    ): Promise<Set<string> | undefined> {
      try {
        return new Set(
          (await tx(["list-sessions", "-F", "#{session_name}"], target))
            .trim()
            .split("\n"),
        );
      } catch (error: any) {
        return tmux &&
          /no server running|error connecting.*No such file/.test(
            String(error.stderr || error.message),
          )
          ? new Set()
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
    const catalog = new Map<string, Set<string> | undefined>();
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
    const live = async (s: Session) => {
      try {
        await tx(["has-session", "-t", "=" + s.backendName], sessionSocket(s));
        return "running";
      } catch (error: any) {
        const detail = String(error.stderr || error.message);
        return tmux &&
          /no server running|no such session|can't find session|error connecting.*No such file/.test(
            detail,
          )
          ? "exited"
          : "unknown";
      }
    };
    for (const s of list("sessions")) {
      s.status = await live(s);
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
    const capabilitySnapshot = ["tmux", "git", "claude", "codex"].map(
      (name) => ({
        name,
        available: !!(name === "tmux" ? tmux : executable(name)),
        detail:
          name === "tmux"
            ? "Private persistent tmux sessions"
            : name === "git"
              ? "Local Git operations"
              : "Interactive terminal; structured approvals and activity unavailable",
      }),
    );
    const snapshot = (): Snapshot => ({
      projects: list("projects"),
      tasks: list("tasks"),
      attempts: list("attempts"),
      sessions: list("sessions"),
      notes: list("notes"),
      layouts: list("layouts"),
      capabilities: capabilitySnapshot,
    });
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
            if ((await live(s)) === "exited" && !closed) {
              s.status = "exited";
              put("sessions", s);
              const at = get("attempts", s.attemptId);
              at.status = "exited";
              put("attempts", at);
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
        case "attempt.start": {
          const key = str(p.idempotencyKey, "idempotencyKey");
          const digest = hash(JSON.stringify(p));
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
                  const attempt = get("attempts", intent.attemptId);
                  session.status = "running";
                  attempt.status = "running";
                  const result = { attempt, session };
                  db.exec("BEGIN IMMEDIATE");
                  try {
                    put("sessions", session);
                    put("attempts", attempt);
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
              attempt: get("attempts", result.attempt.id),
              session: get("sessions", result.session.id),
            };
          }
          const task = get("tasks", p.taskId);
          const provider = p.provider || "shell";
          if (!["shell", "claude", "codex"].includes(provider))
            throw new Error("Unsupported provider");
          const bin =
            provider === "shell"
              ? process.env.SHELL ||
                (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
              : executable(provider);
          if (!bin) throw new Error(`${provider} executable unavailable`);
          const providerArgs = providerArguments(
            provider,
            task,
            p.prompt,
            p.model,
          );
          const selectedModel = providerModel(provider, p.model);
          const cwd = await root({
            projectId: task.projectId,
            worktreePath: p.worktreePath,
          });
          if (!tmux)
            throw new Error("tmux is unavailable. Install tmux and restart.");
          const aid = id(),
            sid = id();
          const s = {
            id: sid,
            attemptId: aid,
            projectId: task.projectId,
            provider,
            cwd,
            backendName: "aw-" + sid,
            backendSocket: socket,
            generation: 1,
            status: "unknown",
            createdAt: now(),
          };
          const a = {
            id: aid,
            taskId: task.id,
            projectId: task.projectId,
            provider,
            sessionId: sid,
            worktreePath: cwd,
            ...(selectedModel ? { model: selectedModel } : {}),
            status: "unknown",
            createdAt: now(),
          };
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare("INSERT INTO receipts VALUES (?,?,NULL)").run(
              key,
              digest,
            );
            put("sessions", s);
            put("attempts", a);
            db.prepare("INSERT INTO launch_intents VALUES (?,?,?)").run(
              key,
              sid,
              aid,
            );
            db.prepare("INSERT INTO launch_requests VALUES (?,?)").run(
              key,
              JSON.stringify({
                taskId: task.id,
                provider,
                cwd,
                executable: bin,
                arguments: providerArgs,
              }),
            );
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
          activeLaunches.add(sid);
          try {
            await tx([
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
              bin,
              ...providerArgs,
            ]);
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
            db.exec("BEGIN IMMEDIATE");
            s.status = "running";
            a.status = "running";
            put("sessions", s);
            put("attempts", a);
            const result = { attempt: a, session: s };
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
          s.status = "exited";
          put("sessions", s);
          const a = get("attempts", s.attemptId);
          a.status = "exited";
          put("attempts", a);
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
          put("layouts", { projectId: p.projectId, positions: p.positions });
          return changed();
        }
        case "note.create": {
          get("projects", p.projectId);
          const n = {
            id: id(),
            projectId: p.projectId,
            title: str(p.title, "title"),
            body: text(p.body, "body"),
            createdAt: now(),
            updatedAt: now(),
          };
          put("notes", n);
          changed();
          return n;
        }
        case "note.update": {
          const n = get("notes", p.noteId);
          if (p.title !== undefined) n.title = str(p.title, "title");
          if (p.body !== undefined) n.body = text(p.body, "body");
          n.updatedAt = now();
          put("notes", n);
          changed();
          return n;
        }
        default:
          throw new Error("Unsupported command");
      }
    }
    function size(v: unknown, fallback: number) {
      if (v === undefined) return fallback;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 2 || v > 500)
        throw new Error("Invalid terminal dimensions");
      return v;
    }
    function recordStatus(s: Session, status: Session["status"]) {
      s.status = status;
      put("sessions", s);
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
      const namesBySocket = new Map<string, Set<string> | undefined>();
      await Promise.all(
        [...new Set(candidates.map(sessionSocket))].map(async (target) =>
          namesBySocket.set(target, await socketSessions(target)),
        ),
      );
      if (closed) return;
      let updated = false;
      for (const s of candidates) {
        if (activeLaunches.has(s.id)) continue;
        const current = get("sessions", s.id);
        if (current.status === "exited") continue;
        const names = namesBySocket.get(sessionSocket(s));
        const observed = names
          ? names.has(s.backendName)
            ? "running"
            : "exited"
          : "unknown";
        if (current.status !== observed) {
          recordStatus(current, observed);
          updated = true;
        }
      }
      if (updated) changed();
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
    return {
      async invoke(command, payload = {}) {
        if (closed) throw new Error("Core is closed");
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new Error("Invalid payload");
        const key =
          command === "attempt.start"
            ? "launch"
            : command.startsWith("session.")
              ? "session:" + payload.sessionId
              : "mutations";
        const previous = queues.get(key) || Promise.resolve();
        const next = previous
          .catch(() => {})
          .then(() => execute(command, payload));
        queues.set(key, next);
        return next;
      },
      close() {
        if (closing) return closing;
        closed = true;
        clearInterval(reconciliationTimer);
        closing = (async () => {
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
