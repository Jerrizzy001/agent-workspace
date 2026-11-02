import { isDirectEntry } from "../shared/entrypoint.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCore } from "../core/index.js";
import { startGateway } from "./gateway.js";
import type { CoreEvent } from "../shared/contracts.js";
/** Standalone Node 24 host; never imported by the desktop shell. */
export async function runHeadless(args = process.argv.slice(2)) {
  const values: Record<string, string> = {},
    projects: string[] = [];
  const allowed = [
    "data-dir",
    "host",
    "port",
    "tls-cert",
    "tls-key",
    "public-origin",
    "static-dir",
    "project",
  ];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      process.stdout.write(
        "Agent Workspace host (Node 24+)\n--data-dir PATH --host ADDRESS --port PORT\n--tls-cert PATH --tls-key PATH --public-origin https://host:port\n--static-dir PATH --project PATH (repeatable, owner-authorized registration)\nEnvironment: DATA_DIR HOST PORT TLS_CERT TLS_KEY PUBLIC_ORIGIN STATIC_DIR\nPairing secret: DATA_DIR/remote-pairing.secret (owner-only file; never logged)\n",
      );
      return;
    }
    if (
      !arg.startsWith("--") ||
      !allowed.includes(arg.slice(2)) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error("Invalid option; use --help");
    const value = args[++i];
    if (arg === "--project") projects.push(value);
    else values[arg.slice(2)] = value;
  }
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Node 24 or newer is required");
  const dataDir = path.resolve(
    values["data-dir"] ||
      process.env.DATA_DIR ||
      path.join(os.homedir(), ".agent-workspace"),
  );
  const listeners = new Set<(e: CoreEvent) => void>();
  const core = await createCore({
    dataDir,
    emit: (e) => {
      for (const listener of listeners) listener(e);
    },
  });
  try {
    for (const project of projects)
      await core.invoke("project.add", { path: path.resolve(project) });
    const cert = values["tls-cert"] || process.env.TLS_CERT,
      key = values["tls-key"] || process.env.TLS_KEY;
    if (!!cert !== !!key)
      throw new Error("Both TLS_CERT and TLS_KEY are required");
    const portValue = values.port || process.env.PORT || "8787";
    if (!/^\d+$/.test(portValue)) throw new Error("Invalid port");
    const gateway = await startGateway({
      dataDir,
      invoke: (c, p) => core.invoke(c, p),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      host: values.host || process.env.HOST || "127.0.0.1",
      port: Number(portValue),
      tls:
        cert && key
          ? { cert: fs.readFileSync(cert), key: fs.readFileSync(key) }
          : undefined,
      publicOrigin: values["public-origin"] || process.env.PUBLIC_ORIGIN,
      staticDir: path.resolve(
        values["static-dir"] ||
          process.env.STATIC_DIR ||
          fileURLToPath(new URL("../renderer/", import.meta.url)),
      ),
    });
    const status = gateway.status();
    process.stdout.write(
      JSON.stringify({
        service: "Agent Workspace",
        url: status.url,
        host: status.host,
        port: status.port,
        tls: status.tls,
        pairingFile: path.join(dataDir, "remote-pairing.secret"),
      }) + "\n",
    );
    let stopping: Promise<void> | undefined;
    const onSignal = () => {
      void stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    const stop = () => {
      if (stopping) return stopping;
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        process.removeListener(signal, onSignal);
      stopping = (async () => {
        await gateway.stop();
        await core.close();
      })();
      return stopping;
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, onSignal);
    return { core, gateway, stop };
  } catch (error) {
    await core.close();
    throw error;
  }
}
if (isDirectEntry(import.meta.url)) {
  void runHeadless().catch((error) => {
    process.stderr.write(
      "Agent Workspace host: " + String(error.message).slice(0, 512) + "\n",
    );
    process.exitCode = 1;
  });
}
