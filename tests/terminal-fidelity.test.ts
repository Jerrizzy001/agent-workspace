import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import xterm from "@xterm/xterm";
const { Terminal } = xterm;
import { createCore } from "../src/core/index.js";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
test("live tmux burst preserves exact ordered final rows in the xterm parser", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-fidelity-"));
  const terminal = new Terminal({ cols: 100, rows: 30, scrollback: 5000 });
  let core: Awaited<ReturnType<typeof createCore>>;
  const errors: unknown[] = [];
  let writes = 0;
  let resyncs = 0;
  let session: any;
  const viewerId = "fidelity";
  core = await createCore({
    dataDir: temp,
    emit: (event) => {
      if (event.type === "terminal.data" && event.viewerId === viewerId) {
        writes++;
        terminal.write(event.data, () => {
          writes--;
          void core
            .invoke("session.ack", {
              sessionId: event.sessionId,
              viewerId,
              sequence: event.sequence,
            })
            .catch((e) => errors.push(e));
        });
      }
      if (event.type === "terminal.resync" && event.viewerId === viewerId)
        resyncs++;
    },
  });
  try {
    const project: any = await core.invoke("project.add", { path: temp });
    const task: any = await core.invoke("task.create", {
      projectId: project.id,
      title: "Fidelity fixture",
    });
    const launch: any = await core.invoke("attempt.start", {
      taskId: task.id,
      provider: "shell",
      idempotencyKey: "fidelity",
    });
    session = launch.session;
    const identity = { sessionId: session.id, generation: 1, viewerId };
    await core.invoke("session.attach", { ...identity, cols: 100, rows: 30 });
    await core.invoke("session.input", {
      ...identity,
      data:
        quote(process.execPath) +
        " -e " +
        quote(
          'for(let i=0;i<10000;i++)console.log("line"+String(i).padStart(5,"0"));console.log("BURST_END")',
        ) +
        "\r",
    });
    let capture = "";
    for (let retry = 0; retry < 200; retry++) {
      capture = (
        (await core.invoke("session.capture", { sessionId: session.id })) as any
      ).data;
      if (
        capture.includes("line09999") &&
        capture.includes("BURST_END") &&
        Array.from(
          { length: terminal.buffer.active.length },
          (_, i) =>
            terminal.buffer.active.getLine(i)?.translateToString(true) || "",
        ).some((line) => line === "line09999") &&
        writes === 0
      )
        break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise<void>((resolve) => terminal.write("", resolve));
    const rendered = Array.from(
      { length: terminal.buffer.active.length },
      (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true) || "",
    ).filter((line) => /^line\d{5}$/.test(line));
    const expected = capture
      .split("\n")
      .filter((line) => /^line\d{5}$/.test(line));
    assert.equal(resyncs, 0);
    assert.equal(errors.length, 0);
    assert.ok(expected.length >= 20);
    assert.deepEqual(rendered.slice(-20), expected.slice(-20));
    assert.deepEqual(
      rendered.slice(-20),
      Array.from(
        { length: 20 },
        (_, i) => "line" + String(9980 + i).padStart(5, "0"),
      ),
    );
    await core.invoke("session.terminate", identity);
  } finally {
    await core.close();
    terminal.dispose();
    if (session?.backendSocket)
      try {
        execFileSync(
          "/opt/homebrew/bin/tmux",
          ["-S", session.backendSocket, "kill-server"],
          { stdio: "ignore" },
        );
      } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
