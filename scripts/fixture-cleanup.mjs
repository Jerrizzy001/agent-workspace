import { workspaceSocket } from "../src/core/socket.ts";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Only a runner's own isolated data directory may be passed here.
export async function cleanupFixture(fixture) {
  let data;
  try { data = await realpath(path.join(fixture, "data")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const socket = workspaceSocket(data);
  try {
    execFileSync(process.env.WORKSPACE_TMUX || "/opt/homebrew/bin/tmux", ["-S", socket, "kill-server"], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    // tmux leaves stale socket nodes after its final session/server exits.
    // Never unlink a socket when we cannot establish that its server is gone.
    if (!/no server running|error connecting.*(?:No such file|Connection refused)/i.test(String(error.stderr || error.message))) throw error;
  }
  await rm(socket, { force: true });
}
