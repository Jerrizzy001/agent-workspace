import { workspaceSocket } from "../src/core/socket.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createCore, sessionTitleText } from "../src/core/index.js";
import { validateCommand } from "../src/server/validation.js";
import { COMMANDS } from "../src/shared/contracts.js";
import { COMMAND_POLICY } from "../src/shared/command-policy.js";

const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";

test("session titles are plain single-line text of at most 80 characters", () => {
  assert.equal(sessionTitleText("  Fix\tlogin\nflow \u001b[31m "), "Fix login flow [31m");
  assert.equal(sessionTitleText("a‮bc​"), "a bc");
  assert.equal(sessionTitleText("   "), "");
  assert.equal(sessionTitleText("é".repeat(80)), "é".repeat(80));
  assert.throws(() => sessionTitleText("x".repeat(81)), /80 characters/);
  assert.throws(() => sessionTitleText(5), /Invalid session title/);
});

test("rename is revision-checked, generation-bound and persists", async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workspace-rename-")));
  const dataDir = path.join(temp, "data");
  process.env.SHELL = "/bin/sh";
  let core = await createCore({ dataDir, emit: () => {} });
  try {
    const project: any = await core.invoke("project.add", { path: temp });
    const { session }: any = await core.invoke("terminal.open", {
      projectId: project.id,
      provider: "shell",
      idempotencyKey: "rename",
    });
    const rename = (payload: Record<string, unknown>) =>
      core.invoke("session.rename", { sessionId: session.id, generation: 1, ...payload }) as Promise<any>;
    const named = await rename({ title: " Build\nfixer ", titleRevision: 0 });
    assert.equal(named.title, "Build fixer");
    assert.equal(named.titleRevision, 1);
    await assert.rejects(rename({ title: "Other", titleRevision: 0 }), /Stale session title/);
    await assert.rejects(rename({ title: "Other" }), /Stale session title/);
    await assert.rejects(rename({ title: "Other", titleRevision: 1, generation: 2 }), /Stale session generation/);
    await assert.rejects(
      core.invoke("session.rename", { sessionId: session.id, title: "x", titleRevision: 1 }),
      /generation required/,
    );
    await assert.rejects(rename({ title: "y".repeat(81), titleRevision: 1 }), /80 characters/);
    const snapshot: any = await core.invoke("snapshot");
    assert.equal(snapshot.sessions[0].title, "Build fixer");
    assert.equal(snapshot.sessions[0].status, "running");
    await core.close();
    core = await createCore({ dataDir, emit: () => {} });
    const reopened: any = await core.invoke("snapshot");
    assert.equal(reopened.sessions[0].title, "Build fixer");
    const cleared = await rename({ title: "", titleRevision: 1 });
    assert.equal(cleared.title, undefined);
    assert.equal(cleared.titleRevision, 2);
    assert.equal(cleared.generation, 1);
  } finally {
    await core.close();
    try {
      execFileSync(
        tmux,
        [
          "-S",
          workspaceSocket(dataDir),
          "kill-server",
        ],
        { stdio: "ignore" },
      );
    } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("gateway validation allows exactly the remote commands", () => {
  assert.deepEqual(Object.keys(COMMAND_POLICY).sort(), [...COMMANDS].sort());
  for (const command of COMMANDS) {
    let message = "";
    try {
      validateCommand(command, {});
    } catch (error: any) {
      message = error.message;
    }
    if (COMMAND_POLICY[command] === "owner")
      assert.equal(message, "Command is not available remotely", command);
    else assert.notEqual(message, "Command is not available remotely", command);
  }
  assert.equal(COMMAND_POLICY["project.add"], "owner");
  assert.equal(COMMAND_POLICY["project.hide"], "owner");
  assert.equal(COMMAND_POLICY["session.rename"], "remote");
});

test("remote rename needs identity, generation and revision and takes no other field", () => {
  const ok = { sessionId: "s", generation: 1, title: "Name", titleRevision: 0 };
  assert.deepEqual(validateCommand("session.rename", ok).payload, ok);
  assert.throws(() => validateCommand("session.rename", { ...ok, viewerId: "v" }), /Unexpected command field/);
  assert.throws(() => validateCommand("session.rename", { ...ok, generation: undefined }), /generation required/);
  assert.throws(() => validateCommand("session.rename", { sessionId: "s", generation: 1, title: "x" }), /Missing titleRevision/);
  assert.throws(() => validateCommand("session.rename", { ...ok, titleRevision: -1 }), /Invalid titleRevision/);
  assert.throws(() => validateCommand("session.rename", { ...ok, title: 5 }), /Invalid title/);
});
