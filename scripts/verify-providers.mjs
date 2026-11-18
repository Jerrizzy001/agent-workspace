import { workspaceSocket } from "../src/core/socket.ts";
import { cleanupFixture } from "./fixture-cleanup.mjs";
import { _electron as electron } from "playwright";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const models = JSON.parse(process.env.WORKSPACE_VERIFY_MODELS || "{}");
const fixture = await mkdtemp(path.join(tmpdir(), "workspace-provider-"));
const repo = path.join(fixture, "repo");
await mkdir(repo);
await writeFile(
  path.join(repo, "README.md"),
  "Disposable provider integration fixture.\n",
);
for (const args of [
  ["init"],
  ["config", "user.email", "fixture@example.invalid"],
  ["config", "user.name", "Fixture"],
  ["add", "."],
  ["commit", "-m", "fixture"],
])
  execFileSync("git", args, { cwd: repo });
let app;
let page;
let invoke;
const sessions = [];
async function open() {
  app = await electron.launch({
    ...(process.env.WORKSPACE_APP_EXECUTABLE
      ? { executablePath: process.env.WORKSPACE_APP_EXECUTABLE }
      : { args: ["."] }),
    env: {
      ...process.env,
      WORKSPACE_TEST_DATA_DIR: path.join(fixture, "data"),
    },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.workspace);
  invoke = (command, payload = {}) =>
    page.evaluate(
      ({ command, payload }) => window.workspace.invoke(command, payload),
      { command, payload },
    );
}
try {
  await open();
  const project = await invoke("project.add", { path: repo });
  for (const provider of (
    process.env.WORKSPACE_VERIFY_PROVIDERS || "claude,codex"
  ).split(",")) {
    const worktree = await invoke("worktree.create", {
      projectId: project.id,
      branch: `proof-${provider}`,
    });
    const expected =
      `${provider}-proof-${Date.now()}` + String.fromCharCode(10);
    const task = await invoke("task.create", {
      projectId: project.id,
      title: `Verify ${provider}`,
      description: "Disposable local application integration test",
    });
    const launch = await invoke("attempt.start", {
      taskId: task.id,
      provider,
      model: models[provider],
      worktreePath: worktree.path,
      idempotencyKey: `proof-${provider}`,
      prompt: `This is a disposable integration test repository. Create a file named provider-proof.txt in the current working directory containing exactly the decoded JSON string ${JSON.stringify(expected)} including its final newline. Also append exactly one line containing ${provider}-execution to a file named run-count.txt in the current working directory (create it if absent; append if it already exists). Modify only these two files. Do not read personal files, use network tools, install packages, modify configuration, or make commits. Then report the files were created and stop.`,
    });
    const sp = {
      sessionId: launch.session.id,
      generation: launch.session.generation,
      viewerId: `verify-${provider}`,
    };
    await invoke("session.attach", { ...sp, cols: 120, rows: 45 });
    sessions.push({ provider, worktree: worktree.path, expected, sp, launch });
  }
  console.log(
    JSON.stringify({
      fixture,
      sessions: sessions.map(({ provider, worktree, sp }) => ({
        provider,
        worktree,
        sp,
      })),
    }),
  );
  await writeFile(
    path.join(fixture, "state.json"),
    JSON.stringify({ sessions, project }, null, 2),
  );
  for (let tick = 0; tick < 150; tick++) {
    for (const s of sessions) {
      const capture = await invoke("session.capture", s.sp).catch(() => ({
        data: "",
      }));
      await writeFile(path.join(fixture, `${s.provider}.txt`), capture.data);
      let proof = "";
      try {
        proof = await readFile(
          path.join(s.worktree, "provider-proof.txt"),
          "utf8",
        );
      } catch {}
      if (/Is this a project you created/.test(capture.data) && !s.trusted) {
        s.trusted = true;
        await invoke("session.input", { ...s.sp, data: "\x1b[B\r" });
      }
      if (
        /Do you trust the contents|Trust this folder\?/.test(capture.data) &&
        !s.trusted
      ) {
        s.trusted = true;
        await invoke("session.input", { ...s.sp, data: "\r" });
      }
      let count = "";
      try { count = await readFile(path.join(s.worktree, "run-count.txt"), "utf8"); } catch {}
      if (proof === s.expected && count === `${s.provider}-execution\n` && !s.passed) {
        s.passed = true;
        console.log(
          JSON.stringify({
            provider: s.provider,
            proof: "exact file content verified",
          }),
        );
      }
    }
    try {
      const action = JSON.parse(
        await readFile(path.join(fixture, "action.json"), "utf8"),
      );
      await writeFile(path.join(fixture, "action.json"), "{}");
      if (action.provider && action.data) {
        const s = sessions.find((s) => s.provider === action.provider);
        await invoke("session.input", { ...s.sp, data: action.data });
        console.log(JSON.stringify({ input: action.provider }));
      }
    } catch {}
    if (sessions.every((s) => s.passed)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Remount and reopen must retain identities, without delivering the prompts again.
  const socket = workspaceSocket(await realpath(path.join(fixture, "data")));
  const panePid = (s) => execFileSync("/opt/homebrew/bin/tmux", ["-S", socket, "display-message", "-p", "-t", s.launch.session.backendName, "#{pane_pid}"], { encoding: "utf8" }).trim();
  for (const s of sessions) { s.panePid = panePid(s); await invoke("session.detach", s.sp); }
  const attemptsBefore = (await invoke("snapshot")).attempts.map(v => v.id).sort();
  await app.close();
  await open();
  const snapshot = await invoke("snapshot");
  for (const s of sessions) {
    if (!snapshot.sessions.some((v) => v.id === s.sp.sessionId && v.generation === s.sp.generation))
      throw new Error("Recovered session identity or generation missing");
    if (JSON.stringify(snapshot.attempts.map(v => v.id).sort()) !== JSON.stringify(attemptsBefore))
      throw new Error("Recovery unexpectedly created another attempt");
    if (panePid(s) !== s.panePid) throw new Error("Recovery replaced the live provider process");
    await invoke("session.attach", s.sp);
    // Allow an accidental redelivery to become observable in the append-only count.
    s.recovered = true;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
  for (const s of sessions) {
    const count = await readFile(path.join(s.worktree, "run-count.txt"), "utf8").catch(() => "");
    const proof = await readFile(path.join(s.worktree, "provider-proof.txt"), "utf8").catch(() => "");
    s.recovered = s.recovered && count === `${s.provider}-execution\n` && proof === s.expected && panePid(s) === s.panePid;
  }
  if (sessions.some((s) => !s.passed || !s.recovered)) process.exitCode = 1;
  console.log(
    JSON.stringify({
      results: sessions.map(({ provider, passed, recovered }) => ({
        provider,
        model: models[provider] || "inherited CLI default",
        passed: !!passed,
        recovered,
        sameSessionGenerationAndPanePid: recovered,
        executionCount: recovered ? 1 : "unverified",
      })),
      fixture,
    }),
  );
} finally {
  if (app) {
    for (const s of sessions)
      await invoke("session.terminate", s.sp).catch(() => {});
    await app.close();
  }
  await cleanupFixture(fixture);
}
