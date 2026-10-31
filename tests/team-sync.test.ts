import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { teamFixture } from "./team-fixture.js";
import { createCore } from "../src/core/index.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/core/migrations.js";
import { TEAM_OUTBOX_LIMIT } from "../src/core/team-cache.js";
import { createTeamDesktop, type SecretStore } from "../src/desktop/team.js";
import { CommentItem } from "../src/renderer/TaskComments.js";
import type { Core } from "../src/shared/contracts.js";
import type { TeamSessionTokens } from "../src/shared/team-contracts.js";

const mid = () => crypto.randomUUID();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A desktop: its own core (workspace.sqlite), in-memory secret store and a switchable network. */
async function desktop(fx: Awaited<ReturnType<typeof teamFixture>>, user: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-team-desk-"));
  const core: Core = await createCore({ dataDir: path.join(dir, "data"), emit: () => {} });
  let secret: { serviceUrl: string; tokens: TeamSessionTokens } | null = null;
  const secrets: SecretStore = {
    status: () => ({ available: true, backend: "test", detail: "" }),
    read: () => secret,
    write: (v) => void (secret = v),
  };
  const net = { offline: false, loseNextResponseFor: "" };
  const fetchImpl: typeof fetch = async (input, init) => {
    if (net.offline) throw new TypeError("fetch failed");
    const res = await fetch(input, init);
    if (net.loseNextResponseFor && String(input).endsWith(net.loseNextResponseFor)) {
      net.loseNextResponseFor = "";
      await res.text();
      throw new TypeError("connection reset after the request was sent");
    }
    return res;
  };
  const team = createTeamDesktop({
    store: (action, payload = {}) => core.team(action, payload) as Promise<any>,
    secrets,
    openUrl: async (url) => {
      const u = new URL(url);
      u.searchParams.set("login_hint", user);
      await (await fetch(u)).text();
    },
    emit: () => {},
    fetchImpl,
    syncIntervalMs: 3_600_000,
  });
  const call = (action: string, value: unknown = {}) => team.handle(action, value) as Promise<any>;
  const project = (await core.invoke("project.add", { path: dir })) as { id: string };
  return {
    core,
    team,
    call,
    net,
    project,
    secret: () => secret,
    async close() {
      team.dispose();
      await core.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Owner publishes a folder and a task; Bob joins as a member. */
async function scenario(options = {}) {
  const fx = await teamFixture(options);
  const owner = await desktop(fx, "alice");
  await owner.call("connect", { serviceUrl: fx.service.url, invitation: fx.team.code });
  await owner.call("publishProject", { projectId: owner.project.id, teamId: fx.team.teamId, name: "Web" });
  const status = await owner.call("status");
  const teamProject = status.projects.find((p: any) => p.localProjectId === owner.project.id);
  const task = (await owner.core.invoke("task.create", {
    projectId: owner.project.id,
    title: "Ship login",
    description: "Use the staging IdP",
  })) as any;
  const preview = await owner.call("previewTask", { taskId: task.id });
  const entry = await owner.call("publishTask", { taskId: task.id, hash: preview.hash });
  const invitation = await owner.call("invite", { teamProjectId: teamProject.id, role: "member" });
  const bob = await desktop(fx, "bob");
  await bob.call("connect", { serviceUrl: fx.service.url, invitation: invitation.code });
  return { fx, owner, bob, teamProject, task, preview, entry };
}

test("schema: team metadata is the next named migration and leaves local records alone", async () => {
  const names = MIGRATIONS.map((m) => m.name);
  assert.ok(names.includes("roadmap_05_team_metadata"));
  assert.equal(MIGRATIONS.find((m) => m.name === "roadmap_05_team_metadata")!.version, names.indexOf("roadmap_05_team_metadata") + 1);
  assert.ok(names.indexOf("roadmap_05_team_metadata") > names.indexOf("roadmap_03_execution_hosts"));
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
});

test("publishing sends only the previewed title, description and status; the board shows team state", async () => {
  const s = await scenario();
  try {
    assert.deepEqual(Object.keys(s.preview.fields), ["title", "description", "status"]);
    assert.deepEqual(JSON.parse(s.preview.json), { title: "Ship login", description: "Use the staging IdP", status: "backlog" });
    assert.doesNotMatch(s.preview.json, /aw-team-desk|projectId|path|prompt|session/);
    assert.equal(s.entry.sync, "synced");
    // What the service stored is exactly the preview.
    const row = s.fx.service.db.prepare("SELECT * FROM shared_tasks").get() as any;
    assert.deepEqual([row.title, row.description, row.status], ["Ship login", "Use the staging IdP", "backlog"]);
    // A local edit is not sent until previewed again; a stale preview is refused.
    const edited = (await s.owner.core.invoke("task.update", { taskId: s.task.id, revision: s.task.revision, status: "in_progress" })) as any;
    let board = await s.owner.call("boardInfo", { projectId: s.owner.project.id });
    assert.equal(board[s.task.id].sync, "local-changes");
    await assert.rejects(s.owner.call("publishTask", { taskId: s.task.id, hash: s.preview.hash }), /changed after the preview/);
    const again = await s.owner.call("previewTask", { taskId: s.task.id });
    await s.owner.call("publishTask", { taskId: s.task.id, hash: again.hash });
    board = await s.owner.call("boardInfo", { projectId: s.owner.project.id });
    assert.equal(board[s.task.id].sync, "synced");
    assert.equal((s.fx.service.db.prepare("SELECT status, revision FROM shared_tasks").get() as any).status, "in_progress");
    // The local task itself is untouched by team sync.
    const snapshot = (await s.owner.core.invoke("snapshot")) as any;
    assert.deepEqual(snapshot.tasks.find((t: any) => t.id === s.task.id), edited);
    // The core snapshot (what the owner gateway projects) carries no team data, and no token reaches the core.
    assert.doesNotMatch(JSON.stringify(snapshot), /tst_|tsr_|sharedTask|teamProject|assignee/i);
    const state = (await s.owner.core.team("state")) as any;
    assert.doesNotMatch(JSON.stringify(state), /tst_|tsr_/);
    assert.match(s.owner.secret()!.tokens.sessionToken, /^tst_/);
    // Bob sees it, comments, assigns himself; the owner's board follows.
    const bobStatus = await s.bob.call("status");
    assert.equal(bobStatus.projects[0].role, "member");
    const shared = await s.bob.call("sharedTasks", { teamProjectId: s.teamProject.id });
    assert.equal(shared[0].title, "Ship login");
    const detail = await s.bob.call("addComment", { sharedTaskId: shared[0].id, body: "On it" });
    assert.equal(detail.comments.length, 1);
    const me = detail.meMemberId;
    const assigned = await s.bob.call("assign", { sharedTaskId: shared[0].id, memberId: me });
    assert.equal(assigned.assignment.memberName, "Bob Member");
    await s.owner.call("sync");
    board = await s.owner.call("boardInfo", { projectId: s.owner.project.id });
    assert.equal(board[s.task.id].assignee, "Bob Member");
    assert.equal(board[s.task.id].commentCount, 1);
  } finally {
    await s.bob.close();
    await s.owner.close();
    await s.fx.close();
  }
});

test("offline comments queue visibly; a lost acknowledgement never duplicates a comment", async () => {
  const s = await scenario();
  try {
    const sharedTaskId = s.entry.sharedTaskId;
    s.bob.net.offline = true;
    const queued = await s.bob.call("addComment", { sharedTaskId, body: "Written on a plane" });
    const pending = queued.comments.filter((c: any) => c.pending);
    assert.equal(pending.length, 1);
    assert.equal((await s.bob.call("status")).outbox[0].state, "pending");
    const board = (await s.bob.core.team("sharedTasks", { teamProjectId: s.teamProject.id })) as any[];
    assert.equal(board[0].commentCount, 1, "the pending comment is counted and visible");
    s.bob.net.offline = false;
    // The service stores the comment but the response is lost: the outbox keeps the same mutation ID.
    s.bob.net.loseNextResponseFor = "/v1/call/comment.create";
    await s.bob.call("sync");
    assert.equal((await s.bob.call("status")).outbox.length, 1);
    assert.equal((s.fx.service.db.prepare("SELECT COUNT(*) AS n FROM comments").get() as any).n, 1);
    await s.bob.call("sync");
    assert.equal((await s.bob.call("status")).outbox.length, 0);
    assert.equal((s.fx.service.db.prepare("SELECT COUNT(*) AS n FROM comments").get() as any).n, 1, "the resend was recognized");
    const detail = await s.bob.call("taskDetail", { sharedTaskId });
    assert.deepEqual(detail.comments.map((c: any) => [c.body, !!c.pending]), [["Written on a plane", false]]);
    // The outbox is bounded.
    s.bob.net.offline = true;
    for (let i = 0; i < TEAM_OUTBOX_LIMIT - 0; i++)
      await s.bob.core.team("outboxAdd", { mutationId: mid(), teamProjectId: s.teamProject.id, action: "comment.create", payload: { taskId: sharedTaskId, body: "x" }, summary: "Comment", target: sharedTaskId });
    await assert.rejects(s.bob.call("addComment", { sharedTaskId, body: "one too many" }), /Too many unsent/);
    // Terminal actions can never be queued.
    await assert.rejects(
      s.bob.core.team("outboxAdd", { mutationId: mid(), teamProjectId: s.teamProject.id, action: "session.input", payload: {}, summary: "x" }),
      /Only team metadata/,
    );
  } finally {
    await s.bob.close();
    await s.owner.close();
    await s.fx.close();
  }
});

test("a stale edit becomes a visible conflict and is resolved deliberately", async () => {
  const s = await scenario();
  try {
    const sharedTaskId = s.entry.sharedTaskId;
    const first = await s.bob.call("addComment", { sharedTaskId, body: "v1" });
    const comment = first.comments[0];
    // Bob edits on another device first (revision 1 -> 2).
    const other = s.fx.client(await s.fx.login("bob"));
    await other.call("comment.edit", { commentId: comment.id, revision: 1, body: "v2 from laptop", mutationId: mid() });
    // This desktop still has revision 1 cached: queue offline so no pull happens before sending.
    s.bob.net.offline = true;
    await s.bob.call("editComment", { commentId: comment.id, body: "v2 from desktop" });
    s.bob.net.offline = false;
    await s.bob.team.handle("sync", {});
    let status = await s.bob.call("status");
    assert.equal(status.outbox.length, 1);
    assert.equal(status.outbox[0].state, "conflict");
    const board = await s.bob.call("taskDetail", { sharedTaskId });
    assert.equal(board.comments[0].body, "v2 from laptop", "nothing was overwritten silently");
    await s.bob.call("resolve", { mutationId: status.outbox[0].mutationId, choice: "retry" });
    status = await s.bob.call("status");
    assert.equal(status.outbox.length, 0);
    assert.equal((await s.bob.call("taskDetail", { sharedTaskId })).comments[0].body, "v2 from desktop");
    // Assignment conflicts are not resolved silently either.
    s.bob.net.offline = true;
    await s.bob.call("assign", { sharedTaskId, memberId: (await s.bob.call("taskDetail", { sharedTaskId })).meMemberId });
    s.bob.net.offline = false;
    const admin = s.fx.client(await s.fx.login("alice"));
    const members = await admin.call("member.list", { projectId: s.teamProject.id });
    await admin.call("assignment.set", { taskId: sharedTaskId, memberId: members.find((m: any) => m.name === "Alice Owner").memberId, revision: 0, mutationId: mid() });
    await s.bob.call("sync");
    status = await s.bob.call("status");
    // Members may only take unassigned tasks: the queued self-assignment is refused, kept visible, never applied.
    assert.equal(status.outbox[0].state, "failed");
    assert.match(status.outbox[0].error, /role does not allow/);
    await s.bob.call("resolve", { mutationId: status.outbox[0].mutationId, choice: "discard" });
    assert.equal((await s.bob.call("taskDetail", { sharedTaskId })).assignment.memberName, "Alice Owner");
    // The owner's republish after another admin's change is refused, then succeeds on review.
    await admin.call("sharedTask.update", { taskId: sharedTaskId, revision: 1, title: "Renamed by admin", mutationId: mid() });
    const t = (await s.owner.core.invoke("task.update", { taskId: s.task.id, revision: s.task.revision, title: "Ship login v2" })) as any;
    const p = await s.owner.call("previewTask", { taskId: t.id });
    await assert.rejects(s.owner.call("publishTask", { taskId: t.id, hash: p.hash }), /changed on the team service/);
    await s.owner.call("publishTask", { taskId: t.id, hash: (await s.owner.call("previewTask", { taskId: t.id })).hash });
  } finally {
    await s.bob.close();
    await s.owner.close();
    await s.fx.close();
  }
});

test("ordered cursors page through changes; stale and unordered pages are ignored or refused", async () => {
  const s = await scenario({ limits: { comment: 1000 } });
  try {
    const sharedTaskId = s.entry.sharedTaskId;
    const owner = s.fx.client(await s.fx.login("alice"));
    for (let i = 0; i < 230; i++) await owner.call("comment.create", { taskId: sharedTaskId, body: "c" + i, mutationId: mid() });
    await s.bob.call("sync");
    const detail = await s.bob.call("taskDetail", { sharedTaskId });
    assert.equal(detail.comments.length, 230);
    assert.equal(detail.comments[0].body, "c0");
    assert.equal(detail.comments[229].body, "c229");
    const maxSeq = (s.fx.service.db.prepare("SELECT MAX(seq) AS m FROM changes WHERE project_id=?").get(s.teamProject.id) as any).m;
    const project = (await s.bob.call("status")).projects[0];
    assert.equal(project.cursor, maxSeq);
    // comment.list pagination on the service.
    const page1 = await owner.call("comment.list", { taskId: sharedTaskId, limit: 100 });
    const page2 = await owner.call("comment.list", { taskId: sharedTaskId, after: page1.cursor, limit: 100 });
    const page3 = await owner.call("comment.list", { taskId: sharedTaskId, after: page2.cursor, limit: 100 });
    assert.deepEqual([page1.comments.length, page2.comments.length, page3.comments.length, page3.more], [100, 100, 30, false]);
    // A replayed old page (after != cursor) is ignored.
    const old = await owner.call("changes.read", { projectId: s.teamProject.id, after: 0, limit: 5 });
    assert.deepEqual(await s.bob.core.team("apply", { teamProjectId: s.teamProject.id, after: 0, page: old }), { applied: 0, ignored: "stale" });
    // Unordered sequence numbers are refused.
    const bad = { ...old, changes: [...old.changes].reverse(), cursor: maxSeq + 10 };
    await assert.rejects(s.bob.core.team("apply", { teamProjectId: s.teamProject.id, after: maxSeq, page: bad }), /Unordered/);
  } finally {
    await s.bob.close();
    await s.owner.close();
    await s.fx.close();
  }
});

test("a malicious comment stays plain text end to end", async () => {
  const s = await scenario();
  try {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script> [link](javascript:alert(3)) ‮evil\u0007\u001b[31m';
    await s.bob.call("addComment", { sharedTaskId: s.entry.sharedTaskId, body: evil });
    await s.owner.call("sync");
    const detail = await s.owner.call("taskDetail", { sharedTaskId: s.entry.sharedTaskId });
    const body = detail.comments[0].body;
    assert.ok(body.includes('<img src=x onerror="alert(1)">'), "markup is kept as literal text");
    assert.doesNotMatch(body, /[‮\u0007\u001b]/, "control and bidi-override characters are removed");
    const html = renderToStaticMarkup(createElement(CommentItem, { comment: detail.comments[0], canEdit: false, canDelete: false }));
    assert.doesNotMatch(html, /<img|<script/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&lt;script&gt;/);
    assert.doesNotMatch(html, /href=/);
  } finally {
    await s.bob.close();
    await s.owner.close();
    await s.fx.close();
  }
});

test("revocation purges the cache and removed scope never comes back", async () => {
  const s = await scenario();
  try {
    const sharedTaskId = s.entry.sharedTaskId;
    await s.bob.call("addComment", { sharedTaskId, body: "mine" });
    const before = await s.bob.call("taskDetail", { sharedTaskId });
    const memberId = before.meMemberId;
    // A deleted comment is tombstoned; a stale page cannot bring it back.
    const doomed = (await s.owner.call("addComment", { sharedTaskId, body: "to delete" })).comments.find((c: any) => c.body === "to delete");
    await s.bob.call("sync");
    const stalePage = await s.fx.client(await s.fx.login("bob")).call("changes.read", { projectId: s.teamProject.id, after: 0, limit: 200 });
    await s.owner.call("deleteComment", { commentId: doomed.id });
    await s.bob.call("sync");
    assert.ok(!(await s.bob.call("taskDetail", { sharedTaskId })).comments.some((c: any) => c.id === doomed.id));
    const cursor = (await s.bob.call("status")).projects[0].cursor;
    const replay = {
      ...stalePage,
      cursor: cursor + 1000,
      changes: stalePage.changes.filter((c: any) => c.id === doomed.id).map((c: any, i: number) => ({ ...c, seq: cursor + 1 + i })),
    };
    assert.equal(replay.changes.length, 1);
    await s.bob.core.team("apply", { teamProjectId: s.teamProject.id, after: cursor, page: replay });
    assert.ok(!(await s.bob.call("taskDetail", { sharedTaskId })).comments.some((c: any) => c.id === doomed.id), "no resurrection");
    // Queue something offline, then lose access.
    s.bob.net.offline = true;
    await s.bob.call("addComment", { sharedTaskId, body: "queued before removal" });
    s.bob.net.offline = false;
    await s.owner.call("removeMember", { teamProjectId: s.teamProject.id, memberId });
    await s.bob.call("sync");
    const status = await s.bob.call("status");
    assert.equal(status.projects[0].state, "revoked");
    assert.equal(status.outbox.length, 0, "access is revalidated before anything queued is sent");
    assert.ok(status.notices.some((n: string) => /access to a team project ended/.test(n)));
    const cache = (await s.bob.core.team("cache", { teamProjectId: s.teamProject.id })) as any;
    assert.deepEqual([cache.tasks.length, cache.comments.length, cache.assignments.length, cache.members.length], [0, 0, 0, 0]);
    await assert.rejects(s.bob.call("taskDetail", { sharedTaskId }), /not available/);
    assert.ok(!(s.fx.service.db.prepare("SELECT body FROM comments").all() as any[]).some((c) => c.body === "queued before removal"));
    // A stale page for the revoked project is ignored.
    assert.deepEqual(await s.bob.core.team("apply", { teamProjectId: s.teamProject.id, after: 0, page: stalePage }), { applied: 0, ignored: "revoked" });
    assert.equal(((await s.bob.core.team("cache", { teamProjectId: s.teamProject.id })) as any).tasks.length, 0);
    // The owner's board keeps working and the local task is untouched.
    const ownerBoard = await s.owner.call("boardInfo", { projectId: s.owner.project.id });
    assert.equal(ownerBoard[s.task.id].sync, "synced");
    // Disconnect removes this computer's team data and the stored session.
    await s.owner.call("disconnect");
    assert.equal(s.owner.secret(), null);
    const after = (await s.owner.core.team("state")) as any;
    assert.deepEqual([after.link, after.projects.length, after.outbox.length], [null, 0, 0]);
    assert.equal(((await s.owner.core.invoke("snapshot")) as any).tasks.length, 1);
  } finally {
    await s.bob.close();
    await s.owner.close();
    await s.fx.close();
  }
});

test("the desktop refuses to sign in without secure storage and rejects unknown actions", async () => {
  const fx = await teamFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-team-desk-"));
  const core = await createCore({ dataDir: dir, emit: () => {} });
  try {
    const team = createTeamDesktop({
      store: (a, p = {}) => core.team(a, p) as Promise<any>,
      secrets: { status: () => ({ available: false, backend: "basic_text", detail: "No keyring" }), read: () => null, write: () => assert.fail("must not write") },
      openUrl: () => assert.fail("must not open a browser"),
      emit: () => {},
    });
    await assert.rejects(team.handle("connect", { serviceUrl: fx.service.url }), /No keyring/);
    await assert.rejects(team.handle("connect", { serviceUrl: "http://team.example.com" }), /HTTPS/);
    await assert.rejects(team.handle("exec", {}), /Unsupported team action/);
    await assert.rejects(team.handle("status", { token: "x" }), /Unexpected/);
    await assert.rejects(core.team("setLink", { link: { serviceUrl: "x", identity: { issuer: "i", subject: "s", name: "", email: "" }, teams: [], sessionToken: "tst_x" } }), /Unexpected/);
    await assert.rejects(core.invoke("team" as any, {}), /Unsupported command/);
    team.dispose();
    await wait(10);
  } finally {
    await core.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await fx.close();
  }
});
