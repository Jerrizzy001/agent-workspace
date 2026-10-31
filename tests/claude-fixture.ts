/** Shared setup for the profile, branch and transcript tests (fixture `claude` only). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCore } from "../src/core/index.js";

export const tmux = process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux";
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, tries = 200) {
  let value = await read();
  for (let retry = 0; retry < tries && !ok(value); retry++) {
    await wait(50);
    value = await read();
  }
  if (!ok(value)) throw new Error("Timed out; last value " + JSON.stringify(value)?.slice(0, 400));
  return value;
}
/** Installs scripts/claude-fixture.cjs as `claude` in `bin`. */
export function installClaude(bin: string, name = "claude") {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, name),
    `#!${process.execPath}\nrequire(${JSON.stringify(path.resolve("scripts/claude-fixture.cjs"))});\n`,
    { mode: 0o700 },
  );
}
/** A temp workspace whose HOME, PATH and fixture files are private to the test. */
export async function workspace(prefix: string, options: { awctl?: boolean } = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(temp, "home");
  const bin = path.join(temp, "bin");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  installClaude(bin);
  const log = path.join(temp, "claude.jsonl");
  const control = path.join(temp, "control.json");
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SHELL: process.env.SHELL,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_FIXTURE_LOG: process.env.CLAUDE_FIXTURE_LOG,
    CLAUDE_FIXTURE_CONTROL: process.env.CLAUDE_FIXTURE_CONTROL,
    WORKSPACE_AWCTL: process.env.WORKSPACE_AWCTL,
  };
  if (options.awctl) {
    const cli = path.join(temp, "awctl.mjs");
    const { build } = await import("esbuild");
    await build({
      entryPoints: [path.resolve("src/cli/workspace.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: cli,
      logLevel: "silent",
    });
    process.env.WORKSPACE_AWCTL = cli;
  }
  process.env.PATH = bin + path.delimiter + saved.PATH;
  process.env.HOME = home;
  process.env.SHELL = "/bin/sh";
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_FIXTURE_LOG = log;
  process.env.CLAUDE_FIXTURE_CONTROL = control;
  const dataDir = path.join(temp, "data");
  const core = await createCore({ dataDir, emit: () => {} });
  const call = (c: any, p: any = {}) => core.invoke(c, p) as Promise<any>;
  const project = await call("project.add", { path: repo });
  let socket = "";
  const sessionOf = async (id: string) =>
    ((await call("snapshot")).sessions as any[]).find((s) => s.id === id);
  const pane = (s: any, format: string) =>
    execFileSync(tmux, ["-S", s.backendSocket, "display-message", "-p", "-t", "=" + s.backendName + ":0.0", format], {
      encoding: "utf8",
    }).trim();
  /** The pane process's real environment (Linux /proc; `ps eww` elsewhere). */
  const paneEnv = (s: any): Record<string, string> => {
    const pid = pane(s, "#{pane_pid}");
    const raw = fs.existsSync(`/proc/${pid}/environ`)
      ? fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
      : execFileSync("ps", ["eww", "-o", "command=", "-p", pid], { encoding: "utf8" }).trim().split(/\s+/);
    return Object.fromEntries(
      raw
        .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  };
  const starts = () =>
    fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  /** Types one line into a session's terminal through tmux, like a person would. */
  const type = (s: any, text: string) => {
    execFileSync(tmux, ["-S", s.backendSocket, "send-keys", "-t", "=" + s.backendName + ":0.0", "-l", text]);
    execFileSync(tmux, ["-S", s.backendSocket, "send-keys", "-t", "=" + s.backendName + ":0.0", "Enter"]);
  };
  const setMode = (mode: string) => fs.writeFileSync(control, JSON.stringify({ mode }));
  let runs = 0;
  /** Runs a command line in a shell session's own pane; returns its exit code and JSON output. */
  async function inPane(s: any, command: string) {
    const out = path.join(temp, `run-${++runs}.out`);
    const done = path.join(temp, `run-${runs}.code`);
    type(s, `${command} > ${out} 2>/dev/null; echo $? > ${done}`);
    await until(() => fs.existsSync(done) && fs.readFileSync(done, "utf8").endsWith("\n"), Boolean);
    const stdout = fs.readFileSync(out, "utf8");
    let json: any;
    try {
      json = JSON.parse(stdout);
    } catch {}
    return { code: Number(fs.readFileSync(done, "utf8")), json, stdout };
  }
  async function close() {
    await Promise.resolve(core.close()).catch(() => {});
    // Only the private tmux server this test's core started.
    if (socket)
      try {
        execFileSync(tmux, ["-S", socket, "kill-server"], { stdio: "ignore" });
      } catch {}
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return {
    temp,
    home,
    bin,
    repo,
    dataDir,
    core,
    call,
    project,
    sessionOf,
    pane,
    paneEnv,
    starts,
    type,
    setMode,
    inPane,
    setSocket(s: string) {
      socket = s;
    },
    close,
  };
}
