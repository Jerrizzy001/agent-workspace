import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  encodeFrame,
  FrameDecoder,
  HELPER_KINDS,
  LOCAL_KINDS,
  MAX_FRAME_BYTES,
  PREAMBLE,
  ProtocolError,
  parseQualifiedId,
  qualifyId,
} from "../src/shared/host-protocol.js";
import {
  classifyFailure,
  connectHost,
  remoteCommand,
  sshArguments,
  validateHostInput,
  HostProblemError,
} from "../src/core/ssh.js";
import { routeOf, sanitizeSnapshot } from "../src/core/host-router.js";
import { createCore } from "../src/core/index.js";
import { createHostRouter } from "../src/core/host-router.js";
import { killTmuxFor, sshAvailable, startSshFixture } from "./ssh-fixture.js";

const repo = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));

test("frames round-trip in pieces and reject oversized, malformed and unknown frames", () => {
  const helper = new FrameDecoder(HELPER_KINDS, { seekPreamble: true });
  const bytes = Buffer.concat([
    Buffer.from("Welcome banner from a login profile\n" + PREAMBLE),
    encodeFrame({ k: "hello", value: "ü" }),
    encodeFrame({ k: "evt", event: { type: "snapshot" } }),
  ]);
  const got: any[] = [];
  for (let i = 0; i < bytes.length; i += 7) got.push(...helper.push(bytes.subarray(i, i + 7)));
  assert.deepEqual(
    got.map((m) => m.k),
    ["hello", "evt"],
  );
  assert.equal(got[0].value, "ü");
  const strict = () => new FrameDecoder(LOCAL_KINDS);
  const header = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  assert.throws(() => strict().push(header(MAX_FRAME_BYTES + 1)), ProtocolError);
  assert.throws(() => strict().push(header(0)), ProtocolError);
  assert.throws(() => strict().push(Buffer.concat([header(3), Buffer.from("{x}")])), /valid JSON/);
  assert.throws(() => strict().push(Buffer.concat([header(2), Buffer.from("[]")])), /kind/);
  assert.throws(() => strict().push(encodeFrame({ k: "clipboard.read" })), /Unsupported message kind/);
  // A helper may not send desktop-side kinds, and vice versa.
  assert.throws(() => new FrameDecoder(HELPER_KINDS).push(encodeFrame({ k: "req" })), /Unsupported/);
  assert.throws(() => strict().push(encodeFrame({ k: "evt" })), /Unsupported/);
  assert.throws(() => encodeFrame({ k: "res", data: "x".repeat(MAX_FRAME_BYTES) }), ProtocolError);
  // Endless banner text without the preamble is refused, not buffered.
  const seeking = new FrameDecoder(HELPER_KINDS, { seekPreamble: true });
  assert.throws(() => {
    for (let i = 0; i < 40; i++) seeking.push(Buffer.alloc(4096, 0x61));
  }, /unexpected output/);
});

test("remote IDs are namespaced per host and commands cannot mix hosts", () => {
  const id = qualifyId("0a1b2c3d", "3f6c-11aa");
  assert.equal(id, "ssh-0a1b2c3d-3f6c-11aa");
  assert.deepEqual(parseQualifiedId(id), { hostId: "0a1b2c3d", remoteId: "3f6c-11aa" });
  assert.equal(parseQualifiedId("plain-local-uuid"), undefined);
  assert.throws(() => qualifyId("0a1b2c3d", "../etc"), ProtocolError);
  assert.throws(() => qualifyId("0a1b2c3d", "a b"), ProtocolError);
  assert.equal(routeOf({ projectId: "local" }), undefined);
  assert.equal(routeOf({ projectId: id }), "0a1b2c3d");
  assert.throws(() => routeOf({ projectId: id, sessionId: "local" }), /different hosts/);
  assert.throws(
    () => routeOf({ projectId: id, sessionId: qualifyId("ffffffff", "x") }),
    /different hosts/,
  );
  assert.throws(
    () => routeOf({ projectId: id, positions: { local: { x: 1, y: 1 } } }),
    /different hosts/,
  );
});

