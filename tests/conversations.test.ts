import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmux, until, workspace } from "./claude-fixture.js";
import { validateCommand } from "../src/server/validation.js";
import { COMMAND_POLICY } from "../src/shared/command-policy.js";
import { launchArguments } from "../src/core/providers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("branch argv is exactly --resume <id> --fork-session, composed with model and settings", () => {
  const id = "0b9d6a4e-55f3-4c0e-9d2a-1f2e3d4c5b6a";
  assert.deepEqual(launchArguments("claude", { conversation: { id, resume: true, fork: true } }), ["--resume", id, "--fork-session"]);
  assert.deepEqual(
    launchArguments("claude", { model: "m1", conversation: { id, resume: true, fork: true }, settings: "{}" }),
    ["--model", "m1", "--resume", id, "--fork-session", "--settings", "{}"],
  );
  assert.throws(() => launchArguments("claude", { conversation: { id: "--help", resume: true, fork: true } }), /Invalid conversation ID/);
  assert.equal(COMMAND_POLICY["conversation.fork"], "owner");
  assert.throws(() => validateCommand("conversation.fork", { sessionId: "x", generation: 1 }), /not available remotely/);
});

test("conversation branches: idle parent only, child ID from SessionStart, lineage, retries and unknown outcomes", async () => {
  const w = await workspace("workspace-branch-");
  try {
    const { profiles }: any = await w.core.profiles("create", { label: "Work" });
    const work = profiles[0];
    const parent = (
      await w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        profileId: work.id,
        model: "fixture-model",
        prompt: "plan the feature",
        idempotencyKey: "parent",
      })
    ).session;
    w.setSocket(parent.backendSocket);
    const parentPid = w.pane(parent, "#{pane_pid}");
    await until(() => w.sessionOf(parent.id), (s) => s.activity === "done");
    const identity = { sessionId: parent.id, generation: 1 };
    // The fork usually returns with the child's ID; on a loaded machine the report can come later.
    const settled = (id: string) => until(() => w.sessionOf(id), (s) => s.conversationState !== "pending");

    // Not while Claude is working or waiting for an answer.
    for (const state of ["running", "needs"]) {
      execFileSync(tmux, ["-S", parent.backendSocket, "set-option", "-p", "-t", "=" + parent.backendName + ":", "@aw_activity", state]);
      execFileSync(tmux, ["-S", parent.backendSocket, "set-option", "-p", "-t", "=" + parent.backendName + ":", "@aw_activity_at", String(Math.floor(Date.now() / 1000))]);
      await until(() => w.sessionOf(parent.id), (s) => s.activity === state);
      await assert.rejects(w.call("conversation.fork", { ...identity, idempotencyKey: "busy-" + state }), /finished its turn/);
    }
    execFileSync(tmux, ["-S", parent.backendSocket, "set-option", "-p", "-t", "=" + parent.backendName + ":", "@aw_activity", "done"]);
    await until(() => w.sessionOf(parent.id), (s) => s.activity === "done");
    await assert.rejects(w.call("conversation.fork", { ...identity, generation: 2, idempotencyKey: "stale" }), /Stale session generation/);
    await assert.rejects(w.call("conversation.fork", { ...identity, idempotencyKey: "x", profileId: work.id }), /Unexpected field/);
    const shell = (await w.call("terminal.open", { projectId: w.project.id, provider: "shell", idempotencyKey: "shell" })).session;
    await assert.rejects(w.call("conversation.fork", { sessionId: shell.id, generation: 1, idempotencyKey: "shell-fork" }), /Only Claude/);

    // Branch: a new session beside the parent, same profile, folder and model.
    const before = w.starts().length;
    const child = await settled((await w.call("conversation.fork", { ...identity, idempotencyKey: "branch-1" })).session.id);
    assert.notEqual(child.id, parent.id);
    assert.equal(child.generation, 1);
    assert.equal(child.profileId, work.id);
    assert.equal(child.cwd, parent.cwd);
    assert.equal(child.model, "fixture-model");
    assert.deepEqual(child.forkedFrom, { sessionId: parent.id, generation: 1, conversationId: parent.conversationId });
    assert.equal(child.conversationState, "known");
    assert.match(child.conversationId, UUID);
    assert.notEqual(child.conversationId, parent.conversationId);
    // The exact argv: no --session-id, no prompt.
    const start = (await until(() => w.starts(), (s) => s.length > before)).at(-1);
    assert.deepEqual(start.args.slice(0, 5), ["--model", "fixture-model", "--resume", parent.conversationId, "--fork-session"]);
    assert.equal(start.args[5], "--settings");
    assert.equal(start.args.length, 7);
    assert.equal(start.args.includes("--session-id"), false);
    assert.equal(start.env.CLAUDE_CONFIG_DIR, work.location);
    // The ID the CLI chose is the one its transcript is named after.
    const branchFile = fs
      .readdirSync(path.join(work.location, "projects"))
      .map((d) => path.join(work.location, "projects", d, child.conversationId + ".jsonl"))
      .find((f) => fs.existsSync(f));
    assert.ok(branchFile, "the branch transcript exists under the profile");
    // The parent is untouched.
    const parentNow = await w.sessionOf(parent.id);
    assert.equal(parentNow.status, "running");
    assert.equal(parentNow.conversationId, parent.conversationId);
    assert.equal(w.pane(parent, "#{pane_pid}"), parentPid);

    // Idempotent retry returns the same child; a different request under the key is refused.
    assert.equal((await w.call("conversation.fork", { ...identity, idempotencyKey: "branch-1" })).session.id, child.id);
    await assert.rejects(w.call("conversation.fork", { sessionId: child.id, generation: 1, idempotencyKey: "branch-1" }), /reused/);

    // Two branches of one source at once: two separate children.
    const [c2, c3] = (
      await Promise.all([
        w.call("conversation.fork", { ...identity, idempotencyKey: "branch-2" }),
        w.call("conversation.fork", { ...identity, idempotencyKey: "branch-3" }),
      ])
    ).map((r) => r.session);
    Object.assign(c2, await settled(c2.id));
    Object.assign(c3, await settled(c3.id));
    assert.equal(new Set([child.id, c2.id, c3.id]).size, 3);
    assert.equal(new Set([parent.conversationId, child.conversationId, c2.conversationId, c3.conversationId]).size, 4);
    assert.equal(w.pane(parent, "#{pane_pid}"), parentPid);

    // A branch of a branch, and a branch after the source has ended.
    const grandchild = await settled((await w.call("conversation.fork", { sessionId: c2.id, generation: 1, idempotencyKey: "branch-of-branch" })).session.id);
    assert.equal(grandchild.forkedFrom.conversationId, c2.conversationId);
    w.type(c3, "/exit");
    await until(() => w.sessionOf(c3.id), (s) => s.status === "exited");
    const afterEnd = await settled((await w.call("conversation.fork", { sessionId: c3.id, generation: 1, idempotencyKey: "after-end" })).session.id);
    assert.equal(afterEnd.conversationState, "known");
    // Resuming an ended branch continues the branch's own conversation.
    const resumed = (await w.call("terminal.open", { projectId: w.project.id, provider: "claude", resumeSessionId: c3.id, idempotencyKey: "resume-branch" })).session;
    assert.equal(resumed.conversationId, c3.conversationId);
    assert.equal(resumed.profileId, work.id);

    // The CLI fails before reporting: unknown, never a guessed ID, and nothing to resume.
    w.setMode("exit-before-report");
    const forked = (await w.call("conversation.fork", { ...identity, idempotencyKey: "fails" })).session;
    // On a loaded machine the CLI may still be starting when the fork returns.
    assert.notEqual(forked.conversationState, "known");
    const failed = await until(() => w.sessionOf(forked.id), (s) => s.status === "exited" && s.conversationState !== "pending");
    assert.equal(failed.conversationState, "unknown");
    assert.equal(failed.conversationId, undefined);
    await assert.rejects(
      w.call("terminal.open", { projectId: w.project.id, provider: "claude", resumeSessionId: failed.id, idempotencyKey: "resume-failed" }),
      /no saved conversation/,
    );
    await assert.rejects(w.call("conversation.fork", { sessionId: failed.id, generation: 1, idempotencyKey: "fork-unknown" }), /no known Claude conversation/);
    // The CLI reports the original conversation instead of a new one: unknown.
    w.setMode("report-original");
    const sameFork = (await w.call("conversation.fork", { ...identity, idempotencyKey: "same-id" })).session;
    const same = await until(() => w.sessionOf(sameFork.id), (s) => s.conversationState !== "pending");
    assert.equal(same.conversationState, "unknown");
    assert.equal(same.conversationId, undefined);
    // No report while running: pending; it becomes unknown when the process ends.
    w.setMode("no-report");
    const silent = (await w.call("conversation.fork", { ...identity, idempotencyKey: "silent" })).session;
    assert.equal(silent.conversationState, "pending");
    assert.equal(silent.status, "running");
    w.type(silent, "/exit");
    const silentEnd = await until(() => w.sessionOf(silent.id), (s) => s.status === "exited");
    assert.equal(silentEnd.conversationState, "unknown");
    w.setMode("normal");
    assert.equal(w.pane(parent, "#{pane_pid}"), parentPid);

    // An installed CLI that does not list --fork-session: fail closed, nothing started.
    process.env.CLAUDE_FIXTURE_NO_FORK = "1";
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(w.bin, "claude"), later, later);
    const count = (await w.call("snapshot")).sessions.length;
    await assert.rejects(w.call("conversation.fork", { ...identity, idempotencyKey: "no-fork-flag" }), /cannot branch conversations here/);
    assert.equal((await w.call("snapshot")).sessions.length, count);
    delete process.env.CLAUDE_FIXTURE_NO_FORK;
  } finally {
    delete process.env.CLAUDE_FIXTURE_NO_FORK;
    await w.close();
  }
});
