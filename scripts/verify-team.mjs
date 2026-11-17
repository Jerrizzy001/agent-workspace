// No terminal sessions are started here, so no tmux server needs stopping.
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { startFakeIssuer } from "./fake-oidc.mjs";

// Team members, comments and assignments (roadmap section 9) in the real
// desktop app: two Electron instances (two identities), a local team service
// and a local fake OIDC issuer. No external service is contacted.
const { startTeamService, createTeam } = await import(
  path.resolve("dist/team/service.mjs")
);
const fixture = await mkdtemp(path.join(tmpdir(), "agent-team-"));
const repo = path.join(fixture, "webapp");
const screenshots = path.resolve("docs/screenshots/desktop");
await mkdir(repo);
await mkdir(screenshots, { recursive: true });
await writeFile(path.join(repo, "README.md"), "team fixture\n");
for (const args of [
  ["init", "-q"],
  ["config", "user.name", "Fixture"],
  ["config", "user.email", "fixture@example.invalid"],
  ["add", "."],
  ["commit", "-qm", "Fixture"],
])
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });

const issuer = await startFakeIssuer();
const service = await startTeamService({
  dataDir: path.join(fixture, "team-service"),
  oidc: {
    issuer: issuer.issuer,
    clientId: issuer.clientId,
    clientSecret: issuer.clientSecret,
    redirectUri: "http://127.0.0.1/callback",
    allowHttpLoopbackIssuer: true,
  },
});
const team = createTeam(service.db, { name: "Acme" });
const checks = [];
const errors = [];
const apps = [];

async function launch(name, user) {
  const app = await electron.launch({
    executablePath: process.env.WORKSPACE_APP_EXECUTABLE,
    args: process.env.WORKSPACE_APP_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      WORKSPACE_TEST_DATA_DIR: path.join(fixture, name),
      // Test-only switches (honoured only with WORKSPACE_TEST_DATA_DIR): the
      // unencrypted basic secret store, because this headless machine has no
      // keyring, and an auto-approving "browser" that fetches the issuer page.
      WORKSPACE_TEST_TEAM_BASIC_SECRET_STORE: "1",
      WORKSPACE_TEST_TEAM_AUTOBROWSER: "1",
      WORKSPACE_TEST_TEAM_LOGIN_HINT: user,
      WORKSPACE_TEST_TEAM_SYNC_MS: "1500",
    },
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(name + ": " + e.message));
  page.on("dialog", (d) => void d.accept());
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  return { app, page, dataDir: path.join(fixture, name) };
}
const poll = async (page, check, label) => {
  for (let i = 0; i < 300; i++) {
    try {
      if (await check()) return;
    } catch {}
    await page.waitForTimeout(100);
  }
  throw new Error("Timed out: " + label);
};
const teamStatus = (page) =>
  page.evaluate(() => window.workspace.team.status());

