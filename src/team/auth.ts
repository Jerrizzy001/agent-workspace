import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as client from "openid-client";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { TeamError } from "./authorization.js";
import type { TeamIdentity, TeamSessionTokens } from "../shared/team-contracts.js";

/**
 * OpenID Connect relying party for the team service. Any standards-compliant
 * issuer works: the owner configures its issuer URL, client ID (and secret
 * for a confidential client) and the loopback redirect the desktop listens
 * on. Authorization Code + PKCE with exact issuer, audience, state, nonce
 * and signature checks. Members are identified by issuer + subject.
 */
export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
  /** Desktop loopback redirect, e.g. "http://127.0.0.1/callback" (any port) or with a fixed port. */
  redirectUri: string;
  /** Extra audiences an ID token may also name (the client ID is always required). */
  allowedAudiences?: string[];
  algorithms?: string[];
  scopes?: string;
  /** Development and tests only: allow an http:// issuer on a loopback address. */
  allowHttpLoopbackIssuer?: boolean;
  /** Minimum time between JWKS refetches when an unknown key ID appears. */
  jwksCooldownMs?: number;
  /** How long fetched keys are trusted before a refetch; a retired key stops working after this. */
  jwksCacheMaxAgeMs?: number;
  clockToleranceSeconds?: number;
}
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);
export const isLoopback = (host: string) => LOOPBACK.has(host);
const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const b64sha = (v: string) => crypto.createHash("sha256").update(v).digest("base64url");
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const nowIso = () => new Date().toISOString();

/** The configured redirect: loopback http only (RFC 8252 7.3), port null means any port. */
export function redirectShape(uri: string) {
  const u = new URL(uri);
  if (u.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(u.hostname))
    throw new Error("The redirect URI must be http://127.0.0.1 or http://[::1] (RFC 8252 loopback)");
  if (u.username || u.password || u.search || u.hash || !u.pathname.startsWith("/"))
    throw new Error("The redirect URI must have only a path");
  return { host: u.hostname, port: u.port ? Number(u.port) : null, path: u.pathname };
}
export function checkClientRedirect(settings: OidcSettings, value: unknown) {
  if (typeof value !== "string" || value.length > 300) throw new TeamError(400, "invalid", "Invalid redirect URI");
  const shape = redirectShape(settings.redirectUri);
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new TeamError(400, "invalid", "Invalid redirect URI");
  }
  const port = Number(u.port);
  if (
    u.protocol !== "http:" ||
    u.hostname !== shape.host ||
    u.pathname !== shape.path ||
    u.search ||
    u.hash ||
    u.username ||
    u.password ||
    !Number.isInteger(port) ||
    port < 1024 ||
    (shape.port !== null && port !== shape.port)
  )
    throw new TeamError(400, "invalid", "The redirect URI does not match this service's configuration");
  return u.toString();
}

