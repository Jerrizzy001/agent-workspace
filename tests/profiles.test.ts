import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmux, until, workspace } from "./claude-fixture.js";
import { validateCommand } from "../src/server/validation.js";
import { COMMAND_POLICY } from "../src/shared/command-policy.js";

const sha = (file: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const mode = (file: string) => fs.statSync(file).mode & 0o777;

test("Claude profiles: per-session CLAUDE_CONFIG_DIR only, global files untouched, removal refused while in use", async () => {
  const w = await workspace("workspace-profiles-");
  try {
    // The owner's global Claude files, which nothing here may change.
    fs.mkdirSync(path.join(w.home, ".claude"), { mode: 0o700 });
    fs.writeFileSync(path.join(w.home, ".claude.json"), '{"global":true}\n');
    fs.writeFileSync(
      path.join(w.home, ".claude", "settings.json"),
      '{"theme":"dark"}\n',
    );
    const globalHashes = [
      sha(path.join(w.home, ".claude.json")),
      sha(path.join(w.home, ".claude", "settings.json")),
    ];

    // A default-profile session started before any profile exists.
    const before = (
      await w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        idempotencyKey: "before",
      })
    ).session;
    w.setSocket(before.backendSocket);
    assert.equal(before.profileId, undefined);
    const beforePid = w.pane(before, "#{pane_pid}");

    // Create: private folders under the data folder; plain labels.
    const initial: any = await w.core.profiles("list");
    assert.deepEqual(initial.profiles, []);
    if (process.platform === "darwin")
      assert.ok(initial.warnings.some((w: string) => w.includes("Keychain")));
    else assert.deepEqual(initial.warnings, []);
    await assert.rejects(
      w.core.profiles("create", { label: "  " }),
      /Name the profile/,
    );
    await assert.rejects(
      w.core.profiles("create", { label: "Default" }),
      /usual sign-in/,
    );
    await assert.rejects(
      w.core.profiles("create", { label: "x".repeat(41) }),
      /at most 40/,
    );
    await assert.rejects(
      w.core.profiles("create", { label: "Work", path: "/tmp" }),
      /Unexpected profile field/,
    );
    await w.core.profiles("create", { label: "Work‮\u0007" });
    await assert.rejects(
      w.core.profiles("create", { label: "work" }),
      /already exists/,
    );
    const state: any = await w.core.profiles("create", { label: "Personal" });
    const [work, personal] = state.profiles;
    assert.equal(work.label, "Work");
    assert.equal(personal.label, "Personal");
    for (const p of [work, personal]) {
      assert.ok(
        p.location.startsWith(path.join(w.dataDir, "profiles") + path.sep),
      );
      assert.equal(mode(p.location), 0o700);
      assert.equal(p.state, "empty");
      assert.equal(p.openSessions, 0);
    }
    assert.equal(mode(path.join(w.dataDir, "profiles")), 0o700);
    assert.notEqual(work.location, personal.location);

    // Profiles are for Claude folder sessions on the desktop only.
    await assert.rejects(
      w.call("terminal.open", {
        projectId: w.project.id,
        provider: "shell",
        profileId: work.id,
        idempotencyKey: "shell-profile",
      }),
      /only for Claude/,
    );
    await assert.rejects(
      w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        profileId: crypto.randomUUID(),
        idempotencyKey: "ghost",
      }),
      /removed/,
    );
    const task = await w.call("task.create", {
      projectId: w.project.id,
      title: "t",
    });
    await assert.rejects(
      w.call("attempt.start", {
        taskId: task.id,
        provider: "claude",
        profileId: work.id,
        idempotencyKey: "attempt-profile",
      }),
      /folder session/,
    );
    assert.throws(
      () =>
        validateCommand("terminal.open", {
          projectId: w.project.id,
          provider: "claude",
          profileId: work.id,
          idempotencyKey: "r",
        }),
      /Unexpected command field/,
    );

    // One session per profile, plus the default.
    const a = (
      await w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        profileId: work.id,
        prompt: "hello work",
        idempotencyKey: "a",
      })
    ).session;
    const b = (
      await w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        profileId: personal.id,
        prompt: "hello personal",
        idempotencyKey: "b",
      })
    ).session;
    const d = (
      await w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        prompt: "hello default",
        idempotencyKey: "d",
      })
    ).session;
    assert.equal(a.profileId, work.id);
    assert.equal(b.profileId, personal.id);
    assert.equal(d.profileId, undefined);
    // An idempotent retry returns the same session.
    assert.equal(
      (
        await w.call("terminal.open", {
          projectId: w.project.id,
          provider: "claude",
          profileId: work.id,
          prompt: "hello work",
          idempotencyKey: "a",
        })
      ).session.id,
      a.id,
    );

    // Exact per-session environment: the profile folder only where chosen; HOME unchanged everywhere.
    const envA = w.paneEnv(a),
      envB = w.paneEnv(b),
      envD = w.paneEnv(d),
      envBefore = w.paneEnv(before);
    assert.equal(envA.CLAUDE_CONFIG_DIR, work.location);
    assert.equal(envB.CLAUDE_CONFIG_DIR, personal.location);
    assert.equal(envD.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(envBefore.CLAUDE_CONFIG_DIR, undefined);
    for (const env of [envA, envB, envD, envBefore])
      assert.equal(env.HOME, w.home);
    // Not in tmux's global environment, and the earlier session kept its process.
    const global = execFileSync(
      tmux,
      ["-S", a.backendSocket, "show-environment", "-g"],
      { encoding: "utf8" },
    );
    assert.equal(global.includes("CLAUDE_CONFIG_DIR"), false);
    assert.match(
      execFileSync(
        tmux,
        [
          "-S",
          a.backendSocket,
          "show-environment",
          "-t",
          "=" + a.backendName,
          "CLAUDE_CONFIG_DIR",
        ],
        { encoding: "utf8" },
      ),
      new RegExp("^CLAUDE_CONFIG_DIR=" + work.location),
    );
    assert.equal(w.pane(before, "#{pane_pid}"), beforePid);

    // What each CLI saw, and where it stored its conversation.
    const starts = await until(
      () => w.starts(),
      (s) => s.length >= 4,
    );
    const seen = (prompt: string) =>
      starts.find((s: any) => s.args.includes(prompt));
    assert.equal(seen("hello work").env.CLAUDE_CONFIG_DIR, work.location);
    assert.equal(
      seen("hello personal").env.CLAUDE_CONFIG_DIR,
      personal.location,
    );
    assert.equal(seen("hello default").env.CLAUDE_CONFIG_DIR, null);
    const conversations = (root: string) =>
      fs.existsSync(path.join(root, "projects"))
        ? fs
            .readdirSync(path.join(root, "projects"))
            .flatMap((d) => fs.readdirSync(path.join(root, "projects", d)))
        : [];
    await until(
      () =>
        conversations(work.location).length +
        conversations(personal.location).length +
        conversations(path.join(w.home, ".claude")).length,
      (n) => n === 3,
    );
    assert.deepEqual(conversations(work.location), [
      a.conversationId + ".jsonl",
    ]);
    assert.deepEqual(conversations(personal.location), [
      b.conversationId + ".jsonl",
    ]);
    // (The earlier session has had no turn, so it has no file yet.)
    assert.deepEqual(conversations(path.join(w.home, ".claude")), [
      d.conversationId + ".jsonl",
    ]);
    assert.deepEqual(
      [
        sha(path.join(w.home, ".claude.json")),
        sha(path.join(w.home, ".claude", "settings.json")),
      ],
      globalHashes,
    );
    // The app never wrote into a profile folder: only the CLI did.
    const listed: any = await w.core.profiles("list");
    assert.equal(
      listed.profiles.find((p: any) => p.id === work.id).state,
      "ready",
    );
    assert.equal(
      listed.profiles.find((p: any) => p.id === work.id).openSessions,
      1,
    );
    assert.equal(JSON.stringify(listed).includes("token"), false);

    // Removal is refused while a session uses the profile.
    await assert.rejects(
      w.core.profiles("remove", { profileId: work.id, deleteData: false }),
      /End the 1 session using "Work"/,
    );
    await assert.rejects(
      w.core.profiles("remove", { profileId: work.id }),
      /Choose whether/,
    );

    // Resume keeps the conversation's profile; another profile is refused.
    w.type(a, "/exit");
    await until(
      () => w.sessionOf(a.id),
      (s) => s.status === "exited",
    );
    await assert.rejects(
      w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        resumeSessionId: a.id,
        profileId: personal.id,
        idempotencyKey: "a-wrong",
      }),
      /keeps its own profile/,
    );
    const resumed = (
      await w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        resumeSessionId: a.id,
        idempotencyKey: "a-resume",
      })
    ).session;
    assert.equal(resumed.profileId, work.id);
    const resumedStart = await until(
      () => w.starts(),
      (s) => s.some((x: any) => x.args.includes("--resume")),
    );
    assert.equal(w.paneEnv(resumed).CLAUDE_CONFIG_DIR, work.location);
    assert.deepEqual(
      resumedStart
        .find((x: any) => x.args.includes("--resume"))
        .args.slice(0, 2),
      ["--resume", a.conversationId],
    );
    w.type(resumed, "/exit");
    await until(
      () => w.sessionOf(resumed.id),
      (s) => s.status === "exited",
    );

    // Set up: the unmodified CLI, no arguments, in a terminal with the profile folder.
    const setup: any = await w.core.profiles("setup", {
      profileId: personal.id,
      projectId: w.project.id,
      idempotencyKey: "setup-1",
    });
    assert.equal(setup.session.profileSetup, true);
    assert.equal(setup.session.profileId, personal.id);
    assert.equal(setup.session.conversationId, undefined);
    assert.equal(setup.session.activityTracking, undefined);
    const setupStart = await until(
      () => w.starts(),
      (s) => s.some((x: any) => x.args.length === 0),
    );
    assert.equal(
      setupStart.find((x: any) => x.args.length === 0).env.CLAUDE_CONFIG_DIR,
      personal.location,
    );
    await assert.rejects(
      w.core.profiles("setup", {
        profileId: personal.id,
        projectId: w.project.id,
        idempotencyKey: "setup-1",
        extra: 1,
      }),
      /Unexpected/,
    );

    // Removing Work keeps its folder unless asked; the ended conversation cannot switch accounts.
    const removed: any = await w.core.profiles("remove", {
      profileId: work.id,
      deleteData: false,
    });
    assert.equal(removed.keptData, work.location);
    assert.equal(fs.existsSync(work.location), true);
    assert.deepEqual(
      removed.profiles.map((p: any) => p.id),
      [personal.id],
    );
    await assert.rejects(
      w.call("terminal.open", {
        projectId: w.project.id,
        provider: "claude",
        resumeSessionId: resumed.id,
        idempotencyKey: "after-remove",
      }),
      /was removed; it cannot be continued with another account/,
    );

    // Personal: refused while either of its sessions runs, then deleted on request.
    await assert.rejects(
      w.core.profiles("remove", { profileId: personal.id, deleteData: true }),
      /End the 2 sessions/,
    );
    w.type(b, "/exit");
    w.type(setup.session, "/exit");
    await until(
      () => w.sessionOf(b.id),
      (s) => s.status === "exited",
    );
    await until(
      () => w.sessionOf(setup.session.id),
      (s) => s.status === "exited",
    );
    await w.core.profiles("remove", {
      profileId: personal.id,
      deleteData: true,
    });
    assert.equal(fs.existsSync(personal.location), false);
    assert.deepEqual(
      [
        sha(path.join(w.home, ".claude.json")),
        sha(path.join(w.home, ".claude", "settings.json")),
      ],
      globalHashes,
    );

    // Profiles never cross the gateway or the generic command channel.
    assert.equal(
      Object.keys(COMMAND_POLICY).some((c) => c.startsWith("profile")),
      false,
    );
    await assert.rejects(w.call("profiles.list" as any), /Unsupported command/);
  } finally {
    await w.close();
  }
});
