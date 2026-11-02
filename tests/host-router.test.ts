import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createCore } from "../src/core/index.js";
import { createHostRouter, type HostRouter } from "../src/core/host-router.js";
import { parseQualifiedId } from "../src/shared/host-protocol.js";
import type { CoreEvent, Snapshot } from "../src/shared/contracts.js";
import {
  killTmuxFor,
  sshAvailable,
  startSshFixture,
  tmuxSocketFor,
} from "./ssh-fixture.js";

const skip = sshAvailable()
  ? false
  : "OpenSSH client and server are not installed";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  read: () => T | Promise<T>,
  ok: (v: T) => boolean,
  timeout = 20000,
) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > deadline)
      throw new Error(
        "Timed out; last value " + JSON.stringify(value)?.slice(0, 400),
      );
    await wait(50);
    value = await read();
  }
  return value;
}
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

test(
  "SSH folders run on the host: shell continuity, files, Git, providers and refusals",
  { skip, timeout: 300000 },
  async () => {
    const fx = await startSshFixture("aw-router-");
    const previous = process.env.WORKSPACE_SSH_CONFIG;
    process.env.WORKSPACE_SSH_CONFIG = fx.config;
    // A fixture `claude` on the host's own PATH (never a real provider).
    const received = path.join(fx.dir, "remote-claude.jsonl");
    fs.writeFileSync(
      path.join(fx.remoteBin, "claude"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--help") { process.stdout.write("Usage: fixture\\n  --session-id <uuid>\\n"); process.exit(0); }
if (args[0] === "--version") { process.stdout.write("9.9.9 (fixture claude)\\n"); process.exit(0); }
require("node:fs").appendFileSync(${JSON.stringify(received)}, JSON.stringify({ args, cwd: process.cwd(), path: process.env.PATH }) + "\\n");
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    fx.installHelper({ extraPath: fx.remoteBin });
    // The remote folder and a local folder with the same name and file.
    const remoteRepo = path.join(fx.dir, "remote-home", "project");
    const localRepo = path.join(fx.dir, "local-home", "project");
    for (const dir of [remoteRepo, localRepo]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "notes.txt"), "original\n");
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "f@example.invalid"],
        ["config", "user.name", "F"],
        ["add", "."],
        ["commit", "-qm", "init"],
      ])
        execFileSync("git", args, { cwd: dir });
    }
    const localData = path.join(fx.dir, "local-data");
    const events: CoreEvent[] = [];
    let router: HostRouter | undefined;
    let core = await createCore({
      dataDir: localData,
      emit: (e) => router?.onLocalEvent(e),
    });
    const delays = [300, 600, 1200, 2400, 4800];
    router = await createHostRouter({
      local: core,
      emit: (e) => events.push(e),
      reconnectDelays: delays,
    });
    const r = () => router!;
    const call = (c: any, p: any = {}) => r().invoke(c, p) as Promise<any>;
    const hostView = async (id: string) =>
      ((await r().ssh("list")) as any[]).find((h) => h.id === id);
    const remoteSocket = () => tmuxSocketFor(fx.remoteData);
    const panePid = (name: string) =>
      execFileSync(
        "tmux",
        [
          "-S",
          remoteSocket(),
          "list-panes",
          "-t",
          "=" + name,
          "-F",
          "#{pane_pid}",
        ],
        { encoding: "utf8" },
      ).trim();
    try {
      const localProject = await call("project.add", { path: localRepo });
      const host: any = await r().ssh("add", {
        alias: fx.alias,
        label: "Fixture box",
        helperPath: fx.helperDir,
        dataDir: fx.remoteData,
      });
      const connected: any = await r().ssh("connect", { hostId: host.id });
      assert.equal(
        connected.state,
        "connected",
        JSON.stringify(connected.problem),
      );
      assert.ok(
        connected.capabilities.find(
          (c: any) =>
            c.name === "claude" &&
            c.available &&
            c.detail.startsWith(fx.remoteBin),
        ),
        "host capabilities come from the host's own PATH",
      );

      // Browse within the host, then register a folder there.
      const listing: any = await r().ssh("browse", {
        hostId: host.id,
        path: path.dirname(remoteRepo),
      });
      assert.deepEqual(
        listing.entries.map((e: any) => e.name),
        ["project"],
      );
      assert.equal(listing.entries[0].git, true);
      await assert.rejects(
        r().ssh("registerProject", { hostId: host.id, path: "project" }),
        /absolute folder/,
      );
      const project: any = await r().ssh("registerProject", {
        hostId: host.id,
        path: remoteRepo,
      });
      assert.equal(project.hostId, host.id);
      assert.equal(parseQualifiedId(project.id)?.hostId, host.id);
      assert.equal(project.path, fs.realpathSync(remoteRepo));
      let snapshot: Snapshot = await call("snapshot");
      assert.ok(
        snapshot.projects.some((p) => p.id === localProject.id && !p.hostId),
      );
      assert.ok(
        snapshot.projects.some(
          (p) => p.id === project.id && p.hostId === host.id,
        ),
      );
      assert.equal(
        snapshot.hosts?.find((h) => h.id === host.id)?.state,
        "connected",
      );

      // Files and Git route to the host; escapes are refused there; the local
      // folder with the same name is never written.
      assert.deepEqual(
        (await call("files.list", { projectId: project.id }))
          .map((f: any) => f.name)
          .sort(),
        ["notes.txt"],
      );
      const file = await call("files.read", {
        projectId: project.id,
        path: "notes.txt",
      });
      assert.equal(file.content, "original\n");
      await assert.rejects(
        call("files.read", {
          projectId: project.id,
          path: "../../local-home/project/notes.txt",
        }),
        /escapes project root/,
      );
      await assert.rejects(
        call("files.write", {
          projectId: project.id,
          path: "../../local-home/project/notes.txt",
          content: "x",
          expectedHash: sha("original\n"),
        }),
        /escapes project root/,
      );
      await assert.rejects(
        call("files.read", {
          projectId: project.id,
          path: path.join(localRepo, "notes.txt"),
        }),
        /escapes project root/,
      );
      const saved = await call("files.write", {
        projectId: project.id,
        path: "notes.txt",
        content: "edited remotely\n",
        expectedHash: file.hash,
      });
      assert.equal(saved.hash, sha("edited remotely\n"));
      assert.equal(
        fs.readFileSync(path.join(remoteRepo, "notes.txt"), "utf8"),
        "edited remotely\n",
      );
      assert.equal(
        fs.readFileSync(path.join(localRepo, "notes.txt"), "utf8"),
        "original\n",
      );
      const status = await call("git.status", { projectId: project.id });
      assert.deepEqual(
        status.files.map((f: any) => [f.path, f.working]),
        [["notes.txt", "M"]],
      );
      assert.match(
        await call("git.diff", {
          projectId: project.id,
          path: "notes.txt",
        }).then((d: any) => (typeof d === "string" ? d : d.diff)),
        /\+edited remotely/,
      );
      assert.deepEqual(
        (await call("git.status", { projectId: localProject.id })).files,
        [],
      );
      // A remote ID cannot be combined with a local one.
      await assert.rejects(
        call("terminal.open", {
          projectId: project.id,
          resumeSessionId: "local-id",
          provider: "claude",
          idempotencyKey: "mix",
        }),
        /different hosts/,
      );

      // Open a remote shell, type, see output.
      const opened = await call("terminal.open", {
        projectId: project.id,
        provider: "shell",
        idempotencyKey: "shell-1",
      });
      const session = opened.session;
      assert.equal(
        session.hostId,
        undefined,
        "results carry IDs; the snapshot marks the host",
      );
      assert.equal(parseQualifiedId(session.id)?.hostId, host.id);
      assert.equal(session.cwd, fs.realpathSync(remoteRepo));
      const remoteSessionId = parseQualifiedId(session.id)!.remoteId;
      const backend = session.backendName;
      const pid = panePid(backend);
      const viewer = {
        sessionId: session.id,
        generation: session.generation,
        viewerId: "view-1",
      };
      const output = () =>
        events
          .filter(
            (e): e is Extract<CoreEvent, { type: "terminal.data" }> =>
              e.type === "terminal.data" && e.viewerId === "view-1",
          )
          .map((e) => e.data)
          .join("");
      const acked = () => {
        const last = events
          .filter(
            (e: any) => e.type === "terminal.data" && e.viewerId === "view-1",
          )
          .at(-1) as any;
        return last
          ? call("session.ack", { ...viewer, sequence: last.sequence })
          : undefined;
      };
      await call("session.attach", { ...viewer, cols: 100, rows: 30 });
      await call("session.input", {
        ...viewer,
        data: "echo REMOTE_$((40+2)) $PWD\r",
      });
      await until(
        () => output(),
        (o) => o.includes("REMOTE_42 " + fs.realpathSync(remoteRepo)),
      );
      await acked();
      snapshot = await call("snapshot");
      assert.equal(
        snapshot.sessions.find((s) => s.id === session.id)?.hostId,
        host.id,
      );
      assert.equal(
        snapshot.sessions.find((s) => s.id === session.id)?.status,
        "running",
      );

      // Notes, the canvas layout, tasks and board lanes live on the host too.
      const note = await call("note.create", {
        projectId: project.id,
        title: "On the host",
        body: "remote note",
      });
      assert.equal(parseQualifiedId(note.id)?.hostId, host.id);
      const laidOut: Snapshot = await call("layout.save", {
        projectId: project.id,
        positions: {
          [session.id]: { x: 10, y: 20 },
          [note.id]: { x: 30, y: 40 },
        },
      });
      assert.deepEqual(
        laidOut.layouts.find((l) => l.projectId === project.id)?.positions,
        {
          [session.id]: { x: 10, y: 20 },
          [note.id]: { x: 30, y: 40 },
        },
      );
      await assert.rejects(
        call("layout.save", {
          projectId: project.id,
          positions: { [localProject.id]: { x: 1, y: 1 } },
        }),
        /different hosts/,
      );
      const task = await call("task.create", {
        projectId: project.id,
        title: "Remote task",
      });
      assert.equal(parseQualifiedId(task.id)?.hostId, host.id);
      const lanes = await call("lane.add", {
        projectId: project.id,
        name: "Later",
        revision: 0,
      });
      assert.equal(lanes.projectId, project.id);
      assert.ok(
        lanes.lanes.some(
          (l: any) => l.name === "Later" && !parseQualifiedId(l.id),
        ),
      );
      snapshot = await call("snapshot");
      assert.ok(
        snapshot.notes.some(
          (n) => n.id === note.id && n.body === "remote note",
        ),
      );
      assert.ok(snapshot.tasks.some((t) => t.id === task.id));
      // Local-only features are refused for remote sessions with clear messages.
      await assert.rejects(
        r().createAttachment({
          sessionId: session.id,
          generation: 1,
          data: new Uint8Array([1]),
        }),
        /Pasting images into SSH sessions/,
      );
      await assert.rejects(
        r().agentControl("grant", {
          sessionId: session.id,
          generation: 1,
          verbs: ["status"],
        }),
        /only available for sessions on this computer/,
      );
      await assert.rejects(
        call("assist.preview", { kind: "commit", projectId: project.id }),
        /not available for SSH folders/,
      );

      // Disconnect by killing the ssh client: the host reconnects by itself, the
      // view is told to resync, and it reattaches the same tmux session.
      const before = events.length;
      r().connection(host.id)!.child.kill("SIGKILL");
      await until(
        () => hostView(host.id),
        (h) => h.state === "reconnecting",
      );
      snapshot = await call("snapshot");
      assert.equal(
        snapshot.sessions.find((s) => s.id === session.id)?.status,
        "unknown",
        "a disconnected host's sessions are unknown",
      );
      await assert.rejects(
        call("session.input", { ...viewer, data: "echo lost\r" }),
        /not connected/,
      );
      await until(
        () => hostView(host.id),
        (h) => h.state === "connected",
        30000,
      );
      assert.ok(
        events
          .slice(before)
          .some((e) => e.type === "terminal.resync" && e.viewerId === "view-1"),
      );
      await call("session.detach", viewer);
      await call("session.attach", { ...viewer, cols: 100, rows: 30 });
      await call("session.input", { ...viewer, data: "echo AGAIN_$((6*7))\r" });
      await until(
        () => output(),
        (o) => o.includes("AGAIN_42"),
      );
      await acked();
      snapshot = await call("snapshot");
      const same = snapshot.sessions.find((s) => s.id === session.id)!;
      assert.equal(same.generation, session.generation);
      assert.equal(same.backendName, backend);
      assert.equal(
        panePid(backend),
        pid,
        "the same remote process kept running",
      );
      assert.equal(
        snapshot.sessions.filter((s) => s.projectId === project.id).length,
        1,
        "nothing was relaunched",
      );

      // Stream overflow: an unacknowledged viewer is told to resync.
      const flood = { sessionId: session.id, generation: 1, viewerId: "flood" };
      await call("session.attach", { ...flood, cols: 100, rows: 30 });
      await call("session.input", {
        ...flood,
        data: "head -c 3000000 /dev/zero | tr '\\0' x\r",
      });
      await until(
        () =>
          events.some(
            (e) => e.type === "terminal.resync" && e.viewerId === "flood",
          ),
        (v) => v,
        30000,
      );
      await call("session.detach", flood);

      // A launch whose answer is lost is unknown; retrying with the same key
      // after reconnecting returns the same session (no duplicate).
      const sessionsIn = async () =>
        ((await call("snapshot")) as Snapshot).sessions.filter(
          (s) => s.projectId === project.id && s.provider === "claude",
        );
      r().connection(host.id)!.onRequestSent = (op, fields) => {
        if (op === "invoke" && fields.command === "terminal.open")
          r().connection(host.id)!.child.kill("SIGKILL");
      };
      const launch = {
        projectId: project.id,
        provider: "claude",
        prompt: "fixture prompt",
        idempotencyKey: "claude-after",
      };
      await assert.rejects(
        call("terminal.open", launch),
        /outcome is unknown|not connected/,
      );
      await until(
        () => hostView(host.id),
        (h) => h.state === "connected",
        30000,
      );
      const retried = await call("terminal.open", launch);
      const again = await call("terminal.open", launch);
      assert.equal(again.session.id, retried.session.id);
      assert.equal((await sessionsIn()).length, 1);
      await until(
        () => fs.existsSync(received) && fs.readFileSync(received, "utf8"),
        (v) => !!v,
      );
      const runs = fs
        .readFileSync(received, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      assert.equal(runs.length, 1, "the prompt reached the provider once");
      assert.equal(runs[0].cwd, fs.realpathSync(remoteRepo));
      assert.ok(runs[0].args.includes("fixture prompt"));
      assert.ok(
        runs[0].path.split(":").includes(fx.remoteBin),
        "the provider ran with the host's PATH",
      );

      // A launch while disconnected is refused before it is sent; retrying
      // after connecting launches exactly once.
      await r().ssh("disconnect", { hostId: host.id });
      assert.ok(panePid(backend), "disconnect leaves remote tmux running");
      const second = {
        projectId: project.id,
        provider: "claude",
        idempotencyKey: "claude-before",
      };
      await assert.rejects(call("terminal.open", second), /not connected/);
      await r().ssh("connect", { hostId: host.id });
      await call("terminal.open", second);
      assert.equal((await sessionsIn()).length, 2);

      // A save whose answer is lost is unknown and is not resent.
      const current = await call("files.read", {
        projectId: project.id,
        path: "notes.txt",
      });
      r().connection(host.id)!.onRequestSent = (op, fields) => {
        if (op === "invoke" && fields.command === "files.write")
          r().connection(host.id)!.child.kill("SIGKILL");
      };
      await assert.rejects(
        call("files.write", {
          projectId: project.id,
          path: "notes.txt",
          content: "maybe saved\n",
          expectedHash: current.hash,
        }),
        /outcome is unknown|not connected/,
      );
      await until(
        () => hostView(host.id),
        (h) => h.state === "connected",
        30000,
      );
      const after = await call("files.read", {
        projectId: project.id,
        path: "notes.txt",
      });
      assert.ok(["edited remotely\n", "maybe saved\n"].includes(after.content));
      if (after.content === "maybe saved\n")
        await assert.rejects(
          call("files.write", {
            projectId: project.id,
            path: "notes.txt",
            content: "again\n",
            expectedHash: current.hash,
          }),
          /File conflict/,
        );

      // Restarting the desktop core keeps the remote folder listed while
      // disconnected (nonauthoritative cache) and reconnects to the same session.
      await r().close();
      await core.close();
      events.length = 0;
      router = undefined;
      core = await createCore({
        dataDir: localData,
        emit: (e) => router?.onLocalEvent(e),
      });
      router = await createHostRouter({
        local: core,
        emit: (e) => events.push(e),
        autoConnect: false,
        reconnectDelays: delays,
      });
      snapshot = await call("snapshot");
      assert.ok(
        snapshot.projects.some(
          (p) => p.id === project.id && p.hostId === host.id,
        ),
      );
      await assert.rejects(
        call("files.list", { projectId: project.id }),
        /not connected/,
      );
      await r().ssh("connect", { hostId: host.id });
      snapshot = await call("snapshot");
      assert.equal(
        snapshot.sessions.find((s) => s.id === session.id)?.status,
        "running",
      );
      assert.equal(panePid(backend), pid);
      await call("session.attach", {
        ...viewer,
        viewerId: "view-2",
        cols: 100,
        rows: 30,
      });
      await call("session.terminate", { ...viewer, viewerId: "view-2" });
      assert.equal(remoteSessionId.length > 0, true);

      // Removing the host forgets it locally; its folders leave the list.
      await r().ssh("remove", { hostId: host.id });
      snapshot = await call("snapshot");
      assert.ok(!snapshot.projects.some((p) => p.hostId));
      assert.deepEqual(snapshot.hosts, []);
    } finally {
      await router?.close();
      await core.close();
      killTmuxFor(fx.remoteData);
      killTmuxFor(localData);
      await fx.stop();
      if (previous === undefined) delete process.env.WORKSPACE_SSH_CONFIG;
      else process.env.WORKSPACE_SSH_CONFIG = previous;
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  },
);
