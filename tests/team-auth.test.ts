import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { teamFixture } from "./team-fixture.js";
import { createOidc, redirectShape } from "../src/team/auth.js";
import { checkServiceUrl, TeamClientError } from "../src/team/client.js";

const b64sha = (v: string) => crypto.createHash("sha256").update(v).digest("base64url");
const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

/** One sign-in by hand: start, let the fake issuer approve, return the callback parameters. */
async function begin(fx: Awaited<ReturnType<typeof teamFixture>>, user: string, invitation?: string) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const redirectUri = "http://127.0.0.1:49999/callback";
  const start = await post(fx.service.url + "/v1/auth/start", {
    redirectUri,
    codeChallenge: b64sha(verifier),
    codeChallengeMethod: "S256",
    ...(invitation ? { invitation } : {}),
  });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const auth = new URL(start.body.authorizationUrl);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("state"), start.body.state);
  assert.ok(auth.searchParams.get("nonce"));
  auth.searchParams.set("login_hint", user);
  const res = await fetch(auth, { redirect: "manual" });
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin + location.pathname, redirectUri);
  return {
    verifier,
    transactionId: start.body.transactionId,
    params: { code: location.searchParams.get("code")!, state: location.searchParams.get("state")! },
    finish: (override: Record<string, unknown> = {}) =>
      post(fx.service.url + "/v1/auth/finish", {
        transactionId: start.body.transactionId,
        params: { code: location.searchParams.get("code"), state: location.searchParams.get("state") },
        codeVerifier: verifier,
        ...override,
      }),
  };
}

test("owner signs in with an invitation through PKCE and the loopback callback; identity is issuer+subject", async () => {
  const fx = await teamFixture();
  try {
    const tokens = await fx.login("alice", fx.team.code);
    assert.match(tokens.sessionToken, /^tst_/);
    assert.equal(tokens.identity.issuer, fx.issuer.issuer);
    assert.equal(tokens.identity.subject, "alice-sub");
    const me = await fx.client(tokens).call("me");
    assert.deepEqual(me.teams.map((t: any) => [t.name, t.role]), [["Fixture team", "owner"]]);
    // A later sign-in without an invitation works for an active member.
    const again = await fx.login("alice");
    assert.notEqual(again.sessionToken, tokens.sessionToken);
    // The same invitation cannot be used twice, even by someone else.
    await assert.rejects(fx.login("bob", fx.team.code), (e: any) => e instanceof TeamClientError && e.code === "not-invited");
    // No public signup: an authenticated stranger without an invitation is refused.
    await assert.rejects(fx.login("carol"), (e: any) => e.code === "not-invited");
    const row = fx.service.db.prepare("SELECT issuer, subject, status FROM members WHERE subject='alice-sub'").get() as any;
    assert.deepEqual({ ...row }, { issuer: fx.issuer.issuer, subject: "alice-sub", status: "active" });
  } finally {
    await fx.close();
  }
});

