// A disposable OpenSSH server on a loopback port for scripts/verify-ssh.mjs:
// own sshd config, throwaway host and user keys, its own known_hosts and
// client config in a temp folder. Nothing in ~/.ssh or /etc/ssh is read or
// written (sshd only needs its empty privilege-separation directory).
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
async function waitForPort(port) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((resolve) => {
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

export async function startSshd(
  dir,
  { alias = "aw-verify", nodePath = process.execPath } = {},
) {
  for (const name of ["host_key", "user_key"])
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
  await copyFile(
    path.join(dir, "user_key.pub"),
    path.join(dir, "authorized_keys"),
  );
  await chmod(path.join(dir, "authorized_keys"), 0o600);
  const port = await freePort();
  await writeFile(
    path.join(dir, "sshd_config"),
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${dir}/host_key`,
      `AuthorizedKeysFile ${dir}/authorized_keys`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "UsePAM no",
      "MaxStartups 100",
      ...(Number(
        String(
          spawnSync("/usr/sbin/sshd", ["-V"], { encoding: "utf8" }).stderr,
        ).match(/OpenSSH_(\d+)/)?.[1] || 0,
      ) >= 10
        ? ["PerSourcePenalties no"]
        : []),
      "PermitRootLogin prohibit-password",
      "StrictModes no",
      "AllowTcpForwarding no",
      "AllowAgentForwarding no",
      "X11Forwarding no",
      "PermitTTY no",
      // The host owner's choice of Node for the helper (Node 24+).
      `SetEnv AW_NODE=${nodePath} LANG=C.UTF-8`,
      "",
    ].join("\n"),
  );
  if (process.platform === "linux" && !existsSync("/run/sshd"))
    mkdirSync("/run/sshd", { mode: 0o755 });
  const sshd = spawn(
    "/usr/sbin/sshd",
    ["-D", "-e", "-f", path.join(dir, "sshd_config")],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  sshd.stderr.on("data", (b) => {
    if (log.length < 65536) log += b;
  });
  await waitForPort(port);
  const pub = (await readFile(path.join(dir, "host_key.pub"), "utf8"))
    .trim()
    .split(" ");
  const knownHosts = path.join(dir, "known_hosts");
  await writeFile(knownHosts, "");
  const config = path.join(dir, "ssh_config");
  await writeFile(
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
  const fingerprint = execFileSync(
    "ssh-keygen",
    ["-l", "-f", path.join(dir, "host_key.pub")],
    { encoding: "utf8" },
  ).split(" ")[1];
  return {
    alias,
    port,
    config,
    knownHosts,
    fingerprint,
    log: () => log,
    /** What the owner does after checking the fingerprint out of band. */
    trust: () =>
      writeFile(knownHosts, `[127.0.0.1]:${port} ${pub[0]} ${pub[1]}\n`),
    async stop() {
      if (sshd.exitCode === null) {
        sshd.kill("SIGTERM");
        await new Promise((r) => sshd.once("exit", r));
      }
    },
  };
}

/**
 * Installs the helper the way an owner would from the server archive: the
 * archive's layout (dist/server, bin/aw-ssh-helper, package.json). Native
 * dependencies come from this checkout's node_modules instead of `npm ci`.
 */
export async function installHelper(
  target,
  repo = process.cwd(),
  archive = process.env.WORKSPACE_VERIFY_SSH_ARCHIVE,
) {
  if (archive) {
    // Exactly the owner's steps: extract the server archive, then npm ci.
    const unpack = target + "-unpack";
    await mkdir(unpack, { recursive: true });
    execFileSync("tar", ["-xzf", path.resolve(archive), "-C", unpack]);
    const [name] = (await import("node:fs")).readdirSync(unpack);
    (await import("node:fs")).renameSync(path.join(unpack, name), target);
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: target,
      stdio: "pipe",
    });
    return "archive";
  }
  await mkdir(path.join(target, "dist"), { recursive: true });
  await cp(path.join(repo, "dist/server"), path.join(target, "dist/server"), {
    recursive: true,
  });
  await mkdir(path.join(target, "bin"));
  await copyFile(
    path.join(repo, "scripts/aw-ssh-helper.sh"),
    path.join(target, "bin/aw-ssh-helper"),
  );
  await chmod(path.join(target, "bin/aw-ssh-helper"), 0o755);
  await copyFile(
    path.join(repo, "package.json"),
    path.join(target, "package.json"),
  );
  await symlink(
    path.join(repo, "node_modules"),
    path.join(target, "node_modules"),
  );
  return "checkout";
}
