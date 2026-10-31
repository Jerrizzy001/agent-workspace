import http from "node:http";
import crypto from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

/**
 * A local fake OpenID Connect issuer for tests only: discovery, an
 * auto-approving authorization endpoint (the user is picked by `login_hint`),
 * a token endpoint with PKCE and client authentication, and a JWKS endpoint
 * with key rotation. It also lets a test tamper with the next ID token.
 * Nothing here talks to a real identity provider.
 */
export async function startFakeIssuer({ clientId = "agent-workspace-test", clientSecret = "fixture-secret", users } = {}) {
  const people = users ?? {
    alice: { sub: "alice-sub", email: "alice@example.test", name: "Alice Owner", email_verified: true },
    bob: { sub: "bob-sub", email: "bob@example.test", name: "Bob Member", email_verified: true },
    carol: { sub: "carol-sub", email: "carol@example.test", name: "Carol Viewer", email_verified: true },
    dave: { sub: "dave-sub", email: "dave@example.test", name: "Dave Admin", email_verified: true },
    frank: { sub: "frank-sub", email: "frank@other.test", name: "Frank Outsider", email_verified: true },
  };
  let defaultUser = Object.keys(people)[0];
  const keys = [];
  async function addKey() {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const kid = crypto.randomBytes(8).toString("hex");
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
    keys.unshift({ kid, privateKey, jwk, published: true });
    return kid;
  }
  await addKey();
  const codes = new Map();
  let tamper = null;
  const stats = { authorize: 0, token: 0, jwks: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, {
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
        scopes_supported: ["openid", "email", "profile"],
      });
    if (url.pathname === "/jwks") {
      stats.jwks++;
      return json(200, { keys: keys.filter((k) => k.published).map((k) => k.jwk) });
    }
    if (url.pathname === "/authorize") {
      stats.authorize++;
      const q = url.searchParams;
      const redirect = q.get("redirect_uri");
      if (q.get("client_id") !== clientId || q.get("response_type") !== "code" || !redirect)
        return json(400, { error: "invalid_request" });
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
        return json(400, { error: "invalid_request", error_description: "PKCE required" });
      const user = people[q.get("login_hint") || defaultUser];
      if (!user) return json(400, { error: "unknown user" });
      const code = crypto.randomBytes(16).toString("base64url");
      codes.set(code, {
        redirect,
        challenge: q.get("code_challenge"),
        nonce: q.get("nonce"),
        user,
        at: Date.now(),
      });
      const target = new URL(redirect);
      target.searchParams.set("code", code);
      if (q.get("state") !== null) target.searchParams.set("state", q.get("state"));
      res.writeHead(302, { location: target.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      stats.token++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      let id = form.get("client_id");
      let secret = form.get("client_secret");
      const basic = req.headers.authorization;
      if (basic?.startsWith("Basic ")) {
        const [u, p] = Buffer.from(basic.slice(6), "base64").toString().split(":").map(decodeURIComponent);
        id = u;
        secret = p;
      }
      if (id !== clientId || (clientSecret && secret !== clientSecret)) return json(401, { error: "invalid_client" });
      const entry = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      if (!entry || form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== entry.redirect)
        return json(400, { error: "invalid_grant" });
      const verifier = form.get("code_verifier") || "";
      if (crypto.createHash("sha256").update(verifier).digest("base64url") !== entry.challenge)
        return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      const t = tamper || {};
      tamper = null;
      const key = t.signWith ?? keys.find((k) => k.published) ?? keys[0];
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: entry.user.sub,
        email: entry.user.email,
        email_verified: entry.user.email_verified,
        name: entry.user.name,
        nonce: t.nonce ?? entry.nonce,
        ...(t.extra || {}),
      };
      const jwt = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
        .setIssuer(t.issuer ?? issuer)
        .setAudience(t.audience ?? clientId)
        .setIssuedAt(t.iat ?? now)
        .setExpirationTime(t.exp ?? now + 300)
        .sign(key.privateKey);
      return json(200, { access_token: crypto.randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: jwt });
    }
    json(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  return {
    issuer,
    clientId,
    clientSecret,
    stats,
    users: people,
    useUser(name) {
      defaultUser = name;
    },
    /** Tamper with the next ID token: { issuer, audience, nonce, exp, iat, extra, signWith }. */
    tamperNext(value) {
      tamper = value;
    },
    /** Publishes a new signing key; with retireOld the previous keys leave the JWKS. */
    async rotateKey({ retireOld = false } = {}) {
      const kid = await addKey();
      if (retireOld) for (const k of keys.slice(1)) k.published = false;
      return kid;
    },
    /** The newest signing key (to sign with it again after it is retired). */
    currentKey() {
      return keys[0];
    },
    /** A signing key the JWKS never published. */
    async rogueKey() {
      const { privateKey } = await generateKeyPair("RS256");
      return { kid: keys[0].kid, privateKey };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
