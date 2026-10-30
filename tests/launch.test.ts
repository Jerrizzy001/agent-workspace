import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createCore } from "../src/core/index.js";

const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean) {
  let value = await read();
  for (let retry = 0; retry < 120 && !ok(value); retry++) {
    await wait(50);
    value = await read();
  }
  return value;
}
/** A fixture CLI: records argv, can run one of the hook commands it was given, then waits or exits. */
function fixtureCli(file: string, received: string, behaviour: string) {
  fs.writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  process.stdout.write("Usage: fixture [options]\\n  --session-id <uuid>\\n  --settings <file-or-json>\\n");
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
${behaviour}
`,
    { mode: 0o700 },
  );
}
function socketFor(dataDir: string) {
  return path.join(
    os.tmpdir(),
    "aw-" +
      crypto
        .createHash("sha256")
        .update(fs.realpathSync(dataDir))
        .digest("hex")
        .slice(0, 20) +
      ".sock",
  );
}

test("folder launch opens providers interactively in the chosen folder without a task", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-launch-"));
  const bin = path.join(temp, "bin");
  const repo = path.join(temp, "repo");
  const other = path.join(temp, "other");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(repo, "src", "lib"), { recursive: true });
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  const received = path.join(temp, "received.jsonl");
  // Simulates Claude's Notification hook firing, then stays open like the real TUI.
  fixtureCli(
    path.join(bin, "claude"),
    received,
    `const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
execSync(settings.hooks.Notification[0].hooks[0].command, { stdio: "ignore" });
setInterval(() => {}, 1000);`,
  );
  // A CLI that fails before its interface appears.
  fixtureCli(
    path.join(bin, "codex"),
    received,
    `process.stderr.write("fixture codex: not signed in\\n");
process.exit(3);`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  const dataDir = path.join(temp, "data");
  const core = await createCore({ dataDir, emit: () => {} });
  const call = (c: any, p: any = {}) => core.invoke(c, p) as Promise<any>;
  const lines = () =>
    fs.existsSync(received)
      ? fs
          .readFileSync(received, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  try {
    const project = await call("project.add", { path: repo });
    const second = await call("project.add", { path: other });
    const snapshot = await call("snapshot");
    assert.equal(
      snapshot.capabilities.find((c: any) => c.name === "claude").available,
      true,
    );

    // A blank interactive launch: no task, no attempt, no prompt argument.
    const claude = await call("terminal.open", {
      projectId: project.id,
      provider: "claude",
      path: "src/lib",
      idempotencyKey: "claude-blank",
    });
    assert.equal(claude.attempt, undefined);
    assert.equal(claude.session.attemptId, null);
    assert.equal(claude.session.cwd, fs.realpathSync(path.join(repo, "src", "lib")));
    assert.equal(claude.session.activityTracking, true);
    const conversation = claude.session.conversationId;
    assert.match(conversation, /^[0-9a-f-]{36}$/);
    const first = (await until(async () => lines(), (l) => l.length >= 1))[0];
    assert.equal(first.cwd, fs.realpathSync(path.join(repo, "src", "lib")));
    assert.equal(first.args.includes("--"), false);
    assert.deepEqual(first.args.slice(0, 2), ["--session-id", conversation]);
    assert.equal(first.args[2], "--settings");
    assert.equal((await call("snapshot")).attempts.length, 0);

    // The hook command reaches the pane and surfaces as "needs you".
    const needs = await until(
      async () =>
        (await call("snapshot")).sessions.find(
          (s: any) => s.id === claude.session.id,
        ),
      (s) => s.activity === "needs",
    );
    assert.equal(needs.activity, "needs");
    assert.equal(needs.status, "running");

    // Retrying the same click returns the same session; it never launches twice.
    const retried = await call("terminal.open", {
      projectId: project.id,
      provider: "claude",
      path: "src/lib",
      idempotencyKey: "claude-blank",
    });
    assert.equal(retried.session.id, claude.session.id);
    assert.equal(lines().length, 1);

    // A supplied instruction is passed once, literally, after "--".
    const prompted = await call("terminal.open", {
      projectId: second.id,
      provider: "claude",
      prompt: "Explain $(whoami)",
      model: "fixture-model",
      idempotencyKey: "claude-prompt",
    });
    const third = (await until(async () => lines(), (l) => l.length >= 2))[1];
    assert.equal(third.cwd, fs.realpathSync(other));
    assert.deepEqual(third.args.slice(0, 2), ["--model", "fixture-model"]);
    assert.deepEqual(third.args.slice(-2), ["--", "Explain $(whoami)"]);
    assert.equal(prompted.session.model, "fixture-model");
    assert.notEqual(prompted.session.cwd, claude.session.cwd);

    // A CLI that exits at startup reports exited with its saved output, not a tmux error.
    const codex = await call("terminal.open", {
      projectId: project.id,
      provider: "codex",
      idempotencyKey: "codex-fast-exit",
    });
    const ended = await until(
      async () =>
        (await call("snapshot")).sessions.find(
          (s: any) => s.id === codex.session.id,
        ),
      (s) => s.status === "exited",
    );
    assert.equal(ended.status, "exited");
    assert.equal(ended.exitCode, 3);
    assert.equal(ended.transcript, true);
    const output = await call("session.capture", {
      sessionId: codex.session.id,
      generation: 1,
    });
    assert.match(output.data, /fixture codex: not signed in/);
    assert.equal(output.saved, true);

    // Folder and path validation produce recoverable messages.
    await assert.rejects(
      call("terminal.open", {
        projectId: project.id,
        provider: "shell",
        path: "../other",
        idempotencyKey: "escape",
      }),
      /escapes/,
    );
    await assert.rejects(
      call("terminal.open", {
        projectId: project.id,
        provider: "shell",
        path: "README.md",
        idempotencyKey: "file",
      }),
      /not a file/,
    );
    await assert.rejects(
      call("terminal.open", {
        projectId: project.id,
        provider: "shell",
        path: "missing",
        idempotencyKey: "missing",
      }),
      /no longer exists/,
    );
    process.env.PATH = oldPath;
    await assert.rejects(
      call("terminal.open", {
        projectId: project.id,
        provider: "codex",
        idempotencyKey: "uninstalled",
      }),
      /not installed/,
    );
    process.env.PATH = bin + path.delimiter + oldPath;

    // Resume reuses the Claude conversation ID only after its process ended.
    await assert.rejects(
      call("terminal.open", {
        projectId: project.id,
        provider: "claude",
        resumeSessionId: claude.session.id,
        idempotencyKey: "resume-open",
      }),
      /still open/,
    );
    await call("session.attach", {
      sessionId: claude.session.id,
      generation: 1,
      viewerId: "fixture",
    });
    await call("session.terminate", {
      sessionId: claude.session.id,
      generation: 1,
      viewerId: "fixture",
    });
    const resumed = await call("terminal.open", {
      projectId: project.id,
      provider: "claude",
      resumeSessionId: claude.session.id,
      idempotencyKey: "resume",
    });
    const fourth = (await until(async () => lines(), (l) => l.length >= 4))[3];
    assert.deepEqual(fourth.args.slice(0, 2), ["--resume", conversation]);
    assert.equal(resumed.session.conversationId, conversation);
    assert.equal(resumed.session.resumedFrom, claude.session.id);
    assert.equal(fourth.cwd, claude.session.cwd);

    // Removing a folder from the list keeps its history and is refused while it runs.
    await assert.rejects(
      call("project.hide", { projectId: project.id }),
      /running sessions/,
    );
    await call("session.attach", {
      sessionId: resumed.session.id,
      generation: 1,
      viewerId: "fixture",
    });
    await call("session.terminate", {
      sessionId: resumed.session.id,
      generation: 1,
      viewerId: "fixture",
    });
    assert.equal((await call("project.hide", { projectId: project.id })).hidden, true);
    const again = await call("project.add", { path: repo });
    assert.equal(again.id, project.id);
    assert.equal(again.hidden, undefined);
  } finally {
    process.env.PATH = oldPath;
    await core.close();
    try {
      execFileSync(tmux, ["-S", socketFor(dataDir), "kill-server"], {
        stdio: "ignore",
      });
    } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