test("host input allows an alias and narrow overrides only", () => {
  assert.deepEqual(validateHostInput({ alias: "build-box.example" }), {
    alias: "build-box.example",
    label: "build-box.example",
    helperPath: "~/agent-workspace-server",
  });
  for (const alias of ["-oProxyCommand=sh", "--", "a b", "host;rm", "user@host", "$(id)", "", "a".repeat(101)])
    assert.throws(() => validateHostInput({ alias }), /alias/, alias);
  for (const helperPath of ["relative", "~/../x", "/a/../b", "/a b", "/a;b", "/$(id)", "~/'x'", "/a//b"])
    assert.throws(() => validateHostInput({ alias: "h", helperPath }), /Helper folder/, helperPath);
  assert.throws(() => validateHostInput({ alias: "h", user: "-l" }), /user/);
  assert.throws(() => validateHostInput({ alias: "h", port: 0 }), /Port/);
  assert.throws(() => validateHostInput({ alias: "h", port: "22" }), /Port/);
  assert.throws(() => validateHostInput({ alias: "h", options: ["-o", "ProxyCommand=x"] }), /Unexpected/);
  assert.throws(() => validateHostInput({ alias: "h", proxyCommand: "x" }), /Unexpected/);
  const args = sshArguments({ id: "0a1b2c3d", alias: "h", user: "dev", port: 2222, helperPath: "~/aw", dataDir: "/srv/aw data".replace(" ", "-") });
  const joined = args.join(" ");
  for (const option of [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "UpdateHostKeys=no",
    "ForwardAgent=no",
    "ForwardX11=no",
    "ClearAllForwardings=yes",
    "PermitLocalCommand=no",
    "ControlMaster=no",
    "ConnectTimeout=15",
    "ServerAliveInterval=15",
  ])
    assert.ok(joined.includes(option), option);
  assert.equal(args[0], "-T");
  assert.ok(!args.includes("-A") && !args.includes("-X") && !args.includes("-L"));
  // The destination follows "--", then exactly one fixed remote command.
  const dash = args.indexOf("--");
  assert.deepEqual(args.slice(dash), ["--", "h", `"$HOME"/'aw/bin/aw-ssh-helper' --data-dir '/srv/aw-data'`]);
  assert.equal(remoteCommand({ helperPath: "/opt/aw" }), "'/opt/aw/bin/aw-ssh-helper'");
});

test("ssh failures become owner-facing problems", () => {
  const spec = { id: "0a1b2c3d", alias: "box", helperPath: "~/aw" };
  assert.equal(
    classifyFailure(spec, "No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed.\n", 255).code,
    "host-key-unknown",
  );
  const changed = classifyFailure(
    spec,
    "@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nThe fingerprint for the ED25519 key sent by the remote host is\nSHA256:abcDEF123+/=.\nHost key verification failed.\n",
    255,
  );
  assert.equal(changed.code, "host-key-changed");
  assert.deepEqual(changed.fingerprints, ["SHA256:abcDEF123+/= (ED25519)"]);
  assert.equal(classifyFailure(spec, "dev@box: Permission denied (publickey).\n", 255).code, "auth-failed");
  assert.equal(classifyFailure(spec, "sh: 1: /home/dev/aw/bin/aw-ssh-helper: not found\n", 127).code, "helper-missing");
  assert.equal(classifyFailure(spec, "aw-ssh-helper: node-missing: Node.js 24\n", 69).code, "node-missing");
  assert.equal(classifyFailure(spec, "ssh: Could not resolve hostname box: Name or service not known\n", 255).code, "unreachable");
});

