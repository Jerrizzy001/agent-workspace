import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { teamFixture } from "./team-fixture.js";
import { createTeam } from "../src/team/service.js";
import { TeamClientError, type TeamClient } from "../src/team/client.js";
import { TEAM_ACTIONS } from "../src/shared/team-contracts.js";
import { COMMANDS } from "../src/shared/contracts.js";
import { COMMAND_POLICY } from "../src/shared/command-policy.js";
import { startGateway } from "../src/server/gateway.js";

const mid = () => crypto.randomUUID();
async function code(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof TeamClientError, String(e));
    assert.equal(e.code, expected, e.message);
    return;
  }
  assert.fail("expected " + expected);
}

/** Owner, admin, member, viewer in one team project; an owner of another team as the outsider. */
async function world(extra = {}) {
  const fx = await teamFixture(extra);
  const owner = fx.client(await fx.login("alice", fx.team.code));
  const project = await owner.call("project.create", { teamId: fx.team.teamId, name: "Web", mutationId: mid() });
  const join = async (user: string, role: string) => {
    const inv = await owner.call("member.invite", { projectId: project.id, role });
    return fx.client(await fx.login(user, inv.code));
  };
  const admin = await join("dave", "admin");
  const member = await join("bob", "member");
  const viewer = await join("carol", "viewer");
  const other = createTeam(fx.service.db, { name: "Other team" });
  const outsider = fx.client(await fx.login("frank", other.code));
  const otherProject = await outsider.call("project.create", { teamId: other.teamId, name: "Elsewhere", mutationId: mid() });
  const otherTask = await outsider.call("sharedTask.publish", { projectId: otherProject.id, title: "Theirs", description: "", status: "ready", mutationId: mid() });
  const task = await owner.call("sharedTask.publish", { projectId: project.id, title: "Ship", description: "Do it", status: "ready", mutationId: mid() });
  const ids: Record<string, string> = {};
  for (const m of await owner.call("member.list", { projectId: project.id })) ids[m.name] = m.memberId;
  const outsiderId = (await outsider.call("me")).teams[0].memberId;
  return { fx, owner, admin, member, viewer, outsider, project, task, ids, otherProject, otherTask, outsiderId, other };
}

