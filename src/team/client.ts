import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  TEAM_PROTOCOL,
  type TeamAction,
  type TeamServiceInfo,
  type TeamSessionTokens,
} from "../shared/team-contracts.js";

/**
 * Desktop side of the team service: the native sign-in (system browser,
 * loopback redirect, PKCE; RFC 8252) and an authenticated API client. Runs in
 * the Electron main process; Electron-free so tests drive it directly. Team
 * tokens only ever go to the configured team service URL.
 */
export class TeamClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public current?: unknown,
  ) {
    super(message);
  }
}
const LOOPBACK = ["127.0.0.1", "[::1]", "localhost"];

/** https:// anywhere, or http:// on a loopback address only (development). */
export function checkServiceUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 300) throw new Error("Enter the team service address");
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new Error("Enter the team service address, for example https://team.example.com");
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== ""))
    throw new Error("The team service address must be an origin without a path, query or credentials");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.includes(u.hostname)))
    throw new Error("The team service must use HTTPS (plain HTTP only on this computer's loopback address)");
  return u.origin;
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new TeamClientError(0, "offline", "The team service could not be reached");
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok)
    throw new TeamClientError(res.status, body?.code || "server", typeof body?.error === "string" ? body.error.slice(0, 300) : "Team service error " + res.status, body?.current);
  return body;
}
const post = (fetchImpl: typeof fetch, url: string, payload: unknown, token?: string) =>
  request(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(payload),
  });

export interface NativeLoginOptions {
  serviceUrl: string;
  invitation?: string;
  /** Opens the authorization URL in the system browser. */
  openUrl: (url: string) => Promise<void> | void;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Called once the loopback listener is ready (tests). */
  onListening?: (redirectUri: string) => void;
}

/** Authorization Code + PKCE through the system browser and a one-shot loopback callback. */
export async function nativeLogin(options: NativeLoginOptions): Promise<TeamSessionTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = checkServiceUrl(options.serviceUrl);
  const info = (await request(fetchImpl, base + "/v1/info", { method: "GET" })) as TeamServiceInfo;
  if (info?.protocol !== TEAM_PROTOCOL) throw new Error("This team service speaks a different protocol version");
  const host = info.redirect?.host;
  if (host !== "127.0.0.1" && host !== "[::1]") throw new Error("The team service asked for a non-loopback redirect");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  let expectedState = "";
  let settle!: { resolve: (p: Record<string, string>) => void; reject: (e: Error) => void };
  const callback = new Promise<Record<string, string>>((resolve, reject) => (settle = { resolve, reject }));
  const page = (res: http.ServerResponse, status: number, message: string) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "referrer-policy": "no-referrer",
    });
    res.end(`<!doctype html><meta charset="utf-8"><title>Agent Workspace</title><p>${message}</p>`);
  };
  let done = false;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://loopback.invalid");
    if (req.method !== "GET" || u.pathname !== info.redirect.path || done) return page(res, 404, "Not found.");
    const params: Record<string, string> = {};
    for (const [k, v] of u.searchParams) params[k] = v;
    // Exact state match before anything else; a mismatch ends this attempt.
    if (!expectedState || params.state !== expectedState) {
      done = true;
      page(res, 400, "This sign-in response does not belong to the current attempt. Return to Agent Workspace and try again.");
      return settle.reject(new Error("The sign-in response did not match this attempt (state mismatch)"));
    }
    done = true;
    if (params.error) {
      page(res, 400, "Sign-in was cancelled or refused. You can close this window.");
      return settle.reject(new Error("Sign-in was refused: " + String(params.error).slice(0, 100)));
    }
    page(res, 200, "Signed in. You can close this window and return to Agent Workspace.");
    settle.resolve(params);
  });
  const bindHost = host === "[::1]" ? "::1" : host;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(info.redirect.port ?? 0, bindHost, () => resolve());
  });
  const timer = setTimeout(() => settle.reject(new Error("Sign-in timed out")), options.timeoutMs ?? 5 * 60_000);
  try {
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://${host}:${port}${info.redirect.path}`;
    options.onListening?.(redirectUri);
    const start = await post(fetchImpl, base + "/v1/auth/start", {
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      ...(options.invitation?.trim() ? { invitation: options.invitation.trim() } : {}),
    });
    expectedState = String(start.state);
    const authUrl = new URL(start.authorizationUrl);
    if (authUrl.protocol !== "https:" && !(authUrl.protocol === "http:" && LOOPBACK.includes(authUrl.hostname)))
      throw new Error("The identity provider address is not HTTPS");
    await options.openUrl(authUrl.toString());
    const params = await callback;
    const picked: Record<string, string> = {};
    for (const k of ["code", "state", "iss", "session_state", "scope"]) if (params[k] !== undefined) picked[k] = params[k];
    return (await post(fetchImpl, base + "/v1/auth/finish", {
      transactionId: start.transactionId,
      params: picked,
      codeVerifier: verifier,
    })) as TeamSessionTokens;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}

export interface TeamClientOptions {
  serviceUrl: string;
  tokens: () => TeamSessionTokens | null;
  saveTokens: (tokens: TeamSessionTokens | null) => Promise<void> | void;
  fetchImpl?: typeof fetch;
}
/** Authenticated calls; refreshes the short-lived session once on expiry. */
export function createTeamClient(options: TeamClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = checkServiceUrl(options.serviceUrl);
  let refreshing: Promise<void> | null = null;
  async function refresh() {
    refreshing ??= (async () => {
      const current = options.tokens();
      if (!current) throw new TeamClientError(401, "unauthenticated", "Sign in to the team service");
      try {
        const next = (await post(fetchImpl, base + "/v1/auth/refresh", { refreshToken: current.refreshToken })) as TeamSessionTokens;
        await options.saveTokens(next);
      } catch (error) {
        if (error instanceof TeamClientError && error.status === 401) await options.saveTokens(null);
        throw error;
      }
    })().finally(() => (refreshing = null));
    return refreshing;
  }
  return {
    base,
    async call<T = any>(action: TeamAction, payload: Record<string, unknown> = {}): Promise<T> {
      let tokens = options.tokens();
      if (!tokens) throw new TeamClientError(401, "unauthenticated", "Sign in to the team service");
      if (Date.parse(tokens.expiresAt) - 30_000 < Date.now()) {
        await refresh();
        tokens = options.tokens()!;
      }
      try {
        return await post(fetchImpl, `${base}/v1/call/${action}`, payload, tokens.sessionToken);
      } catch (error) {
        if (!(error instanceof TeamClientError) || error.status !== 401) throw error;
        await refresh();
        return await post(fetchImpl, `${base}/v1/call/${action}`, payload, options.tokens()!.sessionToken);
      }
    },
    async logout() {
      const tokens = options.tokens();
      if (tokens)
        await request(fetchImpl, base + "/v1/auth/logout", {
          method: "POST",
          headers: { authorization: "Bearer " + tokens.sessionToken },
        }).catch(() => {});
    },
  };
}
export type TeamClient = ReturnType<typeof createTeamClient>;