test("expired, revoked and email-bound invitations are refused", async () => {
  const fx = await teamFixture();
  try {
    const owner = fx.client(await fx.login("alice", fx.team.code));
    const project = await owner.call("project.create", { teamId: fx.team.teamId, name: "Web", mutationId: crypto.randomUUID() });
    const expired = await owner.call("member.invite", { projectId: project.id, role: "member" });
    fx.service.db.prepare("UPDATE invitations SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), expired.invitationId);
    await assert.rejects(fx.login("bob", expired.code), (e: any) => e.code === "not-invited");
    const revoked = await owner.call("member.invite", { projectId: project.id, role: "member" });
    await owner.call("invitation.revoke", { invitationId: revoked.invitationId });
    await assert.rejects(fx.login("bob", revoked.code), (e: any) => e.code === "not-invited");
    const forCarol = await owner.call("member.invite", { projectId: project.id, role: "member", email: "carol@example.test" });
    await assert.rejects(fx.login("bob", forCarol.code), (e: any) => e.code === "not-invited" && /different email/.test(e.message));
    const carol = await fx.login("carol", forCarol.code);
    assert.equal((await fx.client(carol).call("me")).projects[0].role, "member");
    // A guessed code is refused the same way as an expired one.
    await assert.rejects(fx.login("bob", "twi_" + crypto.randomBytes(24).toString("base64url")), (e: any) => e.code === "not-invited");
  } finally {
    await fx.close();
  }
});

test("ID tokens with the wrong issuer, audience, nonce, lifetime or key are rejected", async () => {
  const fx = await teamFixture();
  try {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["issuer", { issuer: "http://127.0.0.1:1/evil" }, /iss|issuer/i],
      ["audience", { audience: "someone-else" }, /aud|audience/i],
      ["nonce", { nonce: "replayed-nonce" }, /nonce/i],
      ["expired", { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 900 }, /exp|timestamp|expired/i],
      ["extra audience", { audience: [fx.issuer.clientId, "other-api"], extra: { azp: fx.issuer.clientId } }, /audience/i],
    ];
    for (const [label, tamper, pattern] of cases) {
      const flow = await begin(fx, "alice", fx.team.code);
      fx.issuer.tamperNext(tamper);
      const res = await flow.finish();
      assert.equal(res.status, 401, label + ": " + JSON.stringify(res.body));
      assert.match(res.body.error, pattern, label);
    }
    // A key the issuer never published (same key ID) fails signature checks.
    const flow = await begin(fx, "alice", fx.team.code);
    fx.issuer.tamperNext({ signWith: await fx.issuer.rogueKey() });
    const rogue = await flow.finish();
    assert.equal(rogue.status, 401);
    assert.match(rogue.body.error, /signature/i);
    // None of those attempts consumed the invitation.
    const ok = await begin(fx, "alice", fx.team.code);
    assert.equal((await ok.finish()).status, 200);
  } finally {
    await fx.close();
  }
});

test("PKCE, state and single-use transactions are enforced", async () => {
  const fx = await teamFixture();
  try {
    const wrongVerifier = await begin(fx, "alice", fx.team.code);
    const res = await wrongVerifier.finish({ codeVerifier: crypto.randomBytes(32).toString("base64url") });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /PKCE/);
    // The transaction was used up by that attempt.
    assert.equal((await wrongVerifier.finish()).status, 401);
    const wrongState = await begin(fx, "alice", fx.team.code);
    const stateRes = await wrongState.finish({ params: { ...wrongState.params, state: "attacker-state" } });
    assert.equal(stateRes.status, 401);
    assert.match(stateRes.body.error, /state/);
    const good = await begin(fx, "alice", fx.team.code);
    assert.equal((await good.finish()).status, 200);
    assert.equal((await good.finish()).status, 401, "a completed transaction cannot be replayed");
    // Plain challenges and non-loopback redirects are refused at start.
    const bad = [
      { redirectUri: "http://127.0.0.1:49999/callback", codeChallenge: "x".repeat(43), codeChallengeMethod: "plain" },
      { redirectUri: "https://evil.example/callback", codeChallenge: b64sha("v"), codeChallengeMethod: "S256" },
      { redirectUri: "http://127.0.0.1:49999/other", codeChallenge: b64sha("v"), codeChallengeMethod: "S256" },
      { redirectUri: "http://localhost:49999/callback", codeChallenge: b64sha("v"), codeChallengeMethod: "S256" },
      { redirectUri: "http://127.0.0.1:80/callback", codeChallenge: b64sha("v"), codeChallengeMethod: "S256" },
    ];
    for (const body of bad) assert.equal((await post(fx.service.url + "/v1/auth/start", body)).status, 400, JSON.stringify(body));
    // A browser page on another origin cannot call the service.
    const cross = await post(fx.service.url + "/v1/auth/start", bad[1], { origin: "https://evil.example" });
    assert.equal(cross.status, 403);
  } finally {
    await fx.close();
  }
});