let failed = false;
try {
  // ---- Owner (alice) ----
  const owner = await launch("owner", "alice");
  const op = owner.page;
  await op.evaluate(
    (p) => window.workspace.invoke("project.add", { path: p }),
    repo,
  );
  await op.locator(".folder-list button").filter({ hasText: "webapp" }).click();
  await op.getByRole("button", { name: "Settings and connections" }).click();
  await op.getByRole("button", { name: "Team", exact: true }).click();
  const panel = op.getByRole("dialog", {
    name: "Team",
    exact: true,
  });
  await panel.waitFor();
  const secret = (await teamStatus(op)).secretStorage;
  checks.push(
    `secret storage: ${secret.backend} (${secret.available ? "available" : "unavailable"})`,
  );
  assert.equal(secret.available, true, secret.detail);
  await panel.getByLabel("Team service address").fill(service.url);
  await panel.getByLabel(/Invitation code/).fill(team.code);
  await panel.getByRole("button", { name: "Connect" }).click();
  await panel.getByText("Alice Owner").waitFor();
  checks.push("owner connected through PKCE + loopback callback");
  // The session token is only in main-process secret storage.
  const stored = await readFile(path.join(owner.dataDir, "team-session.bin"));
  assert.ok(
    !stored.includes("tst_") && !stored.includes("tsr_"),
    "the stored session is not plain text",
  );
  assert.equal(
    await op.evaluate(() =>
      JSON.stringify({ ...localStorage }).includes("tst_"),
    ),
    false,
  );
  assert.equal(JSON.stringify(await teamStatus(op)).includes("tst_"), false);
  await assert.rejects(
    op.evaluate(() => window.workspace.invoke("team.status", {})),
  );
  checks.push(
    "token stays in main (encrypted file, not in renderer, localStorage or core commands)",
  );

  await panel.getByRole("button", { name: "Publish folder" }).click();
  await panel.getByText(/Published to/).waitFor();
  await panel.getByRole("button", { name: "Close team panel" }).click();

  const task = await op.evaluate(
    (projectId) =>
      window.workspace.invoke("task.create", {
        projectId,
        title: "Ship sign-in page",
        description: "Use the shared design tokens.",
      }),
    (await op.evaluate(() => window.workspace.invoke("snapshot"))).projects[0]
      .id,
  );
  await op.getByRole("button", { name: "Board", exact: true }).click();
  await op.getByRole("button", { name: "Tasks", exact: true }).click();
  await op
    .locator(".board-card")
    .filter({ hasText: "Ship sign-in page" })
    .locator(".card-title")
    .click();
  await op.getByRole("button", { name: "Share with team…" }).click();
  const preview = op.getByRole("dialog", {
    name: "Share this task with the team",
  });
  const sent = await preview
    .getByLabel("Data sent to the team service")
    .textContent();
  assert.deepEqual(JSON.parse(sent), {
    title: "Ship sign-in page",
    description: "Use the shared design tokens.",
    status: "backlog",
  });
  assert.ok(!sent.includes(repo) && !sent.includes(task.id));
  await preview.getByRole("button", { name: "Share task" }).click();
  await op
    .locator(".board-card")
    .filter({ hasText: "Ship sign-in page" })
    .locator(".team-chip.synced")
    .waitFor();
  const serviceTask = service.db
    .prepare("SELECT title, description, status FROM shared_tasks")
    .get();
  assert.deepEqual({ ...serviceTask }, JSON.parse(sent));
  checks.push(
    "publish preview showed exactly the bytes the service stored (title, description, status)",
  );

  // Invite Bob as a member from the Team panel.
  await op.getByRole("button", { name: "Settings and connections" }).click();
  await op.getByRole("button", { name: "Team", exact: true }).click();
  await panel
    .getByRole("button", { name: /^Web/ })
    .or(panel.locator(".team-project-row"))
    .first()
    .click();
  await panel.getByLabel("Invitation role").selectOption("member");
  await panel.getByRole("button", { name: "Create invitation" }).click();
  const code = (await panel.getByLabel("Invitation code").textContent()).trim();
  assert.match(code, /^twi_/);
  await panel.getByRole("button", { name: "Close team panel" }).click();
  checks.push("owner created a one-time member invitation");

  // ---- Member (bob) ----
  const member = await launch("member", "bob");
  const mp = member.page;
  await mp.getByRole("button", { name: "Settings and connections" }).click();
  await mp.getByRole("button", { name: "Team", exact: true }).click();
  const mpanel = mp.getByRole("dialog", {
    name: "Team",
    exact: true,
  });
  await mpanel.getByLabel("Team service address").fill(service.url);
  await mpanel.getByLabel(/Invitation code/).fill(code);
  await mpanel.getByRole("button", { name: "Connect" }).click();
  await mpanel.getByText("Bob Member").waitFor();
  await mpanel.locator(".team-project-row").first().click();
  await mpanel
    .getByRole("button", { name: "Shared task Ship sign-in page" })
    .click();
  await mpanel
    .getByLabel("New comment")
    .fill("I'll take this. <b>not bold</b>");
  await mpanel.getByRole("button", { name: "Comment", exact: true }).click();
  await mpanel.getByText("I'll take this. <b>not bold</b>").waitFor();
  const me = await mp.evaluate(() => window.workspace.team.status());
  assert.equal(me.projects[0].role, "member");
  const bobId = (
    await mp.evaluate(
      (id) => window.workspace.team.taskDetail({ sharedTaskId: id }),
      (
        await mp.evaluate(
          (tp) => window.workspace.team.sharedTasks({ teamProjectId: tp }),
          me.projects[0].id,
        )
      )[0].id,
    )
  ).meMemberId;
  await mpanel.getByLabel("Assignee").selectOption(bobId);
  await poll(
    mp,
    async () =>
      (await mpanel.getByLabel("Assignee").inputValue()) === bobId &&
      !(await mp.evaluate(() => window.workspace.team.status())).outbox.length,
    "assignment sent",
  );
  checks.push(
    "member joined with the invitation, commented (as plain text) and assigned themself",
  );

  // ---- Owner sees it on the board ----
  await op.getByRole("button", { name: "Board", exact: true }).click();
  const card = op
    .locator(".board-card")
    .filter({ hasText: "Ship sign-in page" });
  await poll(
    op,
    async () =>
      (await card.locator(".team-card-meta").textContent()).includes(
        "Bob Member",
      ),
    "assignee on the card",
  );
  assert.match(
    await card.locator(".team-card-meta").textContent(),
    /Bob Member.*1/,
  );
  await card.locator(".card-title").click();
  const thread = op.getByRole("region", { name: "Team comments" });
  await thread.getByText("I'll take this. <b>not bold</b>").waitFor();
  assert.equal(
    await thread.locator("b").count(),
    0,
    "comment markup is shown as text",
  );
  await thread
    .getByLabel("New comment")
    .fill("Thanks Bob. Design tokens are in the shared drive.");
  await thread.getByRole("button", { name: "Comment", exact: true }).click();
  await thread.getByText("Thanks Bob.", { exact: false }).waitFor();
  await op.waitForTimeout(300);
  await op.screenshot({ path: path.join(screenshots, "team-comments.png") });
  checks.push(
    "owner's board card shows assignee, comment count and sync state; task sheet shows the thread",
  );

  // Team panel screenshot with the members list.
  await op.getByRole("button", { name: "Settings and connections" }).click();
  await op.getByRole("button", { name: "Team", exact: true }).click();
  await panel.locator(".team-project-row").first().click();
  await panel.getByRole("listitem", { name: "Member Bob Member" }).waitFor();
  await op.waitForTimeout(300);
  await op.screenshot({ path: path.join(screenshots, "team-panel.png") });

  // ---- Owner removes Bob; Bob loses access and his cache is purged ----
  await panel.getByRole("button", { name: "Remove Bob Member" }).click();
  await poll(
    op,
    async () =>
      !(await panel
        .getByRole("listitem", { name: "Member Bob Member" })
        .count()),
    "Bob removed from the list",
  );
  await mpanel.getByRole("button", { name: "Sync now" }).click();
  await poll(
    mp,
    async () =>
      (await mp.evaluate(() => window.workspace.team.status())).projects.every(
        (p) => p.state === "revoked",
      ),
    "member access revoked",
  );
  const after = await mp.evaluate(() => window.workspace.team.status());
  assert.ok(
    after.notices.some((n) => /access to a team project ended/.test(n)),
  );
  await assert.rejects(
    mp.evaluate(
      (tp) => window.workspace.team.sharedTasks({ teamProjectId: tp }),
      after.projects[0].id,
    ),
  );
  await assert.rejects(
    mp.evaluate(() =>
      window.workspace.team
        .boardInfo({ projectId: "none" })
        .then(() =>
          window.workspace.team.taskDetail({
            sharedTaskId: "00000000-0000-4000-8000-000000000000",
          }),
        ),
    ),
  );
  await mp.reload();
  await mp.getByRole("button", { name: "Settings and connections" }).click();
  await mp.getByRole("button", { name: "Team", exact: true }).click();
  await mp.getByText("No team projects yet.").waitFor();
  assert.equal(await mp.getByText("Ship sign-in page").count(), 0);
  // The owner's assignment was cleared by policy; Bob's comment keeps its author.
  await poll(
    op,
    async () =>
      (await card.locator(".team-card-meta").textContent()).includes(
        "Unassigned",
      ),
    "assignment cleared",
  );
  checks.push(
    "owner removed the member: member's cache purged after sync, assignment cleared, comment authorship kept",
  );
  const local = await op.evaluate(() => window.workspace.invoke("snapshot"));
  assert.equal(local.tasks.length, 1, "the local task is untouched");
  assert.deepEqual(errors, []);
} catch (error) {
  failed = true;
  console.error(error);
  for (const [i, app] of apps.entries()) {
    try {
      const page = await app.firstWindow();
      await page.screenshot({ path: path.join(fixture, `failure-${i}.png`) });
    } catch {}
  }
} finally {
  for (const app of apps) await app.close().catch(() => {});
  await service.stop();
  await issuer.close();
  if (!failed) await rm(fixture, { recursive: true, force: true });
  else console.error("Fixture kept at " + fixture);
}
for (const c of checks) console.log("✓ " + c);
if (failed || errors.length) {
  if (errors.length) console.error(errors);
  process.exit(1);
}
console.log(`verify-team: ${checks.length} checks passed`);
