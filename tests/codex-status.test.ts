import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCore } from "../src/core/index.js";
import { executable } from "../src/core/process.js";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Codex hooks report working, needs input and done on their own pane; exact conversation resumes", async () => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "aw-codex-")),
  );
  const bin = path.join(dir, "bin"),
    mode = path.join(dir, "mode"),
    log = path.join(dir, "launches");
  fs.mkdirSync(bin);
  const conversation = "11111111-1111-1111-1111-111111111111";
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
const fs = require('node:fs'), {execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--config <key=value>'); process.exit(0); }
if (args[0] === 'features') { console.log('hooks stable true'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const hooks = new Map();
for (let i=0; i<args.length; i++) if (args[i] === '--config') {
  const value = args[++i];
  hooks.set(value.slice(6,value.indexOf('=')), JSON.parse(value.match(/command=(.+),timeout=3/)[1]));
}
function hook(event) {
  const command = hooks.get(event); if (!command) return;
  // Simulate an app-server hook without the launching pane's environment.
  execFileSync('/bin/sh', ['-c',command], {env:{...process.env,TMUX:'/missing,0,0',TMUX_PANE:'%999'}, input: JSON.stringify({session_id:${JSON.stringify(conversation)},cwd:process.cwd(),hook_event_name:event}),stdio:['pipe','ignore','pipe']});
}
hook('SessionStart'); hook('UserPromptSubmit');
let previous='';
setInterval(()=>{ if(fs.existsSync(${JSON.stringify(mode)})){const next=fs.readFileSync(${JSON.stringify(mode)},'utf8');if(next!==previous){previous=next;hook(next);}}},100);
`,
    { mode: 0o700 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  const core = await createCore({
    dataDir: path.join(dir, "data"),
    emit: () => {},
  });
  const sockets = new Set<string>();
  const call = (command: any, payload = {}) =>
    core.invoke(command, payload) as Promise<any>;
  async function until(sid: string, activity: string) {
    for (let i = 0; i < 160; i++) {
      const session = (await call("snapshot")).sessions.find(
        (s: any) => s.id === sid,
      );
      if (session?.activity === activity && session.activityTracking)
        return session;
      await wait(50);
    }
    assert.fail(`Missing Codex activity ${activity}`);
  }
  try {
    const project = await call("project.add", { path: dir });
    const first = await call("terminal.open", {
      projectId: project.id,
      provider: "codex",
      idempotencyKey: "codex-one",
    });
    sockets.add(first.session.backendSocket);
    const working = await until(first.session.id, "running");
    assert.equal(working.conversationId, conversation);
    fs.writeFileSync(mode, "PermissionRequest");
    await until(first.session.id, "needs");
    fs.writeFileSync(mode, "Stop");
    await until(first.session.id, "done");
    await call("session.attach", {
      sessionId: first.session.id,
      viewerId: "test",
    });
    await call("session.terminate", {
      sessionId: first.session.id,
      generation: 1,
      viewerId: "test",
    });
    fs.rmSync(mode);
    const second = await call("terminal.open", {
      projectId: project.id,
      provider: "codex",
      resumeSessionId: first.session.id,
      idempotencyKey: "codex-two",
    });
    await until(second.session.id, "running");
    const args = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(args[1].slice(0, 2), ["resume", conversation]);
    assert.equal(args[1].includes("--dangerously-bypass-hook-trust"), false);
  } finally {
    await core.close();
    for (const socket of sockets)
      try {
        execFileSync(executable("tmux"), ["-S", socket, "kill-server"], {
          stdio: "ignore",
        });
      } catch {}
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
