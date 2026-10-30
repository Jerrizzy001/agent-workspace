import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { providerArguments } from "./providers.js";
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
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
function str(v: unknown, name: string) {
  if (typeof v !== "string" || !v.trim() || v.includes("\0"))
    throw new Error(`Invalid ${name}`);
  return v;
}
export async function createCore({
  dataDir,
  emit,
}: CoreOptions): Promise<Core> {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, "owner.lock");
  try {
    const previous = JSON.parse(fs.readFileSync(lock, "utf8"));
    try {
      process.kill(previous.pid, 0);
      throw new Error("Workspace data is already owned by another core");
    } catch (e: any) {
      if (e.code !== "ESRCH") throw e;
    }
    fs.unlinkSync(lock);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  const db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,time TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS launch_intents (key TEXT PRIMARY KEY,sessionId TEXT NOT NULL,attemptId TEXT NOT NULL); PRAGMA user_version=1;",
  );
  const tmux = process.env.WORKSPACE_TMUX || executable("tmux");
  const tmuxConfig = path.join(dataDir, "tmux.conf");
  fs.writeFileSync(
    tmuxConfig,
    "set -g status off\nset -g history-limit 5000\n",
    { mode: 0o600 },
  );
  const activeLaunches = new Set<string>();
  const socket = path.join(
    os.tmpdir(),
    `aw-${hash(dataDir).slice(0, 20)}.sock`,
  );
  const tx = async (args: string[]) => {
    if (!tmux)
      throw new Error(
        "tmux is unavailable. Install tmux and restart the workspace.",
      );
    return await run(tmux, ["-f", tmuxConfig, "-S", socket, ...args]);
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
  const live = async (s: Session) => {
    try {
      await tx(["has-session", "-t", "=" + s.backendName]);
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
        await tx(["set-option", "-t", s.backendName, "status", "off"]);
      } catch {}
    put("sessions", s);
    if (s.attemptId) {
      const a = get("attempts", s.attemptId);
      a.status = s.status;
      put("attempts", a);
    }
  }
  const capabilitySnapshot = ["tmux", "git", "claude", "codex"].map((name) => ({
    name,
    available: !!(name === "tmux" ? tmux : executable(name)),
    detail:
      name === "tmux"
        ? "Private persistent tmux sessions"
        : name === "git"
          ? "Local Git operations"
          : "Interactive terminal; structured approvals and activity unavailable",
  }));
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
    if (!p.worktreePath) return project.path;
    const w = str(p.worktreePath, "worktreePath");
    const trees = await worktrees(project.path);
    if (!trees.some((t) => t.path === fs.realpathSync(w)))
      throw new Error("Worktree does not belong to project");
    return fs.realpathSync(w);
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
    return (await run("git", ["worktree", "list", "--porcelain"], r))
      .trim()
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const lines = block.split("\n");
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
          socket,
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
      terminal.onExit(async ({ exitCode }) => {
        if (closed) return;
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
      });
    }
    if (!a.viewers.has(viewer) && a.viewers.size >= 32)
      throw new Error("Viewer limit reached");
    a.viewers.set(viewer, { cols, rows });
    a.stream.add(viewer);
    resize(s.id);
    for (let retry = 0; ; retry++) {
      try {
        await tx([
          "refresh-client",
          "-t",
          (a.terminal as pty.IPty & { ptsName: string }).ptsName,
          "-R",
        ]);
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
          description: p.description || "",
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
          if (p[k] !== undefined) t[k] = k === "title" ? str(p[k], k) : p[k];
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
          return JSON.parse(receipt.result);
        }
        const task = get("tasks", p.taskId);
        const provider = p.provider || "shell";
        if (!["shell", "claude", "codex"].includes(provider))
          throw new Error("Unsupported provider");
        const bin =
          provider === "shell"
            ? process.env.SHELL || "/bin/zsh"
            : executable(provider);
        if (!bin) throw new Error(`${provider} executable unavailable`);
        const providerArgs = providerArguments(provider, task, p.prompt);
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
          status: "unknown",
          createdAt: now(),
        };
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("INSERT INTO receipts VALUES (?,?,NULL)").run(key, digest);
          put("sessions", s);
          put("attempts", a);
          db.prepare("INSERT INTO launch_intents VALUES (?,?,?)").run(
            key,
            sid,
            aid,
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
          await tx(["set-option", "-t", s.backendName, "status", "off"]);
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
          data: await tx([
            "capture-pane",
            "-e",
            "-p",
            "-t",
            s.backendName + ":0.0",
            "-S",
            "-2000",
          ]),
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
        await tx(["kill-session", "-t", "=" + s.backendName]);
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
            path: path.join(typeof p.path === "string" ? p.path : ".", e.name),
            type: e.isDirectory() ? "directory" : "file",
          }));
      case "files.read": {
        const f = await scoped(p);
        if (fs.statSync(f).size > 2 * 1024 * 1024)
          throw new Error("File exceeds editor limit");
        const content = fs.readFileSync(f, "utf8");
        if (content.includes("\0"))
          throw new Error("Binary file cannot be edited");
        return { path: p.path, content, hash: hash(content) };
      }
      case "files.write": {
        const f = await scoped(p, true);
        if (
          typeof p.content !== "string" ||
          Buffer.byteLength(p.content) > 2 * 1024 * 1024
        )
          throw new Error("Invalid file content");
        const exists = fs.existsSync(f);
        if (
          (exists ? hash(fs.readFileSync(f, "utf8")) : null) !== p.expectedHash
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
      case "git.status": {
        const r = await root(p),
          output = await run("git", ["status", "--porcelain=v1", "-z"], r);
        const parts = output.split("\0");
        const files = [];
        for (let i = 0; i < parts.length; i++) {
          const line = parts[i]!;
          if (!line) continue;
          files.push({ index: line[0], working: line[1], path: line.slice(3) });
          if (line[0] === "R" || line[0] === "C") i++;
        }
        return {
          branch: (await run("git", ["branch", "--show-current"], r)).trim(),
          files,
        };
      }
      case "git.diff":
        return {
          diff: await run(
            "git",
            [
              "diff",
              ...(p.staged ? ["--cached"] : []),
              "--",
              ...(p.path ? [str(p.path, "path")] : []),
            ],
            await root(p),
          ),
        };
      case "git.stage":
      case "git.unstage": {
        if (
          !Array.isArray(p.paths) ||
          !p.paths.length ||
          p.paths.some(
            (v: any) =>
              typeof v !== "string" ||
              v.startsWith("/") ||
              v.split("/").includes(".."),
          )
        )
          throw new Error("Invalid Git paths");
        return {
          output: await run(
            "git",
            command === "git.stage"
              ? ["add", "--", ...p.paths]
              : ["restore", "--staged", "--", ...p.paths],
            await root(p),
          ),
        };
      }
      case "git.commit":
        return {
          output: await run(
            "git",
            ["commit", "-m", str(p.message, "message")],
            await root(p),
          ),
          hash: (await run("git", ["rev-parse", "HEAD"], await root(p))).trim(),
        };
      case "worktree.list":
        return await worktrees(await root(p));
      case "worktree.create": {
        const r = await root(p);
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
        if (!p.positions || typeof p.positions !== "object")
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
          body: p.body || "",
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
        if (p.body !== undefined) n.body = p.body;
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
  let reconciling: Promise<void> | undefined;
  async function reconcile() {
    const candidates = list("sessions").filter(
      (s) => s.status !== "exited" && !activeLaunches.has(s.id),
    );
    if (!candidates.length || closed) return;
    let names: Set<string> | undefined;
    try {
      names = new Set(
        (await tx(["list-sessions", "-F", "#{session_name}"]))
          .trim()
          .split("\n"),
      );
    } catch (error: any) {
      if (
        tmux &&
        /no server running|error connecting.*No such file/.test(
          String(error.stderr || error.message),
        )
      )
        names = new Set();
    }
    if (closed) return;
    let updated = false;
    for (const s of candidates) {
      if (activeLaunches.has(s.id)) continue;
      const current = get("sessions", s.id);
      if (current.status === "exited") continue;
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
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(reconciliationTimer);
      await reconciling;
      await Promise.allSettled([...queues.values()]);
      for (const a of attachments.values()) a.terminal.kill();
      attachments.clear();
      db.close();
      fs.unlinkSync(lock);
    },
  };
}
