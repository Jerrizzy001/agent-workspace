import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { createCore } from "../src/core/index.js";
import { COMMANDS } from "../src/shared/contracts.js";
import { CONTROLLER_WRAPS } from "../src/shared/command-policy.js";
import { CONTROLLER_VERBS } from "../src/shared/controller-contracts.js";
import { validateCommand } from "../src/server/validation.js";

const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  read: () => Promise<T> | T,
  ok: (value: T) => boolean,
  tries = 200,
) {
  let value = await read();
  for (let retry = 0; retry < tries && !ok(value); retry++) {
    await wait(50);
    value = await read();
  }
  return value;
}
const mode = (file: string) => fs.statSync(file).mode & 0o777;

/** One awctl process, exactly as an agent would run it (async: the core serves it from this process). */
function awctl(cli: string, controlFile: string | undefined, args: string[]) {
  return new Promise<{ code: number; json: any; stdout: string }>((resolve) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
    if (controlFile) env.AW_CONTROL_FILE = controlFile;
    execFile(
      process.execPath,
      [cli, ...args],
      { env, timeout: 30000 },
      (error, stdout) => {
        let json: any;
        try {
          json = JSON.parse(stdout);
        } catch {}
        resolve({
          code: error ? Number((error as any).code ?? 1) : 0,
          json,
          stdout,
        });
      },
    );
  });
}
/** A raw protocol request, for capability material awctl itself would never send. */
function raw(socketPath: string, request: unknown) {
  return new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (c: string) => (answer += c));
    socket.on("end", () => {
      try {
        resolve(JSON.parse(answer));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

test("agent control: owner grants, awctl acts within the grant, and every boundary holds", async () => {
  const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "workspace-ctl-")),
  );
  const repo = path.join(temp, "alpha");
  const other = path.join(temp, "beta-private");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(other);
  const cli = path.join(temp, "awctl.mjs");
  await build({
    entryPoints: [path.resolve("src/cli/workspace.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: cli,
    logLevel: "silent",
  });
  const saved = {
    SHELL: process.env.SHELL,
    AWCTL: process.env.WORKSPACE_AWCTL,
  };
  process.env.SHELL = "/bin/sh";
  process.env.WORKSPACE_AWCTL = cli;
  const dataDir = path.join(temp, "data");
  let core = await createCore({ dataDir, emit: () => {} });
  const call = (c: any, p: any = {}) => core.invoke(c, p) as Promise<any>;
  let tmuxSocket = "";
  /** Runs a command line in a session's own, already running shell. */
  async function inPane(session: any, command: string) {
    const id = crypto.randomUUID();
    const out = path.join(temp, id + ".out");
    const done = path.join(temp, id + ".code");
    const target = "=" + session.backendName + ":0.0";
    execFileSync(tmux, [
      "-S",
      tmuxSocket,
      "send-keys",
      "-t",
      target,
      "-l",
      `${command} > ${out} 2>/dev/null; echo $? > ${done}`,
    ]);
    execFileSync(tmux, ["-S", tmuxSocket, "send-keys", "-t", target, "Enter"]);
    await until(
      () => fs.existsSync(done) && fs.readFileSync(done, "utf8").endsWith("\n"),
      Boolean,
    );
    const stdout = fs.readFileSync(out, "utf8");
    return {
      code: Number(fs.readFileSync(done, "utf8")),
      json: JSON.parse(stdout),
      stdout,
    };
  }
  const paneEnv = async (session: any) =>
    (
      await inPane(
        session,
        `"${process.execPath}" -e 'console.log(JSON.stringify({AW_CONTROL_FILE:process.env.AW_CONTROL_FILE,AWCTL:process.env.AWCTL,PATH:process.env.PATH}))'`,
      )
    ).json;
  try {
    const alpha = await call("project.add", { path: repo });
    const beta = await call("project.add", { path: other });
    const parent = (
      await call("terminal.open", {
        projectId: alpha.id,
        provider: "shell",
        idempotencyKey: "parent",
      })
    ).session;
    const sibling = (
      await call("terminal.open", {
        projectId: alpha.id,
        provider: "shell",
        idempotencyKey: "sibling",
      })
    ).session;
    const foreign = (
      await call("terminal.open", {
        projectId: beta.id,
        provider: "shell",
        idempotencyKey: "foreign",
      })
    ).session;
    tmuxSocket = parent.backendSocket;
    const parentPid = execFileSync(
      tmux,
      [
        "-S",
        tmuxSocket,
        "display-message",
        "-p",
        "-t",
        "=" + parent.backendName + ":0.0",
        "#{pane_pid}",
      ],
      {
        encoding: "utf8",
      },
    ).trim();

    // The launch environment names a grant file but carries no capability, and only per session.
    const env = await paneEnv(parent);
    assert.match(env.AW_CONTROL_FILE!, /control\/grants\/[0-9a-f]{32}\.json$/);
    assert.equal(fs.existsSync(env.AW_CONTROL_FILE!), false);
    assert.equal(env.AWCTL, path.join(dataDir, "control", "bin", "awctl"));
    assert.ok(env.PATH!.startsWith(path.join(dataDir, "control", "bin") + ":"));
    assert.notEqual(
      (await paneEnv(sibling)).AW_CONTROL_FILE,
      env.AW_CONTROL_FILE,
    );
    const globalEnv = execFileSync(
      tmux,
      ["-S", tmuxSocket, "show-environment", "-g"],
      { encoding: "utf8" },
    );
    assert.equal(globalEnv.includes("AW_CONTROL_FILE"), false);

    // Off until the owner grants it; the running shell is told so.
    let r = await inPane(parent, "awctl status");
    assert.equal(r.code, 1);
    assert.equal(r.json.error, "no_grant");
    assert.equal(
      fs.existsSync(path.join(dataDir, "control", "ctl.sock")),
      false,
      "no listener before a grant",
    );

    // Owner grant validation.
    await assert.rejects(
      core.agentControl("grant", {
        sessionId: parent.id,
        generation: 2,
        verbs: ["status"],
      }),
      /Stale session generation/,
    );
    await assert.rejects(
      core.agentControl("grant", {
        sessionId: parent.id,
        generation: 1,
        verbs: [],
      }),
      /at least one/,
    );
    await assert.rejects(
      core.agentControl("grant", {
        sessionId: parent.id,
        generation: 1,
        verbs: ["session.input"],
      }),
      /at least one/,
    );
    await assert.rejects(
      core.agentControl("grant", {
        sessionId: parent.id,
        generation: 1,
        verbs: ["status"],
        token: "x",
      }),
      /Unexpected/,
    );
    await assert.rejects(
      core.agentControl("grant", {
        sessionId: parent.id,
        generation: 1,
        verbs: ["status"],
        expiresInMinutes: 100000,
      }),
      /expiry/,
    );
    await assert.rejects(
      core.agentControl("mint", { sessionId: parent.id }),
      /Unsupported/,
    );
    // A session launched by an older build has no grant path and cannot be granted.
    const store = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
    store
      .prepare(
        "UPDATE launch_requests SET request=json_remove(request,'$.control') WHERE key='foreign'",
      )
      .run();
    store.close();
    await assert.rejects(
      core.agentControl("grant", {
        sessionId: foreign.id,
        generation: 1,
        verbs: ["status"],
      }),
      /started before agent control/,
    );

    let state = await core.agentControl("grant", {
      sessionId: parent.id,
      generation: 1,
      verbs: [...CONTROLLER_VERBS],
      openLimit: 1,
    });
    assert.equal(state.grant!.openLimit, 1);
    assert.equal(
      Date.parse(state.grant!.expiresAt) - Date.parse(state.grant!.createdAt),
      60 * 60_000,
    );
    assert.equal((state.grant as any).token, undefined);
    const grantFile = env.AW_CONTROL_FILE!;
    const capability = JSON.parse(fs.readFileSync(grantFile, "utf8"));
    const socketPath = capability.socket;
    assert.equal(socketPath, path.join(dataDir, "control", "ctl.sock"));
    assert.equal(mode(path.join(dataDir, "control")), 0o700);
    assert.equal(mode(path.join(dataDir, "control", "grants")), 0o700);
    assert.equal(mode(grantFile), 0o600);
    assert.equal(mode(socketPath), 0o600);
    assert.ok(fs.statSync(socketPath).isSocket());

    // Missing and wrong capabilities.
    assert.equal(
      (await raw(socketPath, { v: 1, verb: "status", args: {} })).error,
      "unauthorized",
    );
    assert.equal(
      (
        await raw(socketPath, {
          v: 1,
          token: "x".repeat(43),
          verb: "status",
          args: {},
        })
      ).error,
      "unauthorized",
    );
    assert.equal(
      (
        await raw(socketPath, {
          v: 1,
          token: capability.token,
          verb: "session.input",
          args: {},
        })
      ).error,
      "unknown_verb",
    );

    // The shell that was already running before the grant can use it now, without a restart.
    r = await inPane(parent, '"$AWCTL" status');
    assert.equal(r.code, 0, r.stdout);
    const status = r.json;
    assert.equal(status.project.id, alpha.id);
    assert.deepEqual(
      status.sessions.map((s: any) => s.id).sort(),
      [parent.id, sibling.id].sort(),
    );
    assert.equal(status.sessions[0].path, ".");
    assert.equal(status.layout.revision, 0);
    for (const secret of [
      temp,
      beta.id,
      foreign.id,
      "beta-private",
      capability.token,
      tmuxSocket,
      "backend",
    ])
      assert.equal(r.stdout.includes(secret), false, `status leaks ${secret}`);
    assert.equal(
      execFileSync(
        tmux,
        [
          "-S",
          tmuxSocket,
          "display-message",
          "-p",
          "-t",
          "=" + parent.backendName + ":0.0",
          "#{pane_pid}",
        ],
        { encoding: "utf8" },
      ).trim(),
      parentPid,
    );

    // Notes: created from a file, idempotent per request id, inert text.
    fs.writeFileSync(path.join(repo, "plan.txt"), "Step 1 <b>not html</b>\n");
    r = await inPane(
      parent,
      "awctl note create --title 'Agent plan' --body-file plan.txt --request-id plan-1",
    );
    assert.equal(r.code, 0, r.stdout);
    const noteId = r.json.note.id;
    assert.equal(r.json.note.revision, 1);
    let snapshot = await call("snapshot");
    let note = snapshot.notes.find((n: any) => n.id === noteId);
    assert.equal(note.bodyLoaded, false);
    assert.equal((await call("note.read", { noteId })).body, "Step 1 <b>not html</b>\n");
    assert.equal(note.source, "agent");
    assert.equal(note.projectId, alpha.id);
    const again = await awctl(cli, grantFile, [
      "note",
      "create",
      "--title",
      "Agent plan",
      "--body-file",
      path.join(repo, "plan.txt"),
      "--request-id",
      "plan-1",
    ]);
    assert.equal(again.code, 0);
    assert.equal(again.json.note.id, noteId);
    assert.equal(again.json.deduplicated, true);
    assert.equal((await call("snapshot")).notes.length, 1);
    const conflict = await awctl(cli, grantFile, [
      "note",
      "create",
      "--title",
      "Other",
      "--request-id",
      "plan-1",
    ]);
    assert.equal(conflict.code, 1);
    assert.equal(conflict.json.error, "request_id_conflict");
    // A project named in the request cannot widen the grant.
    const widened = await raw(socketPath, {
      v: 1,
      token: capability.token,
      verb: "note.create",
      args: { title: "Elsewhere", projectId: beta.id },
    });
    assert.equal(widened.ok, true);
    assert.equal(
      (await call("snapshot")).notes.find((n: any) => n.id === widened.note.id)
        .projectId,
      alpha.id,
    );

    // Stale note revisions never overwrite the owner's newer edit.
    await call("note.update", {
      noteId,
      title: "Agent plan",
      body: "Owner edit",
      revision: note.revision ?? 1,
    });
    let stale = await awctl(cli, grantFile, [
      "note",
      "update",
      "--note",
      noteId,
      "--revision",
      "1",
      "--body",
      "Agent overwrite",
    ]);
    assert.equal(stale.code, 1);
    assert.equal(stale.json.error, "stale_revision");
    assert.equal(stale.json.currentRevision, 2);
    note = (await call("snapshot")).notes.find((n: any) => n.id === noteId);
    assert.equal((await call("note.read", { noteId })).body, "Owner edit");
    const updated = await awctl(cli, grantFile, [
      "note",
      "update",
      "--note",
      noteId,
      "--revision",
      "2",
      "--body",
      "Agent addition",
    ]);
    assert.equal(updated.code, 0, updated.stdout);
    assert.equal(updated.json.note.revision, 3);

    // Canvas placement: own project's nodes only, bounded, revision-checked.
    r = await inPane(
      parent,
      `awctl canvas place --node ${noteId} --x 120 --y -40 --revision 0`,
    );
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.layoutRevision, 1);
    snapshot = await call("snapshot");
    assert.deepEqual(
      snapshot.layouts.find((l: any) => l.projectId === alpha.id).positions[
        noteId
      ],
      { x: 120, y: -40 },
    );
    await call("layout.save", {
      projectId: alpha.id,
      positions: { [noteId]: { x: 5, y: 5 } },
    });
    stale = await awctl(cli, grantFile, [
      "canvas",
      "place",
      "--node",
      noteId,
      "--x",
      "900",
      "--y",
      "900",
      "--revision",
      "1",
    ]);
    assert.equal(stale.json.error, "stale_revision");
    assert.equal(stale.json.currentRevision, 2);
    assert.deepEqual(
      (await call("snapshot")).layouts.find(
        (l: any) => l.projectId === alpha.id,
      ).positions[noteId],
      { x: 5, y: 5 },
    );
    const outside = await awctl(cli, grantFile, [
      "canvas",
      "place",
      "--node",
      foreign.id,
      "--x",
      "1",
      "--y",
      "1",
      "--revision",
      "2",
    ]);
    assert.equal(outside.json.error, "not_found");
    const huge = await awctl(cli, grantFile, [
      "canvas",
      "place",
      "--node",
      noteId,
      "--x",
      "1e9",
      "--y",
      "1",
      "--revision",
      "2",
    ]);
    assert.equal(huge.json.error, "bad_request");
    const sessionNode = await awctl(cli, grantFile, [
      "canvas",
      "place",
      "--node",
      sibling.id,
      "--x",
      "700",
      "--y",
      "0",
      "--revision",
      "2",
    ]);
    assert.equal(sessionNode.code, 0, sessionNode.stdout);

    // open: escapes refused, idempotent per request id, fan-out limited, children get no grant.
    const escape = await awctl(cli, grantFile, [
      "open",
      "--provider",
      "shell",
      "--path",
      "../beta-private",
      "--request-id",
      "esc",
    ]);
    assert.equal(escape.code, 1);
    assert.match(escape.json.message, /escapes/);
    const bad = await awctl(cli, grantFile, [
      "open",
      "--provider",
      "bash",
      "--request-id",
      "bad",
    ]);
    assert.equal(bad.json.error, "bad_request");
    r = await inPane(
      parent,
      "awctl open --provider shell --path src --request-id child-1",
    );
    assert.equal(r.code, 0, r.stdout);
    const child = r.json.session;
    assert.equal(child.path, "src");
    const repeat = await awctl(cli, grantFile, [
      "open",
      "--provider",
      "shell",
      "--path",
      "src",
      "--request-id",
      "child-1",
    ]);
    assert.equal(repeat.json.session.id, child.id);
    assert.equal(repeat.json.deduplicated, true);
    assert.equal((await call("snapshot")).sessions.length, 4);
    const fanout = await awctl(cli, grantFile, [
      "open",
      "--provider",
      "shell",
      "--request-id",
      "child-2",
    ]);
    assert.equal(fanout.json.error, "open_limit");
    assert.equal((await call("snapshot")).sessions.length, 4);
    const childRecord = (await call("snapshot")).sessions.find(
      (s: any) => s.id === child.id,
    );
    const childEnv = await paneEnv(childRecord);
    assert.notEqual(childEnv.AW_CONTROL_FILE, grantFile);
    assert.equal(fs.existsSync(childEnv.AW_CONTROL_FILE!), false);
    r = await inPane(childRecord, "awctl status");
    assert.equal(r.json.error, "no_grant");
    assert.equal(
      (await awctl(cli, undefined, ["status"])).json.error,
      "no_grant",
    );

    // A grant without a verb, a rate budget, and the audit trail.
    await core.agentControl("grant", {
      sessionId: sibling.id,
      generation: 1,
      verbs: ["status"],
      ratePerMinute: 3,
    });
    const siblingFile = (await paneEnv(sibling)).AW_CONTROL_FILE!;
    const denied = await awctl(cli, siblingFile, [
      "note",
      "create",
      "--title",
      "Nope",
    ]);
    assert.equal(denied.json.error, "not_granted");
    assert.equal((await awctl(cli, siblingFile, ["status"])).code, 0);
    assert.equal((await awctl(cli, siblingFile, ["status"])).code, 0);
    const flooded = await awctl(cli, siblingFile, ["status"]);
    assert.equal(flooded.json.error, "rate_limited");
    state = await core.agentControl("list", { sessionId: sibling.id });
    assert.deepEqual(
      state.audit.map((a) => [a.action, a.outcome]),
      [
        ["status", "denied"],
        ["note.create", "denied"],
        ["grant", "ok"],
      ],
    );
    state = await core.agentControl("list", { sessionId: parent.id });
    assert.ok(
      state.audit.some(
        (a) =>
          a.action === "open" &&
          a.outcome === "ok" &&
          a.ids?.includes(child.id),
      ),
    );
    assert.ok(
      state.audit.some(
        (a) => a.action === "note.update" && a.outcome === "error",
      ),
    );
    assert.equal(state.grant!.openSessions, 1);

    // Concurrent opens cannot race past the fan-out limit (one already runs).
    await core.agentControl("grant", {
      sessionId: parent.id,
      generation: 1,
      verbs: ["open"],
      openLimit: 2,
    });
    const opener = JSON.parse(fs.readFileSync(grantFile, "utf8")).token;
    const burst = await Promise.all(
      ["c-a", "c-b", "c-c"].map((requestId) =>
        raw(socketPath, {
          v: 1,
          token: opener,
          verb: "open",
          requestId,
          args: { provider: "shell" },
        }),
      ),
    );
    assert.equal(burst.filter((x) => x.ok).length, 1);
    assert.deepEqual(
      burst.filter((x) => !x.ok).map((x) => x.error),
      ["open_limit", "open_limit"],
    );
    assert.equal((await call("snapshot")).sessions.length, 5);

    // Notes per grant are capped even with a generous rate budget.
    await core.agentControl("grant", {
      sessionId: sibling.id,
      generation: 1,
      verbs: ["note.create"],
      ratePerMinute: 600,
    });
    const flood = JSON.parse(fs.readFileSync(siblingFile, "utf8")).token;
    const results = [];
    for (let i = 0; i < 51; i++)
      results.push(
        await raw(socketPath, {
          v: 1,
          token: flood,
          verb: "note.create",
          args: { title: "n" + i },
        }),
      );
    assert.equal(results.filter((x) => x.ok).length, 50);
    assert.equal(results[50].error, "note_limit");

    // Expiry (the core's clock moves past the 60 minute default).
    const realNow = Date.now;
    Date.now = () => realNow() + 61 * 60_000;
    try {
      const expired = await raw(socketPath, {
        v: 1,
        token: flood,
        verb: "status",
        args: {},
      });
      assert.equal(expired.error, "expired");
    } finally {
      Date.now = realNow;
    }
    assert.equal(fs.existsSync(siblingFile), false);

    // Revoke: the file disappears, the old capability is refused, the shell keeps running.
    state = await core.agentControl("revoke", { sessionId: parent.id });
    assert.equal(state.grant, null);
    assert.equal(fs.existsSync(grantFile), false);
    r = await inPane(parent, "awctl status");
    assert.equal(r.json.error, "no_grant");
    assert.equal(
      (
        await raw(socketPath, {
          v: 1,
          token: capability.token,
          verb: "status",
          args: {},
        })
      ).error,
      "revoked",
    );
    assert.equal(
      execFileSync(
        tmux,
        [
          "-S",
          tmuxSocket,
          "display-message",
          "-p",
          "-t",
          "=" + parent.backendName + ":0.0",
          "#{pane_pid}",
        ],
        { encoding: "utf8" },
      ).trim(),
      parentPid,
    );

    // Capabilities are never stored in the database.
    await core.agentControl("grant", {
      sessionId: parent.id,
      generation: 1,
      verbs: ["status"],
    });
    const live = JSON.parse(fs.readFileSync(grantFile, "utf8")).token;
    const database =
      fs
        .readFileSync(path.join(dataDir, "workspace.sqlite"))
        .toString("latin1") +
      (fs.existsSync(path.join(dataDir, "workspace.sqlite-wal"))
        ? fs
            .readFileSync(path.join(dataDir, "workspace.sqlite-wal"))
            .toString("latin1")
        : "");
    assert.equal(database.includes(live), false);
    assert.equal(JSON.stringify(await call("snapshot")).includes(live), false);

    // A core restart revokes every grant; the sessions keep running.
    await core.close();
    assert.equal(fs.existsSync(grantFile), false);
    core = await createCore({ dataDir, emit: () => {} });
    assert.equal(
      (await core.agentControl("list", { sessionId: parent.id })).grant,
      null,
    );
    const afterRestart = await raw(socketPath, {
      v: 1,
      token: live,
      verb: "status",
      args: {},
    }).catch((e) => e);
    assert.ok(
      afterRestart instanceof Error,
      "no listener until the owner grants again",
    );
    await core.agentControl("grant", {
      sessionId: parent.id,
      generation: 1,
      verbs: ["status"],
    });
    assert.equal(
      (await raw(socketPath, { v: 1, token: live, verb: "status", args: {} }))
        .error,
      "unauthorized",
    );
    r = await inPane(parent, "awctl status");
    assert.equal(r.code, 0, r.stdout);
    assert.equal(
      execFileSync(
        tmux,
        [
          "-S",
          tmuxSocket,
          "display-message",
          "-p",
          "-t",
          "=" + parent.backendName + ":0.0",
          "#{pane_pid}",
        ],
        { encoding: "utf8" },
      ).trim(),
      parentPid,
    );

    // Ending the source session ends its grant.
    const last = JSON.parse(fs.readFileSync(grantFile, "utf8")).token;
    await call("session.attach", {
      sessionId: parent.id,
      generation: 1,
      viewerId: "v",
    });
    await call("session.terminate", {
      sessionId: parent.id,
      generation: 1,
      viewerId: "v",
    });
    const after = await raw(socketPath, {
      v: 1,
      token: last,
      verb: "status",
      args: {},
    });
    assert.equal(after.error, "revoked");
    assert.match(after.message, /Source session ended/);
    assert.equal(fs.existsSync(grantFile), false);
    await assert.rejects(
      core.agentControl("grant", {
        sessionId: parent.id,
        generation: 1,
        verbs: ["status"],
      }),
      /running session/,
    );
  } finally {
    await core.close();
    try {
      if (tmuxSocket)
        execFileSync(tmux, ["-S", tmuxSocket, "kill-server"], {
          stdio: "ignore",
        });
    } catch {}
    process.env.SHELL = saved.SHELL;
    if (saved.AWCTL === undefined) delete process.env.WORKSPACE_AWCTL;
    else process.env.WORKSPACE_AWCTL = saved.AWCTL;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("awctl reports an unknown outcome when a mutation's answer is lost", async () => {
  const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "workspace-ctl-lost-")),
  );
  const cli = path.join(temp, "awctl.mjs");
  await build({
    entryPoints: [path.resolve("src/cli/workspace.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: cli,
    logLevel: "silent",
  });
  const socketPath = path.join(temp, "s.sock");
  // A peer that reads the request and closes without answering.
  const server = net.createServer((s) => s.once("data", () => s.destroy()));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const file = path.join(temp, "grant.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ v: 1, socket: socketPath, token: "t" }),
    { mode: 0o600 },
  );
  try {
    const lost = await awctl(cli, file, [
      "note",
      "create",
      "--title",
      "x",
      "--request-id",
      "r",
    ]);
    assert.equal(lost.code, 3);
    assert.equal(lost.json.outcome, "unknown");
    const read = await awctl(cli, file, ["status"]);
    assert.equal(read.code, 1);
    assert.equal(read.json.outcome, "rejected");
    const usage = await awctl(cli, file, ["note", "create"]);
    assert.equal(usage.code, 2);
  } finally {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("agent control has no route through the gateway and wraps no dangerous command", () => {
  assert.equal((COMMANDS as readonly string[]).includes("agentControl"), false);
  for (const name of [
    "agentControl",
    "agent-control",
    "workspace:agent-control",
    "status",
    "canvas.place",
  ])
    assert.throws(() => validateCommand(name, {}), /not available remotely/);
  assert.deepEqual(
    Object.keys(CONTROLLER_WRAPS).sort(),
    [...CONTROLLER_VERBS].sort(),
  );
  for (const wrapped of Object.values(CONTROLLER_WRAPS)) {
    if (wrapped === null) continue;
    assert.ok((COMMANDS as readonly string[]).includes(wrapped));
    assert.doesNotMatch(
      wrapped,
      /^(session\.|files\.|git\.|worktree\.|settings\.|project\.)/,
    );
  }
  // Paired owners can use note revisions for safe canvas renames, but cannot spoof agent fields or send layout revisions.
  assert.equal(
    validateCommand("note.update", { noteId: "n", revision: 1, title: "Plan" })
      .payload.revision,
    1,
  );
  assert.throws(
    () => validateCommand("note.update", { noteId: "n", source: "agent" }),
    /Unexpected command field/,
  );
  assert.throws(
    () =>
      validateCommand("layout.save", {
        projectId: "p",
        positions: {},
        revision: 1,
      }),
    /Unexpected command field/,
  );
  assert.throws(
    () =>
      validateCommand("note.create", {
        projectId: "p",
        title: "t",
        source: "agent",
      }),
    /Unexpected command field/,
  );
});
