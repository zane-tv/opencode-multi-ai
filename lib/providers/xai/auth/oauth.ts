import {
  AUTH_FETCH_TIMEOUT_MS,
  CLIENT_ID,
  FALLBACK_AUTHORIZE_URL,
  FALLBACK_DEVICE_CODE_URL,
  FALLBACK_TOKEN_URL,
  OAUTH_DISCOVERY_URL,
  OAUTH_EXTRA_PARAMS,
  OAUTH_SCOPE,
  REDIRECT_URI,
} from "../constants.js";
import { logger } from "../../../core/logger.js";

/**
 * xAI SuperGrok OAuth: discovery, authorize-URL building, code exchange,
 * refresh, and JWT decoding.
 *
 * SECURITY:
 * - Discovered endpoints are host-pinned to HTTPS `*.x.ai`. Anything else is
 *   rejected and we fall back to the confirmed constants.
 * - xAI ROTATES refresh tokens on every grant. refreshTokens() always returns
 *   `refresh_token ?? oldRefreshToken` so callers never lose the ability to
 *   refresh again.
 */

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  deviceCodeUrl: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
}

/** Thrown when a refresh grant is rejected with invalid_grant (token dead). */
export class InvalidGrantError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "InvalidGrantError";
    this.status = status;
    this.body = body;
  }
}

/** Thrown on network failures or 5xx responses during an auth request. */
export class TransientAuthError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "TransientAuthError";
    this.status = status;
    this.body = body;
  }
}

const FALLBACK_ENDPOINTS: OAuthEndpoints = {
  authorizeUrl: FALLBACK_AUTHORIZE_URL,
  tokenUrl: FALLBACK_TOKEN_URL,
  deviceCodeUrl: FALLBACK_DEVICE_CODE_URL,
};

/** In-module cache for the resolved endpoints. */
let cachedEndpoints: OAuthEndpoints | null = null;

/**
 * A discovered endpoint is trusted only if it is HTTPS and its host is `x.ai`
 * or a subdomain of `x.ai`.
 */
export function isTrustedEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "x.ai" || host.endsWith(".x.ai");
  } catch {
    return false;
  }
}

/**
 * Re-assert the *.x.ai HTTPS host-pin before POSTing credentials to a URL.
 * Defense in depth (S5): callers may pass an override token URL, so the pin is
 * enforced again at the point of use, not just at discovery. Throws if the URL
 * is untrusted.
 */
export function assertTrustedEndpoint(url: string, what: string): void {
  if (!isTrustedEndpoint(url)) {
    throw new Error(
      `refusing to send credentials for ${what}: untrusted endpoint ${url}`,
    );
  }
}

/**
 * fetch with an AbortController timeout. On timeout the request is aborted and
 * a TransientAuthError is thrown (a hung request is transient, never
 * invalid_grant). The timer is always cleared in finally.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new TransientAuthError(
        `${what} timed out after ${AUTH_FETCH_TIMEOUT_MS}ms`,
      );
    }
    // A network failure during auth is transient, never invalid_grant.
    throw new TransientAuthError(
      `network error during ${what}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve OAuth endpoints via OIDC discovery. Any endpoint whose host is not
 * `*.x.ai` over HTTPS is rejected; on ANY failure we fall back to the confirmed
 * constants. Result is cached in-module.
 */
export async function discoverEndpoints(): Promise<OAuthEndpoints> {
  if (cachedEndpoints) return cachedEndpoints;

  try {
    const res = await fetchWithTimeout(
      OAUTH_DISCOVERY_URL,
      { headers: { accept: "application/json" } },
      "OIDC discovery",
    );
    if (!res.ok) {
      throw new Error(`discovery returned HTTP ${res.status}`);
    }
    const doc = (await res.json()) as Record<string, unknown>;

    const authorizeUrl = String(doc["authorization_endpoint"] ?? "");
    const tokenUrl = String(doc["token_endpoint"] ?? "");
    const deviceCodeUrl = String(
      doc["device_authorization_endpoint"] ?? FALLBACK_DEVICE_CODE_URL,
    );

    // Host-pin every endpoint we intend to use.
    if (
      !isTrustedEndpoint(authorizeUrl) ||
      !isTrustedEndpoint(tokenUrl) ||
      !isTrustedEndpoint(deviceCodeUrl)
    ) {
      throw new Error("discovered endpoint failed *.x.ai HTTPS host pinning");
    }

    // Only cache SUCCESSFUL discovery, so a later call can retry discovery.
    cachedEndpoints = { authorizeUrl, tokenUrl, deviceCodeUrl };
    logger.debug("discovered OAuth endpoints", cachedEndpoints);
    return cachedEndpoints;
  } catch (err) {
    logger.warn(
      `OIDC discovery failed (${(err as Error).message}); using fallback endpoints`,
    );
    // Do NOT cache the fallback — a subsequent call should retry discovery.
    return FALLBACK_ENDPOINTS;
  }
}

/** Reset the discovery cache (test helper). */
export function resetEndpointCache(): void {
  cachedEndpoints = null;
}

/**
 * Build the authorize URL for the browser/loopback flow.
 */