test("host snapshots are sanitized before the desktop uses them", () => {
  const clean = sanitizeSnapshot({
    projects: [
      { id: "p1", name: "ok", path: "/srv/ok", createdAt: "t" },
      { id: "../../x", name: "bad id", path: "/x", createdAt: "t" },
      { id: "p2", name: 42, path: "/x", createdAt: "t" },
    ],
    sessions: [
      { id: "s1", attemptId: null, projectId: "p1", provider: "shell", cwd: "/srv/ok", backendName: "aw-s1", generation: 1, status: "running", createdAt: "t", extra: "dropped" },
      { id: "s2", attemptId: null, projectId: "p1", provider: "rm -rf", cwd: "/", backendName: "x", generation: 1, status: "running", createdAt: "t" },
    ],
    layouts: [{ projectId: "p1", positions: { s1: { x: 1, y: 2 }, "bad key": { x: 1, y: 1 }, s3: { x: "1" } } }],
    capabilities: [{ name: "clipboard", available: true, detail: "" }, { name: "git", available: true, detail: "git" }],
    hosts: [{ id: "should not pass" }],
  });
  assert.deepEqual(clean.projects.map((p) => p.id), ["p1"]);
  assert.deepEqual(clean.sessions.map((s) => s.id), ["s1"]);
  assert.equal((clean.sessions[0] as any).extra, undefined);
  assert.deepEqual(clean.layouts[0]!.positions, { s1: { x: 1, y: 2 } });
  assert.deepEqual(clean.capabilities.map((c) => c.name), ["git"]);
  assert.equal((clean as any).hosts, undefined);
});