test("role x resource matrix is enforced at query and mutation time", async () => {
  const w = await world();
  try {
    const roles: [string, TeamClient][] = [
      ["owner", w.owner],
      ["admin", w.admin],
      ["member", w.member],
      ["viewer", w.viewer],
      ["outsider", w.outsider],
    ];
    // expected outcome per role: "ok" | error code
    const matrix: { name: string; run: (c: TeamClient) => Promise<unknown>; expect: Record<string, string> }[] = [
      { name: "changes.read", run: (c) => c.call("changes.read", { projectId: w.project.id }), expect: { owner: "ok", admin: "ok", member: "ok", viewer: "ok", outsider: "no-access" } },
      { name: "member.list", run: (c) => c.call("member.list", { projectId: w.project.id }), expect: { owner: "ok", admin: "ok", member: "ok", viewer: "ok", outsider: "no-access" } },
      { name: "comment.list", run: (c) => c.call("comment.list", { taskId: w.task.id }), expect: { owner: "ok", admin: "ok", member: "ok", viewer: "ok", outsider: "no-access" } },
      { name: "comment.create", run: (c) => c.call("comment.create", { taskId: w.task.id, body: "hi", mutationId: mid() }), expect: { owner: "ok", admin: "ok", member: "ok", viewer: "forbidden", outsider: "no-access" } },
      { name: "sharedTask.publish", run: (c) => c.call("sharedTask.publish", { projectId: w.project.id, title: "T", description: "", status: "backlog", mutationId: mid() }), expect: { owner: "ok", admin: "ok", member: "forbidden", viewer: "forbidden", outsider: "no-access" } },
      { name: "member.invite", run: (c) => c.call("member.invite", { projectId: w.project.id, role: "viewer" }), expect: { owner: "ok", admin: "ok", member: "forbidden", viewer: "forbidden", outsider: "no-access" } },
      { name: "project.create", run: (c) => c.call("project.create", { teamId: w.fx.team.teamId, name: "New", mutationId: mid() }), expect: { owner: "ok", admin: "forbidden", member: "forbidden", viewer: "forbidden", outsider: "no-access" } },
      { name: "audit.list", run: (c) => c.call("audit.list", { teamId: w.fx.team.teamId }), expect: { owner: "ok", admin: "forbidden", member: "forbidden", viewer: "forbidden", outsider: "no-access" } },
      { name: "invitation.list", run: (c) => c.call("invitation.list", { teamId: w.fx.team.teamId }), expect: { owner: "ok", admin: "forbidden", member: "forbidden", viewer: "forbidden", outsider: "no-access" } },
      { name: "assign self", run: async (c) => {
          const me = await c.call("me");
          const team = me.teams.find((t: any) => t.id === w.fx.team.teamId);
          const t = await w.owner.call("sharedTask.publish", { projectId: w.project.id, title: "A", description: "", status: "ready", mutationId: mid() });
          return c.call("assignment.set", { taskId: t.id, memberId: team?.memberId ?? w.ids["Bob Member"], revision: 0, mutationId: mid() });
        }, expect: { owner: "ok", admin: "ok", member: "ok", viewer: "forbidden", outsider: "no-access" } },
    ];
    for (const row of matrix)
      for (const [role, client] of roles) {
        const want = row.expect[role]!;
        if (want === "ok") await row.run(client);
        else await code(row.run(client), want);
      }
    // Task updates: admins only, and with the current revision.
    const t = (await w.owner.call("changes.read", { projectId: w.project.id })).changes.find((c: any) => c.id === w.task.id).value;
    await code(w.member.call("sharedTask.update", { taskId: w.task.id, revision: t.revision, title: "x", mutationId: mid() }), "forbidden");
    const updated = await w.admin.call("sharedTask.update", { taskId: w.task.id, revision: t.revision, status: "review", mutationId: mid() });
    assert.equal(updated.revision, t.revision + 1);
    // Comments: edit own only; admins moderate (delete) with audit; members cannot touch others'.
    const byMember = await w.member.call("comment.create", { taskId: w.task.id, body: "member note", mutationId: mid() });
    const byAdmin = await w.admin.call("comment.create", { taskId: w.task.id, body: "admin note", mutationId: mid() });
    await code(w.admin.call("comment.edit", { commentId: byMember.id, revision: 1, body: "rewritten", mutationId: mid() }), "forbidden");
    await code(w.member.call("comment.delete", { commentId: byAdmin.id, revision: 1, mutationId: mid() }), "forbidden");
    await code(w.viewer.call("comment.delete", { commentId: byMember.id, revision: 1, mutationId: mid() }), "forbidden");
    const edited = await w.member.call("comment.edit", { commentId: byMember.id, revision: 1, body: "member note, edited", mutationId: mid() });
    assert.equal(edited.revision, 2);
    const moderated = await w.admin.call("comment.delete", { commentId: byMember.id, revision: 2, mutationId: mid() });
    assert.equal(moderated.deleted, true);
    assert.equal(moderated.body, "");
    assert.equal(moderated.authorName, "Bob Member", "authorship is kept after deletion");
    const audit = await w.owner.call("audit.list", { teamId: w.fx.team.teamId, limit: 200 });
    const entry = audit.find((a: any) => a.action === "comment.moderate");
    assert.ok(entry);
    assert.doesNotMatch(entry.detail, /member note/, "comment text never enters the audit log");
    // Assignments: members only themselves; admins anyone active and not a viewer.
    const fresh = await w.owner.call("sharedTask.publish", { projectId: w.project.id, title: "B", description: "", status: "ready", mutationId: mid() });
    await code(w.member.call("assignment.set", { taskId: fresh.id, memberId: w.ids["Dave Admin"], revision: 0, mutationId: mid() }), "forbidden");
    await code(w.admin.call("assignment.set", { taskId: fresh.id, memberId: w.ids["Carol Viewer"], revision: 0, mutationId: mid() }), "invalid");
    const a = await w.admin.call("assignment.set", { taskId: fresh.id, memberId: w.ids["Bob Member"], revision: 0, mutationId: mid() });
    assert.equal(a.memberName, "Bob Member");
    await code(w.member.call("assignment.clear", { taskId: fresh.id, revision: 0, mutationId: mid() }), "conflict");
    await w.member.call("assignment.clear", { taskId: fresh.id, revision: a.revision, mutationId: mid() });
    // Role changes and removal are admin actions.
    await code(w.member.call("member.setRole", { projectId: w.project.id, memberId: w.ids["Carol Viewer"], role: "member" }), "forbidden");
    await w.admin.call("member.setRole", { projectId: w.project.id, memberId: w.ids["Carol Viewer"], role: "member" });
    await w.viewer.call("comment.create", { taskId: w.task.id, body: "now I can", mutationId: mid() });
  } finally {
    await w.fx.close();
  }
});