export function buildAuthorizeUrl(args: {
  codeChallenge: string;
  state: string;
  authorizeUrl?: string;
}): string {
  const base = args.authorizeUrl ?? FALLBACK_AUTHORIZE_URL;
  const url = new URL(base);
  const params = url.searchParams;
  params.set("client_id", CLIENT_ID);
  params.set("redirect_uri", REDIRECT_URI);
  params.set("response_type", "code");
  params.set("scope", OAUTH_SCOPE);
  params.set("code_challenge", args.codeChallenge);
  params.set("code_challenge_method", "S256");
  params.set("state", args.state);
  for (const [k, v] of Object.entries(OAUTH_EXTRA_PARAMS)) {
    params.set(k, v);
  }
  return url.toString();
}

/** Parse a token endpoint response into our Tokens shape. */
export function parseTokenResponse(
  data: Record<string, unknown>,
  fallbackRefresh?: string,
): Tokens {
  const accessToken = String(data["access_token"] ?? "");
  if (!accessToken) {
    throw new Error("token response missing access_token");
  }
  // xAI rotates refresh tokens; keep the old one if none returned.
  const refreshToken = String(data["refresh_token"] ?? fallbackRefresh ?? "");
  if (!refreshToken) {
    throw new Error("token response missing refresh_token and no fallback");
  }
  const expiresIn = Number(data["expires_in"] ?? 0);
  const expiresAt = Date.now() + Math.max(0, expiresIn) * 1000;
  return { accessToken, refreshToken, expiresAt };
}

/**
 * Exchange an authorization code (loopback/browser flow) for tokens.
 */
export async function exchangeCode(args: {
  code: string;
  codeVerifier: string;
  tokenUrl?: string;
}): Promise<Tokens> {
  const tokenUrl = args.tokenUrl ?? (await discoverEndpoints()).tokenUrl;
  // Defense in depth (S5): re-assert host-pin before POSTing credentials.
  assertTrustedEndpoint(tokenUrl, "code exchange");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: args.codeVerifier,
  });

  const res = await fetchWithTimeout(
    tokenUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    },
    "code exchange",
  );

  const text = await res.text();
  if (!res.ok) {
    if (res.status >= 500) {
      throw new TransientAuthError(
        `code exchange failed with HTTP ${res.status}`,
        res.status,
        text,
      );
    }
    throw new Error(`code exchange failed with HTTP ${res.status}: ${text}`);
  }

  const data = JSON.parse(text) as Record<string, unknown>;
  return parseTokenResponse(data);
}

/**
 * Refresh tokens using a rotating refresh token.
 *
 * - Returns `refresh_token ?? oldRefreshToken` (xAI rotates refresh tokens).
 * - HTTP 400 invalid_grant → InvalidGrantError (caller may mark account dead).
 * - Network / 5xx → TransientAuthError.
 */
export async function refreshTokens(
  oldRefreshToken: string,
  tokenUrl?: string,
): Promise<Tokens> {
  const url = tokenUrl ?? (await discoverEndpoints()).tokenUrl;
  // Defense in depth (S5): re-assert host-pin before POSTing the refresh token.
  assertTrustedEndpoint(url, "token refresh");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: oldRefreshToken,
    client_id: CLIENT_ID,
  });

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    },
    "token refresh",
  );

  const text = await res.text();

  if (res.ok) {
    const data = JSON.parse(text) as Record<string, unknown>;
    return parseTokenResponse(data, oldRefreshToken);
  }

  if (res.status >= 500) {
    throw new TransientAuthError(
      `token refresh failed with HTTP ${res.status}`,
      res.status,
      text,
    );
  }

  if (res.status === 400 && /invalid_grant/i.test(text)) {
    throw new InvalidGrantError(
      "refresh token rejected (invalid_grant)",
      res.status,
      text,
    );
  }

  throw new Error(`token refresh failed with HTTP ${res.status}: ${text}`);
}

/** Decode a JWT payload (no signature verification). */
export function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("not a JWT: expected at least two segments");
  }
  const payload = parts[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = payload.padEnd(
    payload.length + ((4 - (payload.length % 4)) % 4),
    "=",
  );
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

export interface Identity {
  accountId: string;
  email?: string;
}

/**
 * Extract an identity from JWT claims. Falls back across common claim keys
 * used by different providers.
 *
 * Throws if no stable per-account identifier can be found. We deliberately do
 * NOT default to a shared literal like "unknown": two identity-less logins
 * would then collide and merge into one entry in storage. `sub` is effectively
 * always present for OIDC, so a missing id means the token is malformed and the
 * caller should reject the login rather than persist an ambiguous account.
 */
export function extractIdentity(claims: Record<string, unknown>): Identity {
  const pick = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = claims[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };

  const email = pick(["email", "email_address", "preferred_username"]);
  const accountId = pick(["sub", "user_id", "uid", "account_id"]) ?? email;
  if (!accountId) {
    throw new Error(
      "could not extract a stable account id from token claims (no sub/user_id/uid/account_id/email)",
    );
  }

  return { accountId, email };
}
