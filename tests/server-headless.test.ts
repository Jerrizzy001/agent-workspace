import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import { runHeadless } from "../src/server/headless.js";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("headless core survives browser disconnect and host restart with same backend", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-headless-")),
    repo = path.join(temp, "repo"),
    dataDir = path.join(temp, "data");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  let host = await runHeadless([
    "--data-dir",
    dataDir,
    "--port",
    "0",
    "--project",
    repo,
  ]);
  assert.ok(host);
  let ws: WebSocket | undefined;
  let sid = "",
    generation = 0;
  try {
    const project = ((await host.core.invoke("snapshot")) as any).projects[0];
    const task = (await host.core.invoke("task.create", {
      projectId: project.id,
      title: "Remote lifecycle fixture",
    })) as any;
    const originalShell = process.env.SHELL;
    delete process.env.SHELL;
    let result: any;
    try {
      result = await host.core.invoke("attempt.start", {
        taskId: task.id,
        provider: "shell",
        idempotencyKey: "fixture-launch",
      });
    } finally {
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
    }
    sid = result.session.id;
    generation = result.session.generation;
    async function connect() {
      const url = host!.gateway.status().url;
      const login = await fetch(url + "/api/login", {
        method: "POST",
        headers: { origin: url, "content-type": "application/json" },
        body: JSON.stringify({ secret: await host!.gateway.pairingSecret() }),
      });
      assert.equal(login.status, 200);
      const socket = new WebSocket(url.replace("http", "ws") + "/api/ws", {
        origin: url,
        headers: { cookie: login.headers.get("set-cookie")!.split(";")[0] },
      });
      const responses = new Map<string, any>();
      socket.on("message", (bytes) => {
        const m = JSON.parse(bytes.toString());
        if (m.type === "result") responses.set(m.id, m);
      });
      await once(socket, "open");
      let seq = 0;
      return {
        socket,
        async rpc(command: string, payload: any = {}) {
          const id = String(++seq);
          socket.send(
            JSON.stringify({ type: "rpc", version: 1, id, command, payload }),
          );
          for (let n = 0; n < 300; n++) {
            if (responses.has(id)) {
              const r = responses.get(id);
              if (r.error) throw new Error(r.error);
              return r.result;
            }
            await delay(10);
          }
          throw new Error("RPC timeout");
        },
      };
    }
    let client = await connect();
    ws = client.socket;
    await client.rpc("session.attach", {
      sessionId: sid,
      generation,
      viewerId: "phone",
      cols: 80,
      rows: 24,
    });
    await client.rpc("session.input", {
      sessionId: sid,
      generation,
      viewerId: "phone",
      data: 'printf "REMOTE_LIFECYCLE_PID=%s\\n" "$$"\r',
    });
    let captured = "";
    for (let n = 0; n < 50; n++) {
      captured = (
        await client.rpc("session.capture", { sessionId: sid, generation })
      ).data;
      if (/REMOTE_LIFECYCLE_PID=\d+/.test(captured)) break;
      await delay(25);
    }
    assert.match(captured, /REMOTE_LIFECYCLE_PID=\d+/);
    const pid = captured.match(/REMOTE_LIFECYCLE_PID=(\d+)/)![1];
    ws.close();
    await once(ws, "close");
    await delay(50);
    assert.equal(
      ((await host.core.invoke("snapshot")) as any).sessions[0].status,
      "running",
    );
    await host.stop();
    host = await runHeadless(["--data-dir", dataDir, "--port", "0"]);
    assert.ok(host);
    client = await connect();
    ws = client.socket;
    const snapshot = await client.rpc("snapshot");
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.attempts.length, 1);
    assert.equal(snapshot.sessions[0].id, sid);
    assert.equal(snapshot.sessions[0].generation, generation);
    assert.equal(snapshot.sessions[0].status, "running");
    await client.rpc("session.attach", {
      sessionId: sid,
      generation,
      viewerId: "phone",
    });
    await client.rpc("session.input", {
      sessionId: sid,
      generation,
      viewerId: "phone",
      data: 'printf "AFTER_RESTART_PID=%s\\n" "$$"\r',
    });
    for (let n = 0; n < 50; n++) {
      captured = (
        await client.rpc("session.capture", { sessionId: sid, generation })
      ).data;
      if (captured.includes("AFTER_RESTART_PID=" + pid)) break;
      await delay(25);
    }
    assert.ok(captured.includes("AFTER_RESTART_PID=" + pid));
    await client.rpc("session.terminate", {
      sessionId: sid,
      generation,
      viewerId: "phone",
    });
    sid = "";
  } finally {
    ws?.terminate();
    if (sid) {
      try {
        await host!.core.invoke("session.attach", {
          sessionId: sid,
          generation,
          viewerId: "cleanup",
        });
        await host!.core.invoke("session.terminate", {
          sessionId: sid,
          generation,
          viewerId: "cleanup",
        });
      } catch {}
    }
    await host!.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