/** Runs this checkout's helper directly (no SSH) and speaks frames to it. */
function helperProcess(dataDir: string) {
  const child = spawn(process.execPath, [tsxCli, path.join(repo, "src/server/stdio-host.ts"), "--data-dir", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  }) as ChildProcessWithoutNullStreams;
  const decoder = new FrameDecoder(HELPER_KINDS, { seekPreamble: true });
  const messages: any[] = [];
  const waiters: (() => void)[] = [];
  child.stdout.on("data", (b: Buffer) => {
    messages.push(...decoder.push(b));
    for (const w of waiters.splice(0)) w();
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  async function next(kind?: string, timeout = 30000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const index = messages.findIndex((m) => !kind || m.k === kind);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error("No " + kind + " frame");
      await Promise.race([new Promise<void>((r) => waiters.push(r)), exited, new Promise((r) => setTimeout(r, 200))]);
    }
  }
  return {
    child,
    exited,
    next,
    send: (m: any) => child.stdin.write(Buffer.isBuffer(m) ? m : encodeFrame(m)),
  };
}

test("the stdio helper negotiates first and denies desktop-only methods, unknown kinds and bad frames", { timeout: 120000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-helper-"));
  const dataDir = path.join(temp, "data");
  try {
    // Probe: greeting only, nothing is created on the host.
    let h = helperProcess(dataDir);
    const hello = await h.next("hello");
    assert.deepEqual(hello.protocol, { min: 1, max: 1 });
    assert.equal(hello.helperVersion, pkg.version);
    assert.equal(hello.storeSchema, 0);
    assert.equal(hello.hostId, "");
    assert.ok(hello.tools.some((t: any) => t.name === "tmux" && t.available));
    h.send({ k: "bye" });
    assert.equal(await h.exited, 0);
    assert.equal(fs.existsSync(dataDir), false, "a probe must not create helper data");

    // Protocol mismatch is refused before any core starts.
    h = helperProcess(dataDir);
    await h.next("hello");
    h.send({ k: "start", protocol: 99 });
    assert.match((await h.next("fatal")).error, /Protocol 99 is not supported/);
    assert.notEqual(await h.exited, 0);
    assert.equal(fs.existsSync(path.join(dataDir, "workspace.sqlite")), false);

    // A request before start ends the connection.
    h = helperProcess(dataDir);
    await h.next("hello");
    h.send({ k: "req", id: 1, op: "invoke", command: "snapshot" });
    assert.match((await h.next("fatal")).error, /before start/);
    await h.exited;

    h = helperProcess(dataDir);
    await h.next("hello");
    h.send({ k: "start", protocol: 1 });
    const ready = await h.next("ready");
    assert.match(ready.hostId, /^[0-9a-f]{32}$/);
    // A second helper on the same data folder is refused by the core lock.
    const second = helperProcess(dataDir);
    await second.next("hello");
    second.send({ k: "start", protocol: 1 });
    assert.match((await second.next("fatal")).error, /^data-in-use:/);
    await second.exited;
    let id = 0;
    const call = async (fields: any) => {
      const rid = ++id;
      h.send({ k: "req", id: rid, ...fields });
      for (;;) {
        const res = await h.next("res");
        if (res.id === rid) return res;
      }
    };
    assert.ok((await call({ op: "invoke", command: "snapshot" })).result.projects);
    for (const command of ["settings.write", "settings.read", "assist.status", "assist.suggest", "project.add", "project.hide", "attachment.create", "agentControl"])
      assert.match(
        (await call({ op: "invoke", command, payload: command === "settings.write" ? { key: "keepAwake", value: true } : {} })).error,
        /not available remotely/,
        command,
      );
    // Fields outside the command's allowlist are refused.
    assert.match(
      (await call({ op: "invoke", command: "files.list", payload: { projectId: "x", dataDir: "/" } })).error,
      /Unexpected command field/,
    );
    assert.match((await call({ op: "register", path: "relative/dir" })).error, /absolute folder/);
    // Unknown operations and kinds are protocol violations: the helper exits.
    h.send({ k: "req", id: 99, op: "clipboard" });
    assert.match((await h.next("fatal")).error, /Unsupported operation/);
    assert.notEqual(await h.exited, 0);

    h = helperProcess(dataDir);
    await h.next("hello");
    h.send({ k: "start", protocol: 1 });
    await h.next("ready");
    h.send({ k: "power.setPolicy" });
    assert.match((await h.next("fatal")).error, /Unsupported message kind/);
    await h.exited;

    h = helperProcess(dataDir);
    await h.next("hello");
    const big = Buffer.alloc(4);
    big.writeUInt32BE(MAX_FRAME_BYTES + 10);
    h.send(big);
    assert.match((await h.next("fatal")).error, /Frame size/);
    await h.exited;
  } finally {
    killTmuxFor(dataDir);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

const skip = sshAvailable() ? false : "OpenSSH client and server are not installed";

test("probe over a disposable sshd: host keys are never accepted, helpers are checked", { skip, timeout: 240000 }, async () => {
  const fx = await startSshFixture();
  const previous = process.env.WORKSPACE_SSH_CONFIG;
  process.env.WORKSPACE_SSH_CONFIG = fx.config;
  const spec = { id: "0a1b2c3d", alias: fx.alias, helperPath: fx.helperDir, dataDir: fx.remoteData };
  const localData = path.join(fx.dir, "local-data");
  let router: Awaited<ReturnType<typeof createHostRouter>> | undefined;
  const core = await createCore({ dataDir: localData, emit: (e) => router?.onLocalEvent(e) });
  router = await createHostRouter({ local: core, emit: () => {}, autoConnect: false });
  try {
    fx.installHelper();
    const host: any = await router.ssh("add", { alias: fx.alias, helperPath: fx.helperDir, dataDir: fx.remoteData });

    // Unknown host key: refused, the fingerprint is shown, known_hosts untouched.
    fx.distrust();
    let probe: any = await router.ssh("probe", { hostId: host.id });
    assert.equal(probe.ok, false);
    assert.equal(probe.problem.code, "host-key-unknown");
    assert.ok(probe.problem.fingerprints.some((f: string) => f.startsWith(fx.fingerprint)), JSON.stringify(probe.problem));
    assert.equal(fs.readFileSync(fx.knownHosts, "utf8"), "");
    let connected: any = await router.ssh("connect", { hostId: host.id });
    assert.equal(connected.state, "disconnected");
    assert.equal(connected.problem.code, "host-key-unknown");
    assert.equal(fs.readFileSync(fx.knownHosts, "utf8"), "");

    // Changed host key: refused with the new fingerprint, never replaced.
    fx.wrongKey();
    const pinned = fs.readFileSync(fx.knownHosts, "utf8");
    probe = await router.ssh("probe", { hostId: host.id });
    assert.equal(probe.problem.code, "host-key-changed");
    assert.deepEqual(probe.problem.fingerprints, [`${fx.fingerprint} (ED25519)`]);
    assert.equal(fs.readFileSync(fx.knownHosts, "utf8"), pinned);

    // Trusted key: the probe reports the helper and the host's tools.
    fx.trust();
    probe = await router.ssh("probe", { hostId: host.id });
    assert.equal(probe.ok, true, JSON.stringify(probe.problem));
    assert.equal(probe.host.helperVersion, pkg.version);
    assert.equal(probe.host.protocol, 1);
    const tools = Object.fromEntries(probe.host.tools.map((t: any) => [t.name, t.available]));
    assert.equal(tools.node, true);
    assert.equal(tools.tmux, true);
    assert.equal(tools.git, true);
    assert.ok("claude" in tools && "codex" in tools);
    assert.equal(fs.existsSync(path.join(fx.remoteData, "workspace.sqlite")), false, "probe is read-only");

    // Missing helper: names the install location and requirements on the host.
    fs.rmSync(fx.helperDir, { recursive: true, force: true });
    probe = await router.ssh("probe", { hostId: host.id });
    assert.equal(probe.problem.code, "helper-missing");
    assert.match(probe.problem.message, /extract the agent-workspace-server archive/);

    // A helper speaking another protocol version.
    const evil = path.join(fx.dir, "evil.mjs");
    const evilHelper = (script: string) => {
      fs.writeFileSync(evil, script);
      fx.installHelper({ body: `#!/bin/sh\nexec ${process.execPath} ${evil}\n` });
    };
    const frame = `const frame=(m)=>{const b=Buffer.from(JSON.stringify(m));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]);};`;
    const hello = `{k:"hello",protocol:{min:1,max:1},helperVersion:"9.9.9",platform:"linux",arch:"x64",schema:6,storeSchema:0,hostId:"",tools:[]}`;
    evilHelper(`${frame}process.stdout.write(${JSON.stringify(PREAMBLE)});process.stdout.write(frame({k:"hello",protocol:{min:5,max:7},helperVersion:"9.9.9",platform:"linux",arch:"x64",schema:9,storeSchema:0,hostId:"",tools:[]}));setTimeout(()=>{},5000);`);
    probe = await router.ssh("probe", { hostId: host.id });
    assert.equal(probe.problem.code, "protocol-mismatch");
    assert.match(probe.problem.message, /protocol 5-7/);

    // Oversized frame from the host.
    evilHelper(`${frame}process.stdout.write(${JSON.stringify(PREAMBLE)});const h=Buffer.alloc(4);h.writeUInt32BE(${MAX_FRAME_BYTES + 1});process.stdout.write(h);setTimeout(()=>{},5000);`);
    await assert.rejects(connectHost(spec), (e: any) => e instanceof HostProblemError && e.problem.code === "protocol-error");

    // A host that tries to call desktop methods or send unknown kinds is disconnected.
    for (const message of [
      `{k:"req",id:1,op:"clipboard.read"}`,
      `{k:"clipboard",text:"x"}`,
      `{k:"res",id:7,ok:true,result:1}`,
    ]) {
      evilHelper(`${frame}process.stdout.write(${JSON.stringify(PREAMBLE)});process.stdout.write(frame(${hello}));process.stdin.once("data",()=>{process.stdout.write(frame({k:"ready",protocol:1,hostId:"${"a".repeat(32)}",schema:6}));setTimeout(()=>process.stdout.write(frame(${message})),100);});setTimeout(()=>{},5000);`);
      let lost: any;
      const conn = await connectHost(spec, { onLost: (p) => (lost = p) });
      for (let i = 0; i < 50 && !lost; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(lost?.code, "protocol-error", message);
      await conn.close();
    }
    // An unsupported event kind is denied the same way.
    evilHelper(`${frame}process.stdout.write(${JSON.stringify(PREAMBLE)});process.stdout.write(frame(${hello}));process.stdin.once("data",()=>{process.stdout.write(frame({k:"ready",protocol:1,hostId:"${"a".repeat(32)}",schema:6}));setTimeout(()=>process.stdout.write(frame({k:"evt",event:{type:"power.acquire"}})),100);});setTimeout(()=>{},5000);`);
    let lostEvent: any;
    const h2: any = await router.ssh("add", { alias: fx.alias, label: "evil", helperPath: fx.helperDir });
    await router.ssh("connect", { hostId: h2.id });
    for (let i = 0; i < 60; i++) {
      lostEvent = (await router.ssh("list") as any[]).find((x) => x.id === h2.id);
      if (lostEvent.problem) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(lostEvent.problem?.code, "protocol-error");
    await router.ssh("disconnect", { hostId: h2.id });
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
});
