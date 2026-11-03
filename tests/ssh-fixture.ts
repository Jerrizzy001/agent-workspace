/**
 * A disposable OpenSSH server on a high loopback port for SSH tests: its own
 * config, throwaway host and user keys and known_hosts in a temp folder. No
 * system SSH configuration or the user's ~/.ssh is read or written (the only
 * system change is sshd's own empty privilege-separation directory when it is
 * missing). The "remote" helper is a launcher in a temp install folder that
 * runs this checkout's stdio host with its own data folder (and so its own
 * tmux socket).
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  execFileSync,
  spawnSync,
  spawn,
  type ChildProcess,
} from "node:child_process";

export const SSHD = "/usr/sbin/sshd";
export const sshAvailable = () =>
  fs.existsSync(SSHD) &&
  ["ssh", "ssh-keygen", "ssh-keyscan"].every((bin) => {
    try {
      execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
const repo = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}
async function waitForPort(port: number) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("sshd fixture did not start");
}

export interface SshFixture {
  dir: string;
  port: number;
  alias: string;
  config: string;
  knownHosts: string;
  /** The host key line as ssh-keyscan reports it. */
  hostKeyLine: string;
  /** SHA256 fingerprint of the fixture host key. */
  fingerprint: string;
  remoteData: string;
  helperDir: string;
  remoteBin: string;
  trust(): void;
  distrust(): void;
  /** Pins a different (wrong) key for the host. */
  wrongKey(): void;
  /** Writes the helper launcher; `body` replaces the real helper (malicious fixtures). */
  installHelper(options?: { body?: string; extraPath?: string }): void;
  stop(): Promise<void>;
}

export async function startSshFixture(prefix = "aw-ssh-"): Promise<SshFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const version = String(
    spawnSync(SSHD, ["-V"], { encoding: "utf8" }).stderr,
  ).match(/OpenSSH_(\d+)\.(\d+)/);
  const penalties =
    version &&
    (Number(version[1]) >= 10 ||
      (Number(version[1]) === 9 && Number(version[2]) >= 8));
  const key = (name: string) =>
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      name,
      "-f",
      path.join(dir, name),
    ]);
  key("host_key");
  key("user_key");
  key("other_host_key");
  fs.copyFileSync(
    path.join(dir, "user_key.pub"),
    path.join(dir, "authorized_keys"),
  );
  fs.chmodSync(path.join(dir, "authorized_keys"), 0o600);
  const port = await freePort();
  const sshdConfig = path.join(dir, "sshd_config");
  fs.writeFileSync(
    sshdConfig,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${dir}/host_key`,
      `AuthorizedKeysFile ${dir}/authorized_keys`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "UsePAM no",
      "MaxStartups 100",
      ...(penalties ? ["PerSourcePenalties no"] : []),
      "PermitRootLogin prohibit-password",
      "StrictModes no",
      `PidFile ${dir}/sshd.pid`,
      "AllowTcpForwarding no",
      "AllowAgentForwarding no",
      "X11Forwarding no",
      "PermitTTY no",
      "PermitUserEnvironment no",
      "",
    ].join("\n"),
  );
  // sshd refuses to start without its (empty) privilege separation directory.
  if (process.platform === "linux" && !fs.existsSync("/run/sshd"))
    fs.mkdirSync("/run/sshd", { mode: 0o755 });
  const sshd: ChildProcess = spawn(SSHD, ["-D", "-e", "-f", sshdConfig], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let sshdLog = "";
  sshd.stderr!.on("data", (b) => {
    if (sshdLog.length < 65536) sshdLog += b;
  });
  await waitForPort(port);
  const pub = fs
    .readFileSync(path.join(dir, "host_key.pub"), "utf8")
    .trim()
    .split(" ");
  const hostKeyLine = `[127.0.0.1]:${port} ${pub[0]} ${pub[1]}`;
  const other = fs
    .readFileSync(path.join(dir, "other_host_key.pub"), "utf8")
    .trim()
    .split(" ");
  const fingerprint = execFileSync(
    "ssh-keygen",
    ["-l", "-f", path.join(dir, "host_key.pub")],
    {
      encoding: "utf8",
    },
  ).split(" ")[1]!;
  const knownHosts = path.join(dir, "known_hosts");
  const alias = "aw-fixture";
  const config = path.join(dir, "ssh_config");
  fs.writeFileSync(
    config,
    [
      `Host ${alias}`,
      "  HostName 127.0.0.1",
      `  Port ${port}`,
      `  User ${os.userInfo().username}`,
      `  IdentityFile ${dir}/user_key`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${knownHosts}`,
      "  GlobalKnownHostsFile /dev/null",
      "",
    ].join("\n"),
  );
  const remoteData = path.join(dir, "remote-data");
  const helperDir = path.join(dir, "remote-helper");
  const remoteBin = path.join(dir, "remote-bin");
  fs.mkdirSync(remoteBin);
  const fixture: SshFixture = {
    dir,
    port,
    alias,
    config,
    knownHosts,
    hostKeyLine,
    fingerprint,
    remoteData,
    helperDir,
    remoteBin,
    trust: () => fs.writeFileSync(knownHosts, hostKeyLine + "\n"),
    distrust: () => fs.writeFileSync(knownHosts, ""),
    wrongKey: () =>
      fs.writeFileSync(
        knownHosts,
        `[127.0.0.1]:${port} ${other[0]} ${other[1]}\n`,
      ),
    installHelper(options = {}) {
      fs.mkdirSync(path.join(helperDir, "bin"), { recursive: true });
      const launcher = path.join(helperDir, "bin", "aw-ssh-helper");
      fs.writeFileSync(
        launcher,
        options.body ??
          `#!/bin/sh\nexport PATH=${options.extraPath ? shellQuote(options.extraPath + ":") : ""}"$PATH"\nexec ${shellQuote(process.execPath)} ${shellQuote(tsxCli)} ${shellQuote(path.join(repo, "src/server/stdio-host.ts"))} "$@"\n`,
        { mode: 0o755 },
      );
    },
    async stop() {
      if (sshd.exitCode === null) {
        sshd.kill("SIGTERM");
        await new Promise((r) => sshd.once("exit", r));
      }
    },
  };
  fixture.trust();
  return fixture;
}

export function tmuxSocketFor(dataDir: string) {
  return path.join(
    os.tmpdir(),
    "aw-" +
      crypto
        .createHash("sha256")
        .update(fs.realpathSync(dataDir))
        .digest("hex")
        .slice(0, 20) +
      ".sock",
  );
}
/** Kills only the tmux server a fixture core created for this data folder. */
export function killTmuxFor(dataDir: string) {
  if (!fs.existsSync(dataDir)) return;
  const socket = tmuxSocketFor(dataDir);
  try {
    execFileSync(
      process.env.WORKSPACE_TMUX || "tmux",
      ["-S", socket, "kill-server"],
      { stdio: "ignore" },
    );
  } catch {}
  fs.rmSync(socket, { force: true });
}