test("viewers are read-only and pending invitations cannot be assigned", async () => {
  const w = await world();
  try {
    const writes = [
      () => w.viewer.call("comment.create", { taskId: w.task.id, body: "x", mutationId: mid() }),
      () => w.viewer.call("sharedTask.update", { taskId: w.task.id, revision: 1, title: "x", mutationId: mid() }),
      () => w.viewer.call("sharedTask.remove", { taskId: w.task.id, revision: 1, mutationId: mid() }),
      () => w.viewer.call("assignment.set", { taskId: w.task.id, memberId: w.ids["Carol Viewer"], revision: 0, mutationId: mid() }),
      () => w.viewer.call("member.invite", { projectId: w.project.id, role: "viewer" }),
      () => w.viewer.call("member.remove", { projectId: w.project.id, memberId: w.ids["Bob Member"] }),
      () => w.viewer.call("member.setRole", { projectId: w.project.id, memberId: w.ids["Bob Member"], role: "viewer" }),
    ];
    for (const write of writes) await code(write(), "forbidden");
    assert.ok((await w.viewer.call("changes.read", { projectId: w.project.id })).changes.length > 0);
    const pending = await w.owner.call("member.invite", { projectId: w.project.id, role: "member", email: "new@example.test" });
    const list = await w.owner.call("member.list", { projectId: w.project.id });
    const invited = list.find((m: any) => m.status === "invited");
    assert.ok(invited && pending.code);
    await code(w.owner.call("assignment.set", { taskId: w.task.id, memberId: invited.memberId, revision: 0, mutationId: mid() }), "invalid");
  } finally {
    await w.fx.close();
  }
});

test("cross-team references and guessed IDs get the same answer as no access", async () => {
  const w = await world();
  try {
    await code(w.owner.call("comment.create", { taskId: w.otherTask.id, body: "x", mutationId: mid() }), "no-access");
    await code(w.owner.call("changes.read", { projectId: w.otherProject.id }), "no-access");
    await code(w.owner.call("member.list", { projectId: w.otherProject.id }), "no-access");
    await code(w.owner.call("changes.read", { projectId: crypto.randomUUID() }), "no-access");
    await code(w.owner.call("comment.edit", { commentId: crypto.randomUUID(), revision: 1, body: "x", mutationId: mid() }), "no-access");
    // A member of another team is never a valid assignee here.
    await code(w.owner.call("assignment.set", { taskId: w.task.id, memberId: w.outsiderId, revision: 0, mutationId: mid() }), "invalid");
    await code(w.owner.call("member.setRole", { projectId: w.project.id, memberId: w.outsiderId, role: "admin" }), "no-access");
    await code(w.owner.call("member.remove", { teamId: w.fx.team.teamId, memberId: w.outsiderId }), "no-access");
    await code(w.outsider.call("member.invite", { teamId: w.fx.team.teamId, teamRole: "member" }), "no-access");
    await code(w.outsider.call("audit.list", { teamId: w.fx.team.teamId }), "no-access");
    // Non-UUID and unknown fields are rejected, not looked up.
    await code(w.owner.call("changes.read", { projectId: "../../etc" }), "no-access");
    await code(w.owner.call("comment.create", { taskId: w.task.id, body: "x", mutationId: mid(), projectId: w.otherProject.id }), "invalid");
  } finally {
    await w.fx.close();
  }
});

test("removal takes effect immediately, including for a request already in flight", async () => {
  let removeBeforeTransaction: string | null = null;
  const w = await world({
    beforeTransaction: async (who: { subject: string }, action: string) => {
      if (removeBeforeTransaction && who.subject === removeBeforeTransaction && action === "comment.create") {
        removeBeforeTransaction = null;
        // The owner removes the member after the request authenticated but before it commits.
        await w.owner.call("member.remove", { projectId: w.project.id, memberId: w.ids["Bob Member"] });
      }
    },
  });
  try {
    const assigned = await w.admin.call("assignment.set", { taskId: w.task.id, memberId: w.ids["Bob Member"], revision: 0, mutationId: mid() });
    const kept = await w.member.call("comment.create", { taskId: w.task.id, body: "before removal", mutationId: mid() });
    removeBeforeTransaction = "bob-sub";
    await code(w.member.call("comment.create", { taskId: w.task.id, body: "during removal", mutationId: mid() }), "no-access");
    await code(w.member.call("changes.read", { projectId: w.project.id }), "no-access");
    await code(w.member.call("comment.edit", { commentId: kept.id, revision: 1, body: "x", mutationId: mid() }), "no-access");
    // The assignment was cleared by policy; history keeps the author.
    const page = await w.owner.call("changes.read", { projectId: w.project.id, limit: 200 });
    const assignment = page.changes.filter((c: any) => c.kind === "assignment" && c.id === w.task.id).pop().value;
    assert.equal(assignment.memberId, null);
    assert.ok(assignment.revision > assigned.revision);
    const comments = (await w.owner.call("comment.list", { taskId: w.task.id })).comments;
    assert.equal(comments.find((c: any) => c.id === kept.id).authorName, "Bob Member");
    assert.ok(!comments.some((c: any) => c.body === "during removal"));
    // Removing from the whole team ends every project at once.
    await w.owner.call("member.remove", { teamId: w.fx.team.teamId, memberId: w.ids["Carol Viewer"] });
    await code(w.viewer.call("changes.read", { projectId: w.project.id }), "no-access");
    assert.equal((await w.viewer.call("me")).teams.length, 0);
  } finally {
    await w.fx.close();
  }
});