test("key rotation: a new signing key is fetched; a retired key is refused", async () => {
  // Keys are trusted for jwksCacheMaxAgeMs (10 minutes by default); 0 here so the retirement shows at once.
  const fx = await teamFixture({}, { jwksCacheMaxAgeMs: 0 });
  try {
    await fx.login("alice", fx.team.code);
    const before = fx.issuer.stats.jwks;
    await fx.issuer.rotateKey();
    await fx.login("alice");
    assert.ok(fx.issuer.stats.jwks > before, "the unknown key ID made the service refetch the JWKS");
    const retired = fx.issuer.currentKey();
    await fx.issuer.rotateKey({ retireOld: true });
    // The issuer stopped publishing that key; a token signed with it now fails.
    const flow = await begin(fx, "alice");
    fx.issuer.tamperNext({ signWith: retired });
    const res = await flow.finish();
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.match(res.body.error, /key|signature/i);
    await fx.login("alice");
  } finally {
    await fx.close();
  }
});

test("service sessions are short-lived, rotate on refresh and are revocable", async () => {
  const fx = await teamFixture({ sessionMs: 1500 });
  try {
    const tokens = await fx.login("alice", fx.team.code);
    const call = (token: string) => post(fx.service.url + "/v1/call/me", {}, { authorization: "Bearer " + token });
    assert.equal((await call(tokens.sessionToken)).status, 200);
    const refreshed = await post(fx.service.url + "/v1/auth/refresh", { refreshToken: tokens.refreshToken });
    assert.equal(refreshed.status, 200);
    assert.equal((await call(tokens.sessionToken)).status, 401, "the rotated session is no longer valid");
    assert.equal((await call(refreshed.body.sessionToken)).status, 200);
    // Reusing the rotated refresh token revokes the whole family.
    assert.equal((await post(fx.service.url + "/v1/auth/refresh", { refreshToken: tokens.refreshToken })).status, 401);
    assert.equal((await call(refreshed.body.sessionToken)).status, 401);
    // Expiry, and the client's automatic refresh.
    const second = await fx.login("alice");
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal((await call(second.sessionToken)).status, 401);
    const client = fx.client(second);
    assert.equal((await client.call("me")).identity.subject, "alice-sub");
    // Logout revokes.
    const third = await fx.login("alice");
    assert.equal((await post(fx.service.url + "/v1/auth/logout", {}, { authorization: "Bearer " + third.sessionToken })).status, 200);
    assert.equal((await call(third.sessionToken)).status, 401);
    assert.equal((await post(fx.service.url + "/v1/auth/refresh", { refreshToken: third.refreshToken })).status, 401);
  } finally {
    await fx.close();
  }
});

test("configuration refuses insecure issuers, symmetric algorithms and non-loopback redirects", () => {
  const base = { clientId: "c", redirectUri: "http://127.0.0.1/callback" };
  assert.throws(() => createOidc({ ...base, issuer: "http://idp.example.com" }), /HTTPS/);
  assert.throws(() => createOidc({ ...base, issuer: "http://127.0.0.1:9" }), /HTTPS/);
  assert.doesNotThrow(() => createOidc({ ...base, issuer: "http://127.0.0.1:9", allowHttpLoopbackIssuer: true }));
  assert.throws(() => createOidc({ ...base, issuer: "https://idp.example.com", algorithms: ["HS256"] }), /asymmetric/);
  assert.throws(() => redirectShape("https://app.example.com/callback"), /loopback/);
  assert.deepEqual(redirectShape("http://127.0.0.1:53682/cb"), { host: "127.0.0.1", port: 53682, path: "/cb" });
  assert.throws(() => checkServiceUrl("http://team.example.com"), /HTTPS/);
  assert.throws(() => checkServiceUrl("https://team.example.com/x?y"), /origin/);
  assert.equal(checkServiceUrl("https://team.example.com/"), "https://team.example.com");
});
