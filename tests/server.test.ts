import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { startGateway } from "../src/server/gateway.js";
import type { CoreEvent, Snapshot } from "../src/shared/contracts.js";
const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
  const snapshot: Snapshot = {
    projects: [
      { id: "p", name: "allowed", path: "/fixture", createdAt: "" },
      { id: "hidden", name: "hidden", path: "/hidden", createdAt: "" },
    ],
    tasks: [],
    attempts: [],
    notes: [],
    layouts: [],
    boardLanes: [],
    capabilities: [],
    sessions: [
      {
        id: "s",
        projectId: "p",
        attemptId: null,
        provider: "shell",
        cwd: "/fixture",
        backendName: "fixture",
        generation: 1,
        status: "running",
        createdAt: "",
      },
    ],
  };
  const listeners = new Set<(e: CoreEvent) => void>(),
    calls: { command: string; payload: any }[] = [];
  return {
    snapshot,
    listeners,
    calls,
    emit: (e: CoreEvent) => {
      for (const fn of listeners) fn(e);
    },
    invoke: async (command: any, payload: any = {}) => {
      calls.push({ command, payload });
      return command === "snapshot" || command === "layout.save"
        ? snapshot
        : command === "terminal.open"
          ? {
              session: {
                ...snapshot.sessions[0],
                backendSocket: "/private/socket",
              },
            }
          : command === "session.rename"
            ? {
                ...snapshot.sessions[0],
                title: payload.title,
                titleRevision: 1,
                backendSocket: "/private/socket",
              }
            : command === "attempt.start"
              ? {
                  attempt: { id: "a" },
                  session: {
                    ...snapshot.sessions[0],
                    backendSocket: "/private/socket",
                  },
                }
              : { ok: true };
    },
    subscribe: (fn: (e: CoreEvent) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
async function client(url: string, cookie: string) {
  const ws = new WebSocket(url.replace("http", "ws") + "/api/ws", {
    origin: url,
    headers: { cookie },
  });
  const messages: any[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await once(ws, "open");
  let sequence = 0;
  return {
    ws,
    messages,
    async rpc(command: string, payload: any = {}) {
      const id = String(++sequence);
      ws.send(
        JSON.stringify({ type: "rpc", version: 1, id, command, payload }),
      );
      for (let i = 0; i < 200; i++) {
        const response = messages.find(
          (m) => m.type === "result" && m.id === id,
        );
        if (response) return response;
        await wait(5);
      }
      throw new Error("RPC timeout");
    },
  };
}
async function login(url: string, secret: string) {
  const res = await fetch(url + "/api/login", {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0];
}
async function rejectedSocket(url: string, origin: string, cookie = "") {
  const ws = new WebSocket(url.replace("http", "ws") + "/api/ws", {
    origin,
    headers: { cookie },
  });
  return new Promise<number>((resolve) => {
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    ws.on("error", () => {});
  });
}
test("gateway authenticates real sockets, scopes commands, targets streams and revokes access", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-")),
    f = fixture();
  const gateway = await startGateway({
    dataDir,
    ...f,
    port: 0,
    allowedProjectIds: ["p"],
  });
  const url = gateway.status().url;
  const sockets: WebSocket[] = [];
  try {
    const secret = await gateway.pairingSecret();
    assert.equal(
      fs.statSync(path.join(dataDir, "remote-pairing.secret")).mode & 0o777,
      0o600,
    );
    assert.deepEqual(await (await fetch(url + "/api/status")).json(), {
      protocol: 1,
      authenticated: false,
      authMode: "pairing",
    });
    assert.equal(await rejectedSocket(url, url), 403);
    const csrf = await fetch(url + "/api/login", {
      method: "POST",
      headers: {
        origin: "https://attacker.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret }),
    });
    assert.equal(csrf.status, 403);
    const cookie = await login(url, secret);
    assert.equal(
      await rejectedSocket(url, "https://attacker.invalid", cookie),
      403,
    );
    const a = await client(url, cookie),
      b = await client(url, cookie);
    sockets.push(a.ws, b.ws);
    assert.equal(
      (await a.rpc("project.add", { path: "/tmp" })).error,
      "Command is not available remotely",
    );
    assert.equal(
      (
        await a.rpc("worktree.create", {
          projectId: "p",
          branch: "feature",
          path: "/escape",
        })
      ).error,
      "Unexpected command field",
    );
    assert.equal(
      (await a.rpc("files.read", { projectId: "hidden", path: "secret" }))
        .error,
      "Project access denied",
    );
    const snap = await a.rpc("snapshot");
    assert.deepEqual(
      snap.result.projects.map((p: any) => p.id),
      ["p"],
    );
    const savedLayout = await a.rpc("layout.save", {
      projectId: "p",
      positions: {},
    });
    assert.deepEqual(
      savedLayout.result.projects.map((p: any) => p.id),
      ["p"],
    );
    f.snapshot.tasks.push({
      id: "task",
      projectId: "p",
      title: "fixture",
      description: "",
      status: "ready",
      revision: 1,
      createdAt: "",
      updatedAt: "",
    });
    const launched = await a.rpc("attempt.start", {
      taskId: "task",
      idempotencyKey: "fixture-key",
    });
    assert.equal(launched.result.session.backendSocket, undefined);
    // One-click folder launches stay inside shared projects; folder management stays local.
    const opened = await a.rpc("terminal.open", {
      projectId: "p",
      provider: "claude",
      path: "src",
      idempotencyKey: "folder-key",
    });
    assert.equal(opened.result.session.backendSocket, undefined);
    assert.match(
      (
        await a.rpc("terminal.open", {
          projectId: "hidden",
          provider: "shell",
          idempotencyKey: "hidden-key",
        })
      ).error,
      /Project access denied/,
    );
    // Naming is shared-project metadata; the result is projected like a snapshot.
    const renamed = await a.rpc("session.rename", {
      sessionId: "s",
      generation: 1,
      title: "Remote name",
      titleRevision: 0,
    });
    assert.equal(renamed.result.title, "Remote name");
    assert.equal(renamed.result.titleRevision, 1);
    assert.equal(renamed.result.backendSocket, undefined);
    assert.match(
      (
        await a.rpc("session.rename", {
          sessionId: "s",
          title: "x",
          titleRevision: 1,
        })
      ).error,
      /generation required/,
    );
    for (const [command, payload] of [
      ["project.add", { path: "/" }],
      ["project.hide", { projectId: "p" }],
      [
        "terminal.open",
        { projectId: "p", provider: "shell", idempotencyKey: "k", cwd: "/" },
      ],
    ] as const)
      assert.match(
        (await a.rpc(command, payload)).error,
        /not available remotely|Unexpected command field/,
      );
    // Owner preferences (keep-awake and friends) never cross the gateway.
    for (const [command, payload] of [
      ["settings.read", { key: "keepAwake" }],
      ["settings.write", { key: "keepAwake", value: true }],
      ["settings.write", { projectId: "p", key: "keepAwake", value: true }],
      ["settings.read", { key: "dictationModel" }],
      ["settings.write", { key: "dictationModel", value: "tiny.en" }],
    ] as const)
      assert.equal(
        (await a.rpc(command, payload)).error,
        "Command is not available remotely",
      );
    assert.equal(
      f.calls.some((c) => String(c.command).startsWith("settings.")),
      false,
    );
    // Report freshness is projected explicitly; private backend fields are not.
    Object.assign(f.snapshot.sessions[0], {
      activity: "running",
      activityTracking: true,
      activityAt: 1_800_000_000_000,
      backendSocket: "/private/socket",
    });
    const projected = (await a.rpc("snapshot")).result.sessions[0];
    assert.equal(projected.activityAt, 1_800_000_000_000);
    assert.equal(projected.backendSocket, undefined);
    for (const key of [
      "activity",
      "activityTracking",
      "activityAt",
      "backendSocket",
    ])
      delete (f.snapshot.sessions[0] as any)[key];
    const snapshotsBeforeTyping = f.calls.filter(
      (c) => c.command === "snapshot",
    ).length;
    await a.rpc("session.attach", {
      sessionId: "s",
      generation: 1,
      viewerId: "same",
    });
    await b.rpc("session.attach", {
      sessionId: "s",
      generation: 1,
      viewerId: "same",
    });
    const attaches = f.calls.filter((c) => c.command === "session.attach");
    assert.notEqual(attaches[0].payload.viewerId, attaches[1].payload.viewerId);
    f.emit({
      type: "terminal.data",
      sessionId: "s",
      viewerId: attaches[0].payload.viewerId,
      sequence: 1,
      data: "private-stream",
    });
    await wait();
    assert.equal(
      a.messages.filter(
        (m) => m.type === "event" && m.event.type === "terminal.data",
      ).length,
      1,
    );
    assert.equal(
      a.messages.find(
        (m) => m.type === "event" && m.event.type === "terminal.data",
      ).event.viewerId,
      "same",
    );
    assert.equal(
      b.messages.filter(
        (m) => m.type === "event" && m.event.type === "terminal.data",
      ).length,
      0,
    );
    assert.match(
      (
        await b.rpc("session.ack", {
          sessionId: "s",
          generation: 1,
          viewerId: attaches[0].payload.viewerId,
          sequence: 1,
        })
      ).error,
      /Viewer is not attached/,
    );
    assert.equal(
      (
        await b.rpc("session.input", {
          sessionId: "s",
          generation: 1,
          viewerId: "same",
          data: "hello",
        })
      ).result.ok,
      true,
    );
    assert.equal(
      f.calls.find((c) => c.command === "session.input")!.payload.viewerId,
      attaches[1].payload.viewerId,
    );
    assert.equal(
      f.calls.filter((c) => c.command === "snapshot").length,
      snapshotsBeforeTyping,
    );
    const before = f.calls.filter((c) => c.command === "session.detach").length;
    a.ws.close();
    await once(a.ws, "close");
    await wait();
    assert.ok(
      f.calls.filter((c) => c.command === "session.detach").length > before,
    );
    assert.equal(
      f.calls.filter((c) => c.command === "session.terminate").length,
      0,
    );
    const c = await client(url, cookie);
    sockets.push(c.ws);
    assert.equal((await c.rpc("snapshot")).result.sessions[0].id, "s");
    const closing = once(b.ws, "close");
    await gateway.revokeSessions();
    await closing;
    assert.notEqual(await gateway.pairingSecret(), secret);
    assert.equal(
      (
        (await fetch(url + "/api/status", { headers: { cookie } }).then((r) =>
          r.json(),
        )) as any
      ).authenticated,
      false,
    );
    assert.equal(await rejectedSocket(url, url, cookie), 403);
    assert.equal(gateway.status().clients, 0);
  } finally {
    for (const ws of sockets) ws.terminate();
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
test("gateway requires TLS for LAN, bounds auth and rejects unsafe static requests", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-")),
    f = fixture(),
    staticDir = path.join(dataDir, "web");
  fs.mkdirSync(staticDir);
  fs.writeFileSync(path.join(staticDir, "index.html"), "<html>fixture</html>");
  fs.writeFileSync(path.join(dataDir, "outside"), "outside");
  fs.symlinkSync(path.join(dataDir, "outside"), path.join(staticDir, "escape"));
  await assert.rejects(
    () => startGateway({ dataDir, ...f, host: "0.0.0.0", port: 0 }),
    /TLS/,
  );
  const gateway = await startGateway({ dataDir, ...f, port: 0, staticDir });
  const url = gateway.status().url;
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url + "/escape")).status, 403);
    assert.equal((await fetch(url + "/%2e%2e%2foutside")).status, 403);
    assert.equal((await fetch(url + "/?secret=forbidden")).status, 400);
    assert.equal(
      await new Promise((resolve) => {
        http.get(url, { headers: { host: "attacker.invalid" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
      }),
      403,
    );
    assert.match(
      (await fetch(url)).headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    for (let n = 0; n < 5; n++)
      assert.equal(
        (
          await fetch(url + "/api/login", {
            method: "POST",
            headers: { origin: url, "content-type": "application/json" },
            body: JSON.stringify({ secret: "wrong" }),
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await fetch(url + "/api/login", {
          method: "POST",
          headers: { origin: url, "content-type": "application/json" },
          body: JSON.stringify({ secret: await gateway.pairingSecret() }),
        })
      ).status,
      429,
    );
  } finally {
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
test("logout disconnects only its cookie session and sessions survive transport reconnect", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-")),
    f = fixture(),
    gateway = await startGateway({ dataDir, ...f, port: 0 });
  const url = gateway.status().url;
  let b: Awaited<ReturnType<typeof client>> | undefined;
  try {
    const aCookie = await login(url, await gateway.pairingSecret()),
      bCookie = await login(url, await gateway.pairingSecret());
    const a = await client(url, aCookie);
    b = await client(url, bCookie);
    const closing = once(a.ws, "close");
    assert.equal(
      (
        await fetch(url + "/api/logout", {
          method: "POST",
          headers: {
            origin: url,
            cookie: aCookie,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      200,
    );
    await closing;
    assert.equal((await b.rpc("snapshot")).result.projects.length, 2);
    const closingB = once(b.ws, "close");
    b.ws.close();
    await closingB;
    b = await client(url, bCookie);
    assert.equal((await b.rpc("snapshot")).result.sessions[0].id, "s");
  } finally {
    b?.ws.terminate();
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("HTTPS issues Secure owner cookies and accepts authenticated WSS", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-tls-")),
    f = fixture(),
    cert = path.join(dataDir, "cert.pem"),
    key = path.join(dataDir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const gateway = await startGateway({
      dataDir,
      ...f,
      port: 0,
      tls: { cert: fs.readFileSync(cert), key: fs.readFileSync(key) },
    }),
    url = gateway.status().url;
  let ws: WebSocket | undefined;
  try {
    const secret = await gateway.pairingSecret();
    const response = await new Promise<{ status: number; cookie: string }>(
      (resolve, reject) => {
        const request = https.request(
          url + "/api/login",
          {
            method: "POST",
            rejectUnauthorized: false,
            headers: { origin: url, "content-type": "application/json" },
          },
          (res) => {
            res.resume();
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                cookie: res.headers["set-cookie"]![0],
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify({ secret }));
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.cookie, /; Secure/);
    assert.match(response.cookie, /HttpOnly/);
    assert.match(response.cookie, /SameSite=Strict/);
    ws = new WebSocket(url.replace("https:", "wss:") + "/api/ws", {
      origin: url,
      rejectUnauthorized: false,
      headers: { cookie: response.cookie.split(";")[0] },
    });
    await once(ws, "open");
    assert.equal(gateway.status().clients, 1);
  } finally {
    ws?.terminate();
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("viewer mutations serialize and revocation discards queued commands before execution", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-race-")),
    f = fixture();
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  const invoke = async (command: any, payload: any = {}) => {
    if (command === "files.read") {
      started();
      await blocked;
    }
    return f.invoke(command, payload);
  };
  const gateway = await startGateway({ dataDir, ...f, invoke, port: 0 }),
    url = gateway.status().url;
  let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(url, await login(url, await gateway.pairingSecret()));
    const v = { sessionId: "s", generation: 1, viewerId: "one" };
    const replies = await Promise.all([
      c.rpc("session.attach", v),
      c.rpc("session.detach", v),
      c.rpc("session.attach", v),
    ]);
    assert.ok(replies.every((r) => r.result.ok));
    const attaches = f.calls.filter((c) => c.command === "session.attach");
    assert.notEqual(attaches[0].payload.viewerId, attaches[1].payload.viewerId);
    c.ws.send(
      JSON.stringify({
        type: "rpc",
        version: 1,
        id: "blocked",
        command: "files.read",
        payload: { projectId: "p", path: "file" },
      }),
    );
    await entered;
    c.ws.send(
      JSON.stringify({
        type: "rpc",
        version: 1,
        id: "queued",
        command: "note.create",
        payload: { projectId: "p", title: "must not execute" },
      }),
    );
    await wait();
    const closed = once(c.ws, "close");
    await gateway.revokeSessions();
    release();
    await closed;
    await gateway.stop();
    assert.equal(f.calls.filter((c) => c.command === "note.create").length, 0);
    assert.ok(
      f.calls.some(
        (call) =>
          call.command === "session.detach" &&
          call.payload.viewerId === attaches[1].payload.viewerId,
      ),
    );
  } finally {
    release();
    c?.ws.terminate();
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("pending login cannot reuse the pairing code across revoke or server stop", async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "aw-gateway-login-race-"),
  );
  const gateway = await startGateway({ dataDir, ...fixture(), port: 0 });
  const url = gateway.status().url;
  try {
    const oldSecret = await gateway.pairingSecret();
    let complete!: (status: number) => void;
    const result = new Promise<number>((resolve) => {
      complete = resolve;
    });
    const request = http.request(
      url + "/api/login",
      {
        method: "POST",
        headers: {
          origin: url,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => complete(response.statusCode!));
      },
    );
    request.write('{"secret":"');
    await wait();
    await gateway.revokeSessions();
    request.end(oldSecret + '"}');
    assert.equal(await result, 401);
    const pending = http.request(url + "/api/login", {
      method: "POST",
      headers: {
        origin: url,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    });
    const aborted = new Promise<void>((resolve) => {
      pending.on("error", () => resolve());
      pending.on("close", () => resolve());
    });
    pending.write('{"secret":"');
    await wait();
    await gateway.stop();
    await aborted;
    assert.equal(gateway.status().running, false);
  } finally {
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("RPC flood closes the socket and cancels bounded queued mutations", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-flood-"));
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = await startGateway({
    dataDir,
    ...f,
    port: 0,
    invoke: async (command, payload) => {
      if (command === "files.read") await blocked;
      return f.invoke(command, payload);
    },
  });
  let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    const url = gateway.status().url;
    c = await client(url, await login(url, await gateway.pairingSecret()));
    const closed = once(c.ws, "close");
    c.ws.send(
      JSON.stringify({
        type: "rpc",
        version: 1,
        id: "block",
        command: "files.read",
        payload: { projectId: "p", path: "fixture" },
      }),
    );
    for (let n = 0; n < 20; n++)
      c.ws.send(
        JSON.stringify({
          type: "rpc",
          version: 1,
          id: "flood-" + n,
          command: "note.create",
          payload: { projectId: "p", title: "discard" },
        }),
      );
    await closed;
    release();
    await gateway.stop();
    assert.equal(f.calls.filter((c) => c.command === "note.create").length, 0);
  } finally {
    release();
    c?.ws.terminate();
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("expiry while an RPC is queued prevents the pending mutation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-expiry-")),
    f = fixture();
  let release!: () => void,
    started!: () => void,
    block = false;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  const gateway = await startGateway({
    dataDir,
    ...f,
    port: 0,
    invoke: async (command, payload) => {
      if (command === "git.status" && block) {
        started();
        await blocked;
      }
      return f.invoke(command, payload);
    },
  });
  const realNow = Date.now;
  let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    const url = gateway.status().url;
    c = await client(url, await login(url, await gateway.pairingSecret()));
    block = true;
    c.ws.send(
      JSON.stringify({
        type: "rpc",
        version: 1,
        id: "blocker",
        command: "git.status",
        payload: { projectId: "p" },
      }),
    );
    await entered;
    c.ws.send(
      JSON.stringify({
        type: "rpc",
        version: 1,
        id: "expiry",
        command: "note.create",
        payload: { projectId: "p", title: "expired mutation" },
      }),
    );
    const afterExpiry = realNow() + 12 * 60 * 60 * 1000 + 1000;
    Date.now = () => afterExpiry;
    const closed = once(c.ws, "close");
    release();
    await closed;
    assert.equal(
      f.calls.filter((call) => call.command === "note.create").length,
      0,
    );
  } finally {
    Date.now = realNow;
    release();
    c?.ws.terminate();
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("explicit IPv6 loopback HTTP origin is accepted", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-ipv6-"));
  const gateway = await startGateway({
    dataDir,
    ...fixture(),
    port: 0,
    publicOrigin: "http://[::1]:8787",
  });
  try {
    assert.equal(gateway.status().url, "http://[::1]:8787");
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(
          `http://127.0.0.1:${gateway.status().port}/api/status`,
          { headers: { host: "[::1]:8787" } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        )
        .on("error", reject);
    });
    assert.equal(status, 200);
  } finally {
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("independent gateways on one hostname keep separate browser cookie sessions", async () => {
  const dirs = [0, 1].map(() =>
    fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-cookie-")),
  );
  let a = await startGateway({ dataDir: dirs[0], ...fixture(), port: 0 });
  const b = await startGateway({ dataDir: dirs[1], ...fixture(), port: 0 });
  const browserCookies = new Map<string, string>();
  try {
    for (const gateway of [a, b]) {
      const cookie = await login(
        gateway.status().url,
        await gateway.pairingSecret(),
      );
      browserCookies.set(cookie.slice(0, cookie.indexOf("=")), cookie);
    }
    const cookie = [...browserCookies.values()].join("; ");
    for (const gateway of [a, b]) {
      const status = await fetch(gateway.status().url + "/api/status", {
        headers: { cookie },
      });
      assert.equal(((await status.json()) as any).authenticated, true);
    }
    assert.equal(browserCookies.size, 2);
    const originalUrl = a.status().url,
      originalPort = a.status().port;
    const originalCookie = await login(originalUrl, await a.pairingSecret());
    await a.stop();
    a = await startGateway({
      dataDir: dirs[0],
      ...fixture(),
      port: originalPort,
    });
    const restartedCookie = await login(
      a.status().url,
      await a.pairingSecret(),
    );
    assert.equal(restartedCookie.split("=")[0], originalCookie.split("=")[0]);
  } finally {
    await a.stop();
    await b.stop();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SSH hosts and SSH folders never reach a paired browser", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gateway-")),
    f = fixture();
  f.snapshot.projects.push({
    id: "ssh-0a1b2c3d-r1",
    name: "remote",
    path: "/srv/remote",
    createdAt: "",
    hostId: "0a1b2c3d",
  });
  f.snapshot.hosts = [
    {
      id: "0a1b2c3d",
      alias: "box",
      label: "box",
      helperPath: "~/aw",
      state: "connected",
      tools: [],
    },
  ];
  // Even a misconfigured allow list containing the SSH folder does not share it.
  const gateway = await startGateway({
    dataDir,
    ...f,
    port: 0,
    allowedProjectIds: ["p", "ssh-0a1b2c3d-r1"],
  });
  const url = gateway.status().url;
  let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(url, await login(url, await gateway.pairingSecret()));
    const snapshot = (await c.rpc("snapshot")).result;
    assert.equal(snapshot.hosts, undefined);
    assert.deepEqual(
      snapshot.projects.map((p: any) => p.id),
      ["p"],
    );
    f.emit({ type: "snapshot", snapshot: f.snapshot });
    await wait(50);
    const pushed = c.messages
      .filter((m) => m.type === "event" && m.event.type === "snapshot")
      .at(-1);
    assert.ok(pushed);
    assert.equal(pushed.event.snapshot.hosts, undefined);
    assert.ok(!pushed.event.snapshot.projects.some((p: any) => p.hostId));
  } finally {
    c?.ws.terminate();
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("gateway pushes scoped record deltas and authorizes lazy note reads without refreshing the whole store", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-delta-gateway-"));
  const f = fixture();
  const gateway = await startGateway({
    dataDir,
    ...f,
    port: 0,
    allowedProjectIds: ["p"],
  });
  let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    const url = gateway.status().url;
    c = await client(url, await login(url, await gateway.pairingSecret()));
    const initialReads = f.calls.filter(
      (call) => call.command === "snapshot",
    ).length;
    const note = {
      id: "n",
      projectId: "p",
      title: "lazy",
      body: "",
      bodyLoaded: false,
      revision: 1,
      createdAt: "",
      updatedAt: "",
    };
    const hidden = {
      ...note,
      id: "secret",
      projectId: "hidden",
      title: "private title",
    };
    f.emit({
      type: "workspace.delta",
      epoch: "core",
      sequence: 1,
      changes: { notes: { upsert: [note, hidden], remove: [] } },
    });
    for (
      let i = 0;
      i < 100 && !c.messages.some((m) => m.event?.type === "workspace.delta");
      i++
    )
      await wait(5);
    const delta = c.messages.find(
      (m) => m.event?.type === "workspace.delta",
    ).event;
    assert.equal(delta.changes.notes.upsert.length, 1);
    assert.equal(delta.changes.notes.upsert[0].bodyLoaded, false);
    assert.equal(JSON.stringify(delta).includes("private title"), false);
    assert.equal((await c.rpc("note.read", { noteId: "n" })).error, undefined);
    assert.match(
      (await c.rpc("note.read", { noteId: "secret" })).error,
      /access denied/,
    );
    assert.equal(
      f.calls.filter((call) => call.command === "snapshot").length,
      initialReads,
    );
    f.emit({
      type: "workspace.delta",
      epoch: "core",
      sequence: 2,
      changes: { notes: { upsert: [], remove: ["n"] } },
    });
    assert.match(
      (await c.rpc("note.read", { noteId: "n" })).error,
      /access denied/,
    );
    for (const command of [
      "note.delete",
      "task.delete",
      "worktree.remove",
      "history.prune",
      "backup.export",
    ])
      assert.match((await c.rpc(command, {})).error, /not available remotely/);
  } finally {
    c?.ws.terminate();
    await gateway.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("one-time pairing links sign in once, ride only in the fragment, and die on revoke", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-pairlink-")),
    f = fixture();
  const gateway = await startGateway({ dataDir, ...f, port: 0 });
  const url = gateway.status().url;
  const attempt = (secret: string) =>
    fetch(url + "/api/login", {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    }).then((r) => r.status);
  try {
    const link = await gateway.pairingLink();
    const parsed = new URL(link.url);
    assert.equal(parsed.origin, url);
    assert.equal(parsed.search, "");
    const code = new URLSearchParams(parsed.hash.slice(1)).get("pair")!;
    assert.ok(code.length >= 43);
    assert.ok(link.expiresAt > Date.now() + 9 * 60 * 1000);
    assert.equal(
      await attempt(code + " "),
      200,
      "pasted whitespace is trimmed",
    );
    assert.equal(
      gateway.pairingLinkPending(link.id),
      false,
      "spent links report it",
    );
    assert.equal(await attempt(code), 401, "a one-time code works only once");
    assert.equal(
      await attempt("é".repeat((await gateway.pairingSecret()).length)),
      401,
      "non-ASCII input of the same length is rejected, not an error",
    );
    const spare = new URLSearchParams(
      new URL((await gateway.pairingLink()).url).hash.slice(1),
    ).get("pair")!;
    await gateway.revokeSessions();
    assert.equal(await attempt(spare), 401, "revoke ends unused links too");
    assert.equal(await attempt(await gateway.pairingSecret()), 200);
  } finally {
    await gateway.stop();
  }
});
