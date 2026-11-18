import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createTeam, startTeamService } from "./service.js";
import { backupTeamStore, openTeamStore } from "./store.js";
import type { OidcSettings } from "./auth.js";

/**
 * Team service entrypoint (see docs/team-service.md).
 *
 *   node dist/team/server.mjs --config team-service.json            serve
 *   node dist/team/server.mjs --config team-service.json init-team --name "Acme" [--owner-email a@b] [--hours 72]
 *   node dist/team/server.mjs --config team-service.json backup <file>
 *
 * The config names any standards-compliant OIDC issuer; nothing here is tied
 * to one identity provider or host.
 */
interface ConfigFile {
  dataDir: string;
  listen?: { host?: string; port?: number; certFile?: string; keyFile?: string; publicOrigin?: string };
  oidc: Omit<OidcSettings, "clientSecret"> & { clientSecretFile?: string; clientSecretEnv?: string };
  sessionMinutes?: number;
  refreshDays?: number;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    name: { type: "string" },
    "owner-email": { type: "string" },
    hours: { type: "string" },
  },
});
if (!values.config) {
  console.error("Usage: server.mjs --config <file> [init-team --name <team> | backup <file>]");
  process.exit(2);
}
const configPath = path.resolve(values.config);
const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigFile;
const dataDir = path.resolve(path.dirname(configPath), config.dataDir);
const command = positionals[0] ?? "serve";

if (command === "init-team") {
  if (!values.name) throw new Error("init-team needs --name");
  const db = openTeamStore(dataDir);
  const team = createTeam(db, {
    name: values.name,
    ownerEmail: values["owner-email"],
    hours: values.hours ? Number(values.hours) : undefined,
  });
  db.close();
  console.log(`Team "${team.name}" created (${team.teamId}).`);
  console.log(`Owner invitation (shown once, expires ${team.expiresAt}):`);
  console.log(team.code);
  process.exit(0);
}
if (command === "backup") {
  const target = positionals[1];
  if (!target) throw new Error("backup needs a target file");
  const db = openTeamStore(dataDir);
  await backupTeamStore(db, path.resolve(target));
  db.close();
  console.log("Backup written to " + path.resolve(target));
  process.exit(0);
}
if (command !== "serve") throw new Error("Unknown command " + command);

const secret = config.oidc.clientSecretFile
  ? fs.readFileSync(path.resolve(path.dirname(configPath), config.oidc.clientSecretFile), "utf8").trim()
  : config.oidc.clientSecretEnv
    ? process.env[config.oidc.clientSecretEnv]
    : undefined;
const { clientSecretFile: _f, clientSecretEnv: _e, ...oidc } = config.oidc;
const listen = config.listen ?? {};
const tls =
  listen.certFile && listen.keyFile
    ? {
        cert: fs.readFileSync(path.resolve(path.dirname(configPath), listen.certFile)),
        key: fs.readFileSync(path.resolve(path.dirname(configPath), listen.keyFile)),
      }
    : undefined;
const service = await startTeamService({
  dataDir,
  host: listen.host,
  port: listen.port ?? 8790,
  tls,
  publicOrigin: listen.publicOrigin,
  oidc: { ...oidc, ...(secret ? { clientSecret: secret } : {}) },
  sessionMs: config.sessionMinutes ? config.sessionMinutes * 60_000 : undefined,
  refreshMs: config.refreshDays ? config.refreshDays * 86_400_000 : undefined,
});
console.log(`Team service listening on ${service.url}`);
const stop = async () => {
  await service.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
