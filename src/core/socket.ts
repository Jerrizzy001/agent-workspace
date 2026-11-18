import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
/** Unix sun_path is short (104 bytes on macOS); old persisted sockets stay authoritative. */
export function workspaceSocket(dataDir: string) {
  const durable = path.join(dataDir, "tmux.sock");
  return Buffer.byteLength(durable) < 100
    ? durable
    : path.join(
        os.tmpdir(),
        `aw-${crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 20)}.sock`,
      );
}