export function createOidc(settings: OidcSettings) {
  const issuerUrl = new URL(settings.issuer);
  const insecure = issuerUrl.protocol === "http:";
  if (insecure && !(settings.allowHttpLoopbackIssuer && isLoopback(issuerUrl.hostname)))
    throw new Error("The OIDC issuer must use HTTPS");
  if (issuerUrl.protocol !== "https:" && !insecure) throw new Error("Invalid issuer URL");
  redirectShape(settings.redirectUri);
  const algorithms = settings.algorithms?.length ? settings.algorithms : ["RS256", "ES256", "PS256", "EdDSA"];
  if (algorithms.some((a) => a === "none" || a.startsWith("HS")))
    throw new Error("Only asymmetric ID token algorithms are accepted");
  const audiences = new Set([settings.clientId, ...(settings.allowedAudiences ?? [])]);
  let discovered: Promise<{ config: client.Configuration; jwks: ReturnType<typeof createRemoteJWKSet> }> | undefined;
  function load() {
    discovered ??= (async () => {
      const auth =
        settings.tokenEndpointAuthMethod === "none" || !settings.clientSecret
          ? client.None()
          : settings.tokenEndpointAuthMethod === "client_secret_post"
            ? client.ClientSecretPost(settings.clientSecret)
            : client.ClientSecretBasic(settings.clientSecret);
      const config = await client.discovery(
        issuerUrl,
        settings.clientId,
        { id_token_signed_response_alg: algorithms[0] },
        auth,
        insecure ? { execute: [client.allowInsecureRequests] } : undefined,
      );
      const meta = config.serverMetadata();
      // Exact issuer match (OIDC Discovery 4.3); openid-client checks it too.
      if (meta.issuer !== settings.issuer) throw new Error("Issuer metadata does not match the configured issuer");
      if (!meta.jwks_uri) throw new Error("The issuer publishes no JWKS");
      const jwks = createRemoteJWKSet(new URL(meta.jwks_uri), {
        cooldownDuration: settings.jwksCooldownMs ?? 30_000,
        cacheMaxAge: settings.jwksCacheMaxAgeMs ?? 10 * 60_000,
      });
      return { config, jwks };
    })().catch((error) => {
      discovered = undefined;
      throw error;
    });
    return discovered;
  }
  return {
    settings,
    async authorizationUrl(input: { redirectUri: string; state: string; nonce: string; codeChallenge: string }) {
      const { config } = await load();
      return client
        .buildAuthorizationUrl(config, {
          redirect_uri: input.redirectUri,
          scope: settings.scopes || "openid email profile",
          response_type: "code",
          state: input.state,
          nonce: input.nonce,
          code_challenge: input.codeChallenge,
          code_challenge_method: "S256",
        })
        .toString();
    },
    /** Exchanges the code and returns verified ID token claims. */
    async exchange(input: {
      redirectUri: string;
      params: Record<string, string>;
      state: string;
      nonce: string;
      codeVerifier: string;
    }): Promise<JWTPayload & { sub: string; iss: string }> {
      const { config, jwks } = await load();
      const callback = new URL(input.redirectUri);
      for (const [k, v] of Object.entries(input.params)) callback.searchParams.set(k, v);
      let tokens;
      try {
        tokens = await client.authorizationCodeGrant(config, callback, {
          pkceCodeVerifier: input.codeVerifier,
          expectedState: input.state,
          expectedNonce: input.nonce,
          idTokenExpected: true,
        });
      } catch (error) {
        const cause = (error as any)?.cause?.message;
        throw new TeamError(401, "unauthenticated", "Sign-in was not accepted: " + (typeof cause === "string" ? cause : error instanceof Error ? error.message : "token exchange failed"));
      }
      const idToken = tokens.id_token;
      if (!idToken) throw new TeamError(401, "unauthenticated", "The issuer returned no ID token");
      // Signature, issuer, audience and lifetime, checked with the issuer's
      // current keys (an unknown key ID refetches the JWKS after the cooldown).
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(idToken, jwks, {
          issuer: settings.issuer,
          audience: settings.clientId,
          algorithms,
          clockTolerance: settings.clockToleranceSeconds ?? 60,
          requiredClaims: ["sub", "iat", "exp", "nonce"],
        }));
      } catch (error) {
        throw new TeamError(401, "unauthenticated", "The ID token was rejected: " + (error instanceof Error ? error.message : "invalid"));
      }
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (aud.some((a) => typeof a !== "string" || !audiences.has(a)))
        throw new TeamError(401, "unauthenticated", "The ID token names an audience this service does not allow");
      if (aud.length > 1 && payload.azp !== settings.clientId)
        throw new TeamError(401, "unauthenticated", "The ID token's authorized party is not this client");
      if (payload.nonce !== input.nonce) throw new TeamError(401, "unauthenticated", "The ID token nonce does not match");
      if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255)
        throw new TeamError(401, "unauthenticated", "The ID token has no usable subject");
      return payload as JWTPayload & { sub: string; iss: string };
    },
  };
}
export type Oidc = ReturnType<typeof createOidc>;

/** Short-lived login transactions (state, nonce, PKCE challenge), each usable once. */
export function createLoginTransactions(db: DatabaseSync, ttlMs = 10 * 60_000) {
  return {
    create(input: { redirectUri: string; codeChallenge: string; invitation?: string }) {
      const id = crypto.randomUUID();
      const state = random();
      const nonce = random();
      const created = Date.now();
      db.prepare("DELETE FROM login_transactions WHERE expires_at < ?").run(new Date(created - 60_000).toISOString());
      db.prepare(
        "INSERT INTO login_transactions VALUES (?,?,?,?,?,?,?,?,NULL)",
      ).run(
        id,
        state,
        nonce,
        input.redirectUri,
        input.codeChallenge,
        input.invitation ? sha256(input.invitation) : null,
        new Date(created).toISOString(),
        new Date(created + ttlMs).toISOString(),
      );
      return { id, state, nonce };
    },
    /** Marks the transaction used before anything else happens: a replay always fails. */
    take(id: unknown, codeVerifier: unknown) {
      if (typeof id !== "string" || typeof codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier))
        throw new TeamError(400, "invalid", "Invalid sign-in completion");
      const row = db.prepare("SELECT * FROM login_transactions WHERE id=?").get(id) as any;
      if (!row || row.used_at) throw new TeamError(401, "unauthenticated", "This sign-in attempt is unknown or was already used");
      db.prepare("UPDATE login_transactions SET used_at=? WHERE id=?").run(nowIso(), id);
      if (Date.parse(row.expires_at) < Date.now()) throw new TeamError(401, "unauthenticated", "This sign-in attempt expired; start again");
      if (b64sha(codeVerifier) !== row.code_challenge)
        throw new TeamError(401, "unauthenticated", "PKCE verification failed");
      return row as {
        id: string;
        state: string;
        nonce: string;
        redirect_uri: string;
        code_challenge: string;
        invitation_hash: string | null;
      };
    },
  };
}

