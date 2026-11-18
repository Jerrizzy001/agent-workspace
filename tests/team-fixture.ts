import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore - plain JavaScript fixture shared with scripts/verify-team.mjs
import { startFakeIssuer } from "../scripts/fake-oidc.mjs";
import { createTeam, startTeamService, type TeamServiceOptions } from "../src/team/service.js";
import { createTeamClient, nativeLogin } from "../src/team/client.js";
import type { TeamSessionTokens } from "../src/shared/team-contracts.js";

/** A fake issuer plus an isolated team service in a temporary folder. No external services. */
export async function teamFixture(extra: Partial<TeamServiceOptions> = {}, oidcExtra: Record<string, unknown> = {}) {
  const issuer = await startFakeIssuer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-team-"));
  const service = await startTeamService({
    dataDir: path.join(dir, "service"),
    oidc: {
      issuer: issuer.issuer,
      clientId: issuer.clientId,
      clientSecret: issuer.clientSecret,
      redirectUri: "http://127.0.0.1/callback",
      allowHttpLoopbackIssuer: true,
      jwksCooldownMs: 0,
      ...oidcExtra,
    },
    ...extra,
  });
  const team = createTeam(service.db, { name: "Fixture team" });
  async function login(user: string, invitation?: string): Promise<TeamSessionTokens> {
    return nativeLogin({
      serviceUrl: service.url,
      invitation,
      openUrl: async (url) => {
        const u = new URL(url);
        u.searchParams.set("login_hint", user);
        const res = await fetch(u);
        await res.text();
      },
    });
  }
  function client(tokens: TeamSessionTokens) {
    let current: TeamSessionTokens | null = tokens;
    return createTeamClient({
      serviceUrl: service.url,
      tokens: () => current,
      saveTokens: (t) => {
        current = t;
      },
    });
  }
  return {
    issuer,
    service,
    team,
    dir,
    login,
    client,
    async close() {
      await service.stop();
      await issuer.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