test("rate limits apply to comments and invitations", async () => {
  const w = await world({ limits: { comment: 3, invite: 5 } });
  try {
    for (let i = 0; i < 3; i++) await w.member.call("comment.create", { taskId: w.task.id, body: "n" + i, mutationId: mid() });
    await code(w.member.call("comment.create", { taskId: w.task.id, body: "too many", mutationId: mid() }), "rate-limited");
    // owner already sent 3 invitations in world(); 2 more are allowed
    await w.owner.call("member.invite", { projectId: w.project.id, role: "viewer" });
    await w.owner.call("member.invite", { projectId: w.project.id, role: "viewer" });
    await code(w.owner.call("member.invite", { projectId: w.project.id, role: "viewer" }), "rate-limited");
  } finally {
    await w.fx.close();
  }
});

test("no team token reaches terminal, file or owner-gateway APIs", async () => {
  const w = await world();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-team-gw-"));
  try {
    // The team API has no core command, and the core policy has no team command.
    for (const action of TEAM_ACTIONS) assert.ok(!(COMMANDS as readonly string[]).includes(action), action);
    assert.ok(!Object.keys(COMMAND_POLICY).some((c) => c.startsWith("team")));
    const token = (await w.fx.login("bob")).sessionToken;
    for (const action of ["session.input", "terminal.open", "files.read", "files.write", "git.commit", "snapshot", "project.add", "settings.read"]) {
      const res = await fetch(`${w.fx.service.url}/v1/call/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ sessionId: "s", data: "rm -rf ~\r" }),
      });
      assert.equal(res.status, 404, action);
    }
    for (const route of ["/api/ws", "/api/login", "/v1/../api/ws", "/v1/call/../../api/ws"]) {
      const res = await fetch(w.fx.service.url + route, { method: "POST", headers: { authorization: "Bearer " + token } });
      assert.equal(res.status, 404, route);
    }
    // The owner gateway does not recognize a team token as a cookie or bearer credential.
    const calls: string[] = [];
    const gateway = await startGateway({
      dataDir,
      port: 0,
      allowedProjectIds: ["p"],
      invoke: async (command: any) => {
        calls.push(command);
        return { projects: [], tasks: [], attempts: [], sessions: [], notes: [], layouts: [], boardLanes: [], capabilities: [] };
      },
      subscribe: () => () => {},
    });
    try {
      const url = gateway.status().url;
      const pair = await fetch(url + "/api/login", {
        method: "POST",
        headers: { origin: url, "content-type": "application/json" },
        body: JSON.stringify({ secret: await gateway.pairingSecret() }),
      });
      const cookieName = pair.headers.get("set-cookie")!.split("=")[0];
      const status = async (headers: Record<string, string>) =>
        ((await (await fetch(url + "/api/status", { headers })).json()) as any).authenticated;
      assert.equal(await status({ cookie: `${cookieName}=${token}` }), false);
      assert.equal(await status({ authorization: "Bearer " + token }), false);
      const ws = new WebSocket(url.replace("http", "ws") + "/api/ws", { origin: url, headers: { cookie: `${cookieName}=${token}`, authorization: "Bearer " + token } });
      const outcome = await new Promise((resolve) => {
        ws.on("open", () => resolve("open"));
        ws.on("error", () => resolve("refused"));
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      });
      assert.notEqual(outcome, "open");
      ws.terminate();
      assert.deepEqual(calls.filter((c) => c !== "snapshot"), [], "no core command ran for a team token");
    } finally {
      await gateway.stop();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    await w.fx.close();
  }
});
