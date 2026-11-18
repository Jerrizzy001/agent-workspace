import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workspace, until, tmux } from "./claude-fixture.js";
import { validateCommand } from "../src/server/validation.js";

test("failed Claude turn is reported, can branch, and old activity becomes explicitly stale", async () => {
  const w = await workspace("aw-ux-activity-");
  try {
    const s = (
      await w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        idempotencyKey: "source",
      })
    ).session;
    w.setSocket(s.backendSocket);
    await until(
      () => w.starts(),
      (xs) => xs.length > 0,
    );
    w.type(s, "/fixture-error");
    assert.equal(
      (
        await until(
          () => w.sessionOf(s.id),
          (s) => s.activity === "error",
        )
      ).activity,
      "error",
    );
    const child = await w.call("conversation.fork", {
      sessionId: s.id,
      generation: s.generation,
      idempotencyKey: "after-error",
    });
    assert.equal(child.session.forkedFrom.sessionId, s.id);
    execFileSync(tmux, [
      "-S",
      s.backendSocket,
      "set-option",
      "-p",
      "-t",
      "=" + s.backendName + ":0.0",
      "@aw_activity",
      "running",
      ";",
      "set-option",
      "-p",
      "-t",
      "=" + s.backendName + ":0.0",
      "@aw_activity_at",
      "1",
    ]);
    assert.equal(
      (
        await until(
          () => w.sessionOf(s.id),
          (s) => s.activity === "stale",
        )
      ).activity,
      "stale",
    );
    await assert.rejects(
      w.call("conversation.fork", {
        sessionId: s.id,
        generation: 1,
        idempotencyKey: "stale",
      }),
      /finished its turn/,
    );
    await w.call("session.confirmIdle", { sessionId: s.id, generation: 1 });
    assert.equal((await w.sessionOf(s.id)).activity, "done");
    assert.throws(
      () =>
        validateCommand("session.confirmIdle", {
          sessionId: s.id,
          generation: 1,
        }),
      /not available/,
    );
  } finally {
    await w.close();
  }
});

test("canvas archive and task attachment preserve data and enforce revisions and folder boundaries", async () => {
  const w = await workspace("aw-ux-metadata-");
  try {
    const s = (
      await w.call("terminal.open", {
        projectId: w.project.id,
        provider: "shell",
        idempotencyKey: "shell",
      })
    ).session;
    w.setSocket(s.backendSocket);
    const pid = w.pane(s, "#{pane_pid}");
    const note = await w.call("note.create", {
      projectId: w.project.id,
      title: "Plan",
      body: "Keep this text",
    });
    const archived = await w.call("note.archive", {
      noteId: note.id,
      revision: 1,
      archived: true,
    });
    assert.equal(archived.body, note.body);
    await assert.rejects(
      w.call("note.archive", { noteId: note.id, revision: 1, archived: false }),
      /Stale/,
    );
    await w.call("note.archive", {
      noteId: note.id,
      revision: archived.revision,
      archived: false,
    });
    await w.call("session.canvas", {
      sessionId: s.id,
      generation: 1,
      hidden: true,
    });
    assert.equal((await w.sessionOf(s.id)).canvasHidden, true);
    await assert.rejects(
      w.call("session.canvas", {
        sessionId: s.id,
        generation: 2,
        hidden: false,
      }),
      /Stale/,
    );
    await w.call("session.canvas", {
      sessionId: s.id,
      generation: 1,
      hidden: false,
    });
    const task = await w.call("task.create", {
      projectId: w.project.id,
      title: "Existing work",
    });
    await w.call("layout.save", {
      projectId: w.project.id,
      positions: { [s.id]: { x: 111, y: 222 } },
    });
    const attached = await w.call("session.task", {
      sessionId: s.id,
      generation: 1,
      taskId: task.id,
    });
    assert.equal(w.pane(s, "#{pane_pid}"), pid);
    assert.equal((await w.call("snapshot")).sessions.length, 1);
    assert.deepEqual(
      (await w.call("snapshot")).layouts[0].positions[attached.attemptId],
      { x: 111, y: 222 },
    );
    assert.equal(
      (
        await w.call("session.task", {
          sessionId: s.id,
          generation: 1,
          taskId: task.id,
        })
      ).attemptId,
      attached.attemptId,
    );
    const otherPath = path.join(w.temp, "other");
    fs.mkdirSync(otherPath);
    const other = await w.call("project.add", { path: otherPath });
    const foreign = await w.call("task.create", {
      projectId: other.id,
      title: "Other folder",
    });
    await assert.rejects(
      w.call("session.task", {
        sessionId: s.id,
        generation: 1,
        taskId: foreign.id,
      }),
      /same folder/,
    );
    assert.throws(
      () =>
        validateCommand("note.archive", {
          noteId: note.id,
          revision: 2,
          archived: "yes",
        }),
      /Invalid/,
    );
  } finally {
    await w.close();
  }
});

test("connecting context adds only read permission without rotating an existing grant or resetting its budgets", async () => {
  const w = await workspace("aw-ux-grant-", { awctl: true });
  try {
    const s = (
      await w.call("terminal.open", {
        projectId: w.project.id,
        provider: "shell",
        idempotencyKey: "recipient",
      })
    ).session;
    w.setSocket(s.backendSocket);
    const before = await w.core.agentControl("grant", {
      sessionId: s.id,
      generation: 1,
      verbs: ["status", "note.create"],
      expiresInMinutes: 30,
    });
    const next = await w.core.agentControl("allowTranscript", {
      sessionId: s.id,
      generation: 1,
    });
    assert.equal(next.grant!.id, before.grant!.id);
    assert.equal(next.grant!.expiresAt, before.grant!.expiresAt);
    assert.equal(next.grant!.notesCreated, before.grant!.notesCreated);
    assert.deepEqual(next.grant!.verbs, [
      "status",
      "note.create",
      "transcript.read",
    ]);
    assert.equal(
      (
        await w.core.agentControl("allowTranscript", {
          sessionId: s.id,
          generation: 1,
        })
      ).grant!.id,
      before.grant!.id,
    );
    await assert.rejects(
      w.core.agentControl("allowTranscript", {
        sessionId: s.id,
        generation: 2,
      }),
      /Stale/,
    );
    await assert.rejects(
      w.core.agentControl("allowTranscript", {
        sessionId: s.id,
        generation: 1,
        verbs: ["open"],
      }),
      /Unexpected/,
    );
    await w.core.agentControl("revoke", { sessionId: s.id });
    const fresh = await w.core.agentControl("allowTranscript", {
      sessionId: s.id,
      generation: 1,
    });
    assert.deepEqual(fresh.grant!.verbs, ["transcript.read"]);
    assert.equal(
      Date.parse(fresh.grant!.expiresAt) - Date.parse(fresh.grant!.createdAt),
      15 * 60_000,
    );
  } finally {
    await w.close();
  }
});

test("account readiness uses the CLI report and never exposes extra fields", async () => {
  const w = await workspace("aw-ux-account-");
  try {
    const status: any = await w.core.profiles("account", {});
    assert.equal(status.loggedIn, true);
    assert.equal(status.email, "fixture@example.invalid");
    assert.equal(
      JSON.stringify(status).includes("NEVER_RETURN_FIXTURE_TOKEN"),
      false,
    );
    assert.equal(status.accessToken, undefined);
    await assert.rejects(
      w.core.profiles("account", { profileId: "../../outside" }),
      /Invalid profile/,
    );
    await assert.rejects(
      w.core.profiles("account", { extra: "field" }),
      /Unexpected/,
    );
  } finally {
    await w.close();
  }
});