/**
 * Service sessions: opaque random tokens stored only as hashes. Short-lived
 * session tokens plus rotating refresh tokens; reusing a rotated refresh
 * token revokes the whole family.
 */
export function createSessions(db: DatabaseSync, options: { sessionMs?: number; refreshMs?: number } = {}) {
  const sessionMs = options.sessionMs ?? 60 * 60_000;
  const refreshMs = options.refreshMs ?? 14 * 24 * 60 * 60_000;
  function issue(who: TeamIdentity, family = crypto.randomUUID()): TeamSessionTokens {
    const sessionToken = "tst_" + random();
    const refreshToken = "tsr_" + random();
    const at = Date.now();
    const expiresAt = new Date(at + sessionMs).toISOString();
    const refreshExpiresAt = new Date(at + refreshMs).toISOString();
    db.prepare("INSERT INTO service_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)").run(
      crypto.randomUUID(),
      family,
      who.issuer,
      who.subject,
      who.name,
      who.email,
      sha256(sessionToken),
      sha256(refreshToken),
      expiresAt,
      refreshExpiresAt,
      new Date(at).toISOString(),
    );
    return { sessionToken, expiresAt, refreshToken, refreshExpiresAt, identity: who };
  }
  const revokeFamily = (family: string) =>
    db.prepare("UPDATE service_sessions SET revoked_at=? WHERE family=? AND revoked_at IS NULL").run(nowIso(), family);
  return {
    issue,
    authenticate(header: unknown): TeamIdentity & { family: string } {
      const token = typeof header === "string" && header.startsWith("Bearer tst_") ? header.slice(7) : "";
      if (!token || token.length > 100) throw new TeamError(401, "unauthenticated", "Sign in to the team service");
      const row = db.prepare("SELECT * FROM service_sessions WHERE token_hash=?").get(sha256(token)) as any;
      if (!row || row.revoked_at || row.rotated_at || Date.parse(row.expires_at) <= Date.now())
        throw new TeamError(401, "unauthenticated", "Your team session expired or was revoked");
      return { issuer: row.issuer, subject: row.subject, name: row.name, email: row.email, family: row.family };
    },
    refresh(refreshToken: unknown): TeamSessionTokens {
      if (typeof refreshToken !== "string" || !refreshToken.startsWith("tsr_") || refreshToken.length > 100)
        throw new TeamError(401, "unauthenticated", "Sign in again");
      const row = db.prepare("SELECT * FROM service_sessions WHERE refresh_hash=?").get(sha256(refreshToken)) as any;
      if (!row) throw new TeamError(401, "unauthenticated", "Sign in again");
      if (row.rotated_at) {
        // A rotated refresh token came back: assume theft, end every session in the family.
        revokeFamily(row.family);
        throw new TeamError(401, "unauthenticated", "This sign-in was revoked; sign in again");
      }
      if (row.revoked_at || Date.parse(row.refresh_expires_at) <= Date.now())
        throw new TeamError(401, "unauthenticated", "Sign in again");
      // Atomic rotation: of two concurrent refreshes only one wins.
      if (db.prepare("UPDATE service_sessions SET rotated_at=? WHERE id=? AND rotated_at IS NULL").run(nowIso(), row.id).changes !== 1) {
        revokeFamily(row.family);
        throw new TeamError(401, "unauthenticated", "This sign-in was revoked; sign in again");
      }
      return issue({ issuer: row.issuer, subject: row.subject, name: row.name, email: row.email }, row.family);
    },
    revokeFamily,
    prune() {
      db.prepare("DELETE FROM service_sessions WHERE refresh_expires_at < ?").run(nowIso());
    },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
export { sha256 as hashSecret, random as randomSecret };
