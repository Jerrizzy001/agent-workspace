import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { validateCommand } from "./validation.js";
import type { Command, CoreEvent, Snapshot } from "../shared/contracts.js";
export interface GatewayOptions {
  dataDir: string;
  invoke(command: Command, payload?: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (event: CoreEvent) => void): () => void;
  host?: string;
  port?: number;
  tls?: { cert: string | Buffer; key: string | Buffer };
  allowedOrigins?: string[];
  publicOrigin?: string;
  allowedProjectIds?: string[];
  staticDir?: string;
}
export interface GatewayStatus {
  running: boolean;
  url: string;
  host: string;
  port: number;
  tls: boolean;
  clients: number;
}
export interface Gateway {
  status(): GatewayStatus;
  pairingSecret(): Promise<string>;
  revokeSessions(): Promise<void>;
  stop(): Promise<void>;
}
const loopback = (h: string) =>
  ["127.0.0.1", "::1", "[::1]", "localhost"].includes(h);
const digest = (v: string) =>
  crypto.createHash("sha256").update(v).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
const maxQueue = 4 * 1024 * 1024;
/** Single owner remote control. Authorized shells retain the host owner's filesystem privileges. */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const host = options.host || "127.0.0.1";
  if (!loopback(host) && !options.tls)
    throw new Error("Non-loopback listeners require TLS");
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535)
  )
    throw new Error("Invalid port");
  const origins = new Set<string>();
  for (const value of [
    ...(options.allowedOrigins || []),
    ...(options.publicOrigin ? [options.publicOrigin] : []),
  ]) {
    const u = new URL(value);
    if (
      u.origin !== value ||
      !["http:", "https:"].includes(u.protocol) ||
      (u.protocol === "http:" && !loopback(u.hostname))
    )
      throw new Error(
        "Allowed origins must be exact HTTPS origins or loopback HTTP origins",
      );
    origins.add(value);
  }
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const secretPath = path.join(options.dataDir, "remote-pairing.secret");
  let secret = "";
  function readSecret() {
    const fd = fs.openSync(
      secretPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > 128 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("Pairing file must be owner-only (0600)");
      const s = fs.readFileSync(fd, "utf8").trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(s))
        throw new Error("Invalid pairing file");
      return s;
    } finally {
      fs.closeSync(fd);
    }
  }
  try {
    secret = readSecret();
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    fs.writeFileSync(secretPath, random() + "\n", { flag: "wx", mode: 0o600 });
    secret = readSecret();
  }
  const initial = (await options.invoke("snapshot")) as Snapshot;
  const allowed = new Set(
    options.allowedProjectIds || initial.projects.map((p) => p.id),
  );
  let latest = initial;
  function publicSession(s: Snapshot["sessions"][number]) {
    return {
      id: s.id,
      attemptId: s.attemptId,
      projectId: s.projectId,
      provider: s.provider,
      cwd: s.cwd,
      backendName: s.backendName,
      generation: s.generation,
      status: s.status,
      createdAt: s.createdAt,
      ...(s.model ? { model: s.model } : {}),
      ...(s.activity ? { activity: s.activity } : {}),
      ...(s.activityTracking ? { activityTracking: true } : {}),
      ...(s.conversationId ? { conversationId: s.conversationId } : {}),
      ...(s.resumedFrom ? { resumedFrom: s.resumedFrom } : {}),
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      ...(s.transcript ? { transcript: true } : {}),
    };
  }
  function filtered(s: Snapshot): Snapshot {
    return {
      ...s,
      projects: s.projects.filter((p) => allowed.has(p.id)),
      tasks: s.tasks.filter((t) => allowed.has(t.projectId)),
      attempts: s.attempts.filter((a) => allowed.has(a.projectId)),
      sessions: s.sessions
        .filter((s) => allowed.has(s.projectId))
        .map(publicSession),
      notes: s.notes.filter((n) => allowed.has(n.projectId)),
      layouts: s.layouts.filter((l) => allowed.has(l.projectId)),
    };
  }
  const sessions = new Map<string, { expires: number; secure: boolean }>();
  type Viewer = {
    sessionId: string;
    generation: number;
    alias: string;
    serverId: string;
  };
  type Client = {
    ws: WebSocket;
    sessionKey: string;
    viewers: Map<string, Viewer>;
    pending: number;
    closed: boolean;
    alive: boolean;
    ids: Set<string>;
    queue: Promise<void>;
    cleanup?: Promise<void>;
  };
  const clients = new Set<Client>();
  const attempts = new Map<string, { start: number; count: number }>();
  const inFlight = new Set<Promise<void>>();
  const cleanup = new Set<Promise<void>>();
  let pendingTotal = 0,
    running = true,
    port = 0,
    url = "",
    cookieName = "";
  let stopPromise: Promise<void> | undefined;
  function liveSession(key: string) {
    const entry = sessions.get(key);
    return !!entry && entry.expires >= Date.now();
  }
  function authorized(req: http.IncomingMessage) {
    const raw = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
    const key = digest(raw),
      entry = sessions.get(key);
    if (!entry || entry.expires < Date.now()) {
      sessions.delete(key);
      return undefined;
    }
    return key;
  }
  function validHost(req: http.IncomingMessage) {
    if (!req.headers.host) return false;
    return [...origins].some((o) => new URL(o).host === req.headers.host);
  }
  function validOrigin(req: http.IncomingMessage) {
    return (
      typeof req.headers.origin === "string" &&
      origins.has(req.headers.origin) &&
      new URL(req.headers.origin).host === req.headers.host
    );
  }
  function headers(res: http.ServerResponse, req: http.IncomingMessage) {
    const socketOrigins = [...origins]
      .filter((o) => new URL(o).host === req.headers.host)
      .map((o) => o.replace(/^http/, "ws"))
      .join(" ");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${socketOrigins}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
  }
  function json(res: http.ServerResponse, code: number, value: unknown) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }
  async function body(req: http.IncomingMessage) {
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      throw new Error("JSON required");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw new Error("Request too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  function closeClient(c: Client, reason: string) {
    if (c.closed) return;
    c.closed = true;
    c.ws.close(1008, reason);
    void detach(c);
  }
  function detach(c: Client): Promise<void> {
    if (c.cleanup) return c.cleanup;
    clients.delete(c);
    c.cleanup = Promise.allSettled(
      [...c.viewers.values()].map((v) =>
        options.invoke("session.detach", {
          sessionId: v.sessionId,
          generation: v.generation,
          viewerId: v.serverId,
        }),
      ),
    ).then(() => {
      c.viewers.clear();
    });
    cleanup.add(c.cleanup);
    void c.cleanup.finally(() => cleanup.delete(c.cleanup!));
    return c.cleanup;
  }
  function send(c: Client, value: unknown) {
    if (c.closed || c.ws.readyState !== WebSocket.OPEN) return;
    if (!liveSession(c.sessionKey)) {
      closeClient(c, "Session expired");
      return;
    }
    const encoded = JSON.stringify(value);
    if (
      Buffer.byteLength(encoded) > maxQueue ||
      c.ws.bufferedAmount + Buffer.byteLength(encoded) > maxQueue
    ) {
      closeClient(c, "Client must reconnect");
      return;
    }
    c.ws.send(encoded);
  }
  const handler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    headers(res, req);
    try {
      if (!running) {
        json(res, 503, { error: "Gateway stopped" });
        return;
      }
      if (!validHost(req)) {
        json(res, 403, { error: "Host denied" });
        return;
      }
      const target = new URL(req.url || "/", "http://gateway.invalid");
      if (target.search || target.hash) {
        json(res, 400, { error: "Query parameters are unsupported" });
        return;
      }
      if (req.method === "GET" && target.pathname === "/api/status") {
        json(res, 200, {
          protocol: 1,
          authenticated: !!authorized(req),
          authMode: "pairing",
        });
        return;
      }
      if (req.method === "POST") {
        if (!validOrigin(req)) {
          json(res, 403, { error: "Origin denied" });
          return;
        }
        if (target.pathname === "/api/login") {
          const address = req.socket.remoteAddress || "unknown",
            now = Date.now();
          let bucket = attempts.get(address);
          if (!bucket || now - bucket.start > 60000) {
            bucket = { start: now, count: 0 };
            if (attempts.size >= 1000)
              attempts.delete(attempts.keys().next().value!);
            attempts.set(address, bucket);
          }
          if (++bucket.count > 5) {
            res.setHeader("Retry-After", "60");
            json(res, 429, { error: "Try again later" });
            return;
          }
          const p = await body(req);
          const supplied = typeof p?.secret === "string" ? p.secret : "";
          if (
            supplied.length !== secret.length ||
            !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
          ) {
            json(res, 401, { error: "Pairing failed" });
            return;
          }
          if (sessions.size >= 64) {
            json(res, 429, {
              error: "Session limit reached; revoke sessions locally",
            });
            return;
          }
          const token = random(),
            secure = !!options.tls || req.headers.origin!.startsWith("https:");
          sessions.set(digest(token), {
            expires: Date.now() + 12 * 60 * 60 * 1000,
            secure,
          });
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`,
          );
          json(res, 200, { ok: true });
          return;
        }
        if (target.pathname === "/api/logout") {
          const key = authorized(req);
          if (!key) {
            json(res, 401, { error: "Authentication required" });
            return;
          }
          sessions.delete(key);
          for (const c of clients)
            if (c.sessionKey === key) closeClient(c, "Session revoked");
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${options.tls || req.headers.origin!.startsWith("https:") ? "; Secure" : ""}`,
          );
          json(res, 200, { ok: true });
          return;
        }
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        json(res, 405, { error: "Method denied" });
        return;
      }
      if (target.pathname.startsWith("/api/")) {
        json(res, 404, { error: "Not found" });
        return;
      }
      if (!options.staticDir) {
        json(res, 404, { error: "Renderer unavailable; build the app first" });
        return;
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(target.pathname);
      } catch {
        json(res, 400, { error: "Invalid path" });
        return;
      }
      if (
        pathname.includes("\0") ||
        pathname.includes("\\") ||
        pathname.split("/").some((s) => s === ".." || s.startsWith("."))
      ) {
        json(res, 403, { error: "Path denied" });
        return;
      }
      const base = fs.realpathSync(options.staticDir);
      const candidate = path.join(
        base,
        pathname === "/" ? "index.html" : pathname,
      );
      let file: string;
      try {
        file = fs.realpathSync(candidate);
      } catch {
        json(res, 404, { error: "Not found" });
        return;
      }
      if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) {
        json(res, 403, { error: "Path denied" });
        return;
      }
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".webmanifest": "application/manifest+json",
      };
      res.setHeader(
        "content-type",
        mime[path.extname(file)] || "application/octet-stream",
      );
      if (req.method === "HEAD") res.end();
      else
        fs.createReadStream(file)
          .on("error", () => res.destroy())
          .pipe(res);
    } catch {
      if (!res.headersSent) json(res, 400, { error: "Invalid request" });
      else res.destroy();
    }
  };
  const server = options.tls
    ? https.createServer(options.tls, handler)
    : http.createServer(handler);
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  server.maxConnections = 128;
  server.keepAliveTimeout = 5000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2300000,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    const key = authorized(req);
    if (
      !running ||
      req.url !== "/api/ws" ||
      !validHost(req) ||
      !validOrigin(req) ||
      !key ||
      clients.size >= 32
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Client = {
        ws,
        sessionKey: key,
        viewers: new Map(),
        pending: 0,
        closed: false,
        alive: true,
        ids: new Set(),
        queue: Promise.resolve(),
      };
      clients.add(c);
      ws.on("error", () => {});
      ws.on("close", () => {
        c.closed = true;
        void detach(c);
      });
      ws.on("pong", () => {
        c.alive = true;
      });
      send(c, { type: "hello", version: 1 });
      ws.on("message", (bytes, binary) => {
        if (c.closed) return;
        if (!liveSession(c.sessionKey)) {
          closeClient(c, "Session expired");
          return;
        }
        if (binary || c.pending >= 16 || pendingTotal >= 128) {
          closeClient(c, "Request limit reached");
          return;
        }
        let m: any;
        try {
          m = JSON.parse(bytes.toString());
          if (
            m.type !== "rpc" ||
            m.version !== 1 ||
            typeof m.id !== "string" ||
            !m.id ||
            m.id.length > 128 ||
            c.ids.has(m.id)
          )
            throw new Error("Invalid RPC");
        } catch {
          closeClient(c, "Invalid RPC");
          return;
        }
        c.pending++;
        pendingTotal++;
        c.ids.add(m.id);
        const operation = c.queue.then(async () => {
          let attaching: Viewer | undefined;
          try {
            if (c.closed || !liveSession(c.sessionKey))
              throw new Error("Session revoked");
            const { command, payload: p } = validateCommand(
              m.command,
              m.payload ?? {},
            );
            // Terminal scope follows authoritative snapshots; avoid SQLite reads for every keystroke/ACK.
            // Other commands refresh metadata before resource authorization.
            if (!command.startsWith("session."))
              latest = (await options.invoke("snapshot")) as Snapshot;
            if (c.closed || !liveSession(c.sessionKey))
              throw new Error("Session revoked");
            let projectId = p.projectId;
            if (p.taskId)
              projectId = latest.tasks.find(
                (t) => t.id === p.taskId,
              )?.projectId;
            if (p.noteId)
              projectId = latest.notes.find(
                (n) => n.id === p.noteId,
              )?.projectId;
            if (p.sessionId)
              projectId = latest.sessions.find(
                (s) => s.id === p.sessionId,
              )?.projectId;
            if (
              command !== "snapshot" &&
              (typeof projectId !== "string" || !allowed.has(projectId))
            )
              throw new Error("Project access denied");
            if (command.startsWith("session.") && p.viewerId) {
              const viewerKey = p.sessionId + "\0" + p.viewerId;
              let v = c.viewers.get(viewerKey);
              if (command === "session.attach") {
                if (!v) {
                  if (c.viewers.size >= 32)
                    throw new Error("Viewer limit reached");
                  v = {
                    sessionId: String(p.sessionId),
                    generation: Number(p.generation),
                    alias: String(p.viewerId),
                    serverId: "remote:" + crypto.randomUUID(),
                  };
                  c.viewers.set(viewerKey, v);
                }
                attaching = v;
              }
              if (!v || v.generation !== p.generation)
                throw new Error("Viewer is not attached to this connection");
              p.viewerId = v.serverId;
              const result = await options.invoke(command, p);
              if (command === "session.detach") c.viewers.delete(viewerKey);
              if (c.closed && command === "session.attach")
                await options.invoke("session.detach", {
                  sessionId: v.sessionId,
                  generation: v.generation,
                  viewerId: v.serverId,
                });
              send(c, { type: "result", id: m.id, result });
            } else {
              const raw =
                command === "snapshot"
                  ? latest
                  : await options.invoke(command, p);
              const result =
                command === "snapshot" || command === "layout.save"
                  ? filtered(raw as Snapshot)
                  : command === "attempt.start" ||
                      command === "terminal.open"
                    ? {
                        ...(raw as any),
                        session: publicSession((raw as any).session),
                      }
                    : raw;
              send(c, { type: "result", id: m.id, result });
            }
          } catch (error: any) {
            if (attaching) {
              for (const [k, v] of c.viewers)
                if (v === attaching) c.viewers.delete(k);
              await options
                .invoke("session.detach", {
                  sessionId: attaching.sessionId,
                  generation: attaching.generation,
                  viewerId: attaching.serverId,
                })
                .catch(() => {});
            }
            // Core failures can contain host stderr; remote owner receives a bounded diagnostic.
            send(c, {
              type: "result",
              id: m.id,
              error: String(error?.message || "Command failed").slice(0, 2048),
            });
          } finally {
            c.pending--;
            pendingTotal--;
            c.ids.delete(m.id);
          }
        });
        c.queue = operation.catch(() => {});
        inFlight.add(operation);
        void operation.finally(() => inFlight.delete(operation));
      });
    });
  });
  const unsubscribe = options.subscribe((event) => {
    if (event.type === "snapshot") latest = event.snapshot;
    for (const c of clients) {
      if (event.type === "terminal.data" || event.type === "terminal.resync") {
        const v = [...c.viewers.values()].find(
          (v) =>
            v.serverId === event.viewerId && v.sessionId === event.sessionId,
        );
        if (v)
          send(c, { type: "event", event: { ...event, viewerId: v.alias } });
      } else if (event.type === "snapshot")
        send(c, {
          type: "event",
          event: { type: "snapshot", snapshot: filtered(event.snapshot) },
        });
      else if (
        event.type !== "session.exit" ||
        latest.sessions.some(
          (s) => s.id === event.sessionId && allowed.has(s.projectId),
        )
      )
        send(c, { type: "event", event });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 8787, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    unsubscribe();
    wss.close();
    throw error;
  }
  port = (server.address() as import("node:net").AddressInfo).port;
  const scheme = options.tls ? "https" : "http",
    address = host.includes(":") ? "[" + host + "]" : host;
  const boundUrl = `${scheme}://${address}:${port}`;
  url = options.publicOrigin || boundUrl;
  // Cookies ignore ports; separate workspaces on the same host must not overwrite each other's login.
  // The name remains stable across restarts at the same externally visible origin.
  cookieName =
    "aw_session_" +
    digest(fs.realpathSync(options.dataDir) + "\0" + url).slice(0, 24);
  origins.add(boundUrl);
  if (loopback(host)) {
    origins.add(`${scheme}://localhost:${port}`);
    origins.add(`${scheme}://127.0.0.1:${port}`);
    origins.add(`${scheme}://[::1]:${port}`);
  }
  const timer = setInterval(() => {
    for (const [key, value] of sessions)
      if (value.expires < Date.now()) {
        sessions.delete(key);
        for (const c of clients)
          if (c.sessionKey === key) closeClient(c, "Session expired");
      }
    for (const c of clients) {
      if (c.closed) continue;
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30000);
  timer.unref();
  return {
    status: () => ({
      running,
      url,
      host,
      port,
      tls: !!options.tls,
      clients: clients.size,
    }),
    pairingSecret: async () => secret,
    async revokeSessions() {
      sessions.clear();
      for (const c of clients) closeClient(c, "Access revoked");
      const next = random(),
        temp = secretPath + "." + crypto.randomUUID();
      try {
        fs.writeFileSync(temp, next + "\n", { flag: "wx", mode: 0o600 });
        fs.renameSync(temp, secretPath);
        secret = next;
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
    },
    stop() {
      if (stopPromise) return stopPromise;
      running = false;
      clearInterval(timer);
      unsubscribe();
      sessions.clear();
      const serverClosed = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      stopPromise = (async () => {
        await Promise.allSettled(
          [...clients].map(async (c) => {
            closeClient(c, "Gateway stopped");
            c.ws.terminate();
            await detach(c);
          }),
        );
        for (const ws of wss.clients) ws.terminate();
        await Promise.allSettled([...inFlight]);
        await Promise.allSettled([...cleanup]);
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await serverClosed;
      })();
      return stopPromise;
    },
  };
}
