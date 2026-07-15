import {
  AUTH_FETCH_TIMEOUT_MS,
  AUTHORIZE_URL,
  CLIENT_ID,
  JWT_CLAIM_PATH,
  OAUTH_EXTRA_PARAMS,
  OAUTH_SCOPE,
  REDIRECT_URI,
  TOKEN_URL,
} from "../constants.js";
import { logger } from "../../../core/logger.js";

/**
 * ChatGPT / Codex OAuth: fixed authorize/token endpoints, code exchange,
 * refresh, and JWT identity extraction.
 *
 * SECURITY:
 * - Credential POSTs are host-pinned to HTTPS `auth.openai.com` (and
 *   `*.openai.com` for defense in depth).
 * - Refresh tokens may rotate; refreshTokens() always returns
 *   `refresh_token ?? oldRefreshToken` so callers never lose the ability to
 *   refresh again.
 * - No OIDC discovery — endpoints are public constants (Codex CLI contract).
 */

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
  /** Optional OIDC id_token (email often lives here for OpenAI). */
  idToken?: string;
  /** Scope string returned by the token endpoint, if any. */
  scope?: string;
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

/**
 * A credential endpoint is trusted only if it is HTTPS and its host is
 * `openai.com` or a subdomain of `openai.com` (auth.openai.com).
 */
export function isTrustedEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "openai.com" || host.endsWith(".openai.com");
  } catch {
    return false;
  }
}

/**
 * Re-assert the OpenAI HTTPS host-pin before POSTing credentials to a URL.
 * Defense in depth: callers may pass an override token URL, so the pin is
 * enforced again at the point of use. Throws if the URL is untrusted.
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
    throw new TransientAuthError(
      `network error during ${what}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the authorize URL for the browser/loopback flow.
 * Uses fixed AUTHORIZE_URL + Codex CLI extra params + PKCE S256.
 */
export function buildAuthorizeUrl(args: {
  codeChallenge: string;
  state: string;
  /** Optional override (tests). Defaults to AUTHORIZE_URL. */
  authorizeUrl?: string;
  /** Force a fresh login screen when adding another account. */
  forceNewLogin?: boolean;
}): string {
  const base = args.authorizeUrl ?? AUTHORIZE_URL;
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
  if (args.forceNewLogin) {
    params.set("prompt", "login");
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
  // Refresh may be omitted on some grants; keep the old one if none returned.
  const refreshToken = String(data["refresh_token"] ?? fallbackRefresh ?? "");
  if (!refreshToken) {
    throw new Error("token response missing refresh_token and no fallback");
  }
  const expiresIn = Number(data["expires_in"] ?? 0);
  const expiresAt = Date.now() + Math.max(0, expiresIn) * 1000;
  const idTokenRaw = data["id_token"];
  const idToken =
    typeof idTokenRaw === "string" && idTokenRaw.length > 0
      ? idTokenRaw
      : undefined;
  const scopeRaw = data["scope"];
  const scope =
    typeof scopeRaw === "string" && scopeRaw.length > 0 ? scopeRaw : undefined;
  return { accessToken, refreshToken, expiresAt, idToken, scope };
}

/**
 * Exchange an authorization code (loopback/browser or device) for tokens.
 */
export async function exchangeCode(args: {
  code: string;
  codeVerifier: string;
  /** Defaults to REDIRECT_URI (browser loopback). Device flow uses a different URI. */
  redirectUri?: string;
  /** Optional override (tests). Defaults to TOKEN_URL. */
  tokenUrl?: string;
}): Promise<Tokens> {
  const tokenUrl = args.tokenUrl ?? TOKEN_URL;
  assertTrustedEndpoint(tokenUrl, "code exchange");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: CLIENT_ID,
    redirect_uri: args.redirectUri ?? REDIRECT_URI,
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
    if (res.status === 400 && /invalid_grant/i.test(text)) {
      throw new InvalidGrantError(
        "authorization code rejected (invalid_grant)",
        res.status,
        text,
      );
    }
    throw new Error(`code exchange failed with HTTP ${res.status}: ${text}`);
  }

  const data = JSON.parse(text) as Record<string, unknown>;
  return parseTokenResponse(data);
}

function normalizedOAuthError(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("error" in parsed)
    ) {
      return undefined;
    }
    const error = parsed.error;
    return typeof error === "string" ? error.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refresh tokens using a (possibly rotating) refresh token.
 *
 * - Returns `refresh_token ?? oldRefreshToken`.
 * - HTTP 400 invalid_grant → InvalidGrantError (caller may mark account dead).
 * - Network / 5xx → TransientAuthError.
 */
export async function refreshTokens(
  oldRefreshToken: string,
  tokenUrl?: string,
): Promise<Tokens> {
  const url = tokenUrl ?? TOKEN_URL;
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

  if (
    res.status === 400 &&
    normalizedOAuthError(text) === "invalid_grant"
  ) {
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
  organizationId?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const n = v.trim().toLowerCase();
    if (n === "true") return true;
    if (n === "false") return false;
  }
  return undefined;
}

/** Workspace / org candidate from JWT claims (single best is picked at login). */
export interface WorkspaceCandidate {
  accountId: string;
  organizationId?: string;
  isDefault?: boolean;
  isPersonal?: boolean;
  source: "token" | "id_token" | "org";
}

function extractAuthClaim(
  claims: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const auth = claims[JWT_CLAIM_PATH];
  return isRecord(auth) ? auth : undefined;
}

function extractChatgptAccountId(
  claims: Record<string, unknown>,
): string | undefined {
  const auth = extractAuthClaim(claims);
  if (auth) {
    const id = str(auth["chatgpt_account_id"]);
    if (id) return id;
  }
  return (
    str(claims["chatgpt_account_id"]) ??
    str(claims["account_id"]) ??
    str(claims["accountId"])
  );
}

function extractEmailFromClaims(
  claims: Record<string, unknown>,
): string | undefined {
  const auth = extractAuthClaim(claims);
  const candidates = [
    str(claims["email"]),
    str(claims["preferred_username"]),
    auth ? str(auth["email"]) : undefined,
    auth ? str(auth["chatgpt_user_email"]) : undefined,
  ];
  for (const c of candidates) {
    if (c && c.includes("@")) return c;
  }
  return undefined;
}

function normalizeList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    for (const k of ["data", "items", "accounts", "organizations", "workspaces", "teams"]) {
      if (Array.isArray(value[k])) return value[k] as unknown[];
    }
  }
  return [];
}

function candidateFromRecord(
  record: Record<string, unknown>,
  source: WorkspaceCandidate["source"],
  organizationIdOverride?: string,
): WorkspaceCandidate | null {
  const accountId =
    str(record["account_id"]) ??
    str(record["accountId"]) ??
    str(record["chatgpt_account_id"]) ??
    str(record["organization_id"]) ??
    str(record["org_id"]) ??
    str(record["workspace_id"]) ??
    str(record["team_id"]) ??
    str(record["id"]);
  if (!accountId) return null;
  const organizationId =
    str(record["organization_id"]) ??
    str(record["organizationId"]) ??
    str(record["org_id"]) ??
    organizationIdOverride;
  return {
    accountId,
    organizationId,
    isDefault: bool(
      record["is_default"] ??
        record["isDefault"] ??
        record["default"] ??
        record["primary"] ??
        record["is_active"] ??
        record["isActive"] ??
        record["current"],
    ),
    isPersonal: bool(
      record["is_personal"] ?? record["isPersonal"] ?? record["personal"],
    ),
    source,
  };
}

function collectOrgCandidates(
  claims: Record<string, unknown>,
  source: WorkspaceCandidate["source"],
): WorkspaceCandidate[] {
  const out: WorkspaceCandidate[] = [];
  const keys = ["organizations", "orgs", "accounts", "workspaces", "teams"];
  const scan = (obj: Record<string, unknown>) => {
    for (const key of keys) {
      if (!(key in obj)) continue;
      for (const item of normalizeList(obj[key])) {
        if (!isRecord(item)) continue;
        const c = candidateFromRecord(item, source);
        if (c) out.push(c);
      }
    }
  };
  scan(claims);
  const auth = extractAuthClaim(claims);
  if (auth) scan(auth);
  return out;
}

/**
 * Prefer a single workspace for this login (no multi-sibling accounts).
 * Order: org default non-personal → org default → id_token → non-personal org
 * → token default → first.
 */
export function selectBestWorkspace(
  candidates: WorkspaceCandidate[],
): WorkspaceCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const orgDefaultNonPersonal = candidates.find(
    (c) =>
      c.source === "org" && c.isDefault === true && c.isPersonal !== true,
  );
  if (orgDefaultNonPersonal) return orgDefaultNonPersonal;
  const orgDefault = candidates.find(
    (c) => c.source === "org" && c.isDefault === true,
  );
  if (orgDefault) return orgDefault;
  const idToken = candidates.find((c) => c.source === "id_token");
  if (idToken) return idToken;
  const nonPersonal = candidates.find(
    (c) => c.source === "org" && c.isPersonal !== true,
  );
  if (nonPersonal) return nonPersonal;
  const token = candidates.find((c) => c.source === "token");
  if (token) return token;
  return candidates[0];
}

/**
 * Extract ChatGPT account identity from access (and optional id) token claims.
 *
 * Primary id: JWT claim path `https://api.openai.com/auth` → `chatgpt_account_id`.
 * Picks one best workspace when org lists are present (1 account per login).
 * Throws if no stable account id can be found (never invent "unknown").
 */
export function extractIdentity(
  accessClaims: Record<string, unknown>,
  idClaims?: Record<string, unknown>,
): Identity {
  const candidates: WorkspaceCandidate[] = [];

  const accessAccountId = extractChatgptAccountId(accessClaims);
  if (accessAccountId) {
    candidates.push({
      accountId: accessAccountId,
      source: "token",
      isDefault: true,
    });
  }
  candidates.push(...collectOrgCandidates(accessClaims, "org"));

  if (idClaims) {
    const idAccountId = extractChatgptAccountId(idClaims);
    if (idAccountId && idAccountId !== accessAccountId) {
      candidates.push({ accountId: idAccountId, source: "id_token" });
    }
    candidates.push(...collectOrgCandidates(idClaims, "org"));
  }

  // Dedupe by accountId (first wins).
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    if (seen.has(c.accountId)) return false;
    seen.add(c.accountId);
    return true;
  });

  const best = selectBestWorkspace(unique);
  const accountId =
    best?.accountId ??
    accessAccountId ??
    str(accessClaims["sub"]);

  if (!accountId) {
    throw new Error(
      "could not extract chatgpt_account_id from token claims (JWT claim path missing)",
    );
  }

  const email =
    (idClaims ? extractEmailFromClaims(idClaims) : undefined) ??
    extractEmailFromClaims(accessClaims);

  // Prefer org id from selected workspace, else first org entry on auth claim.
  let organizationId = best?.organizationId;
  if (!organizationId) {
    const auth = extractAuthClaim(accessClaims) ?? (idClaims ? extractAuthClaim(idClaims) : undefined);
    if (auth) {
      const orgs = normalizeList(auth["organizations"]);
      const first = orgs[0];
      if (isRecord(first)) {
        organizationId = str(first["id"]) ?? str(first["organization_id"]);
      }
    }
  }

  return { accountId, email, organizationId };
}

/**
 * Convenience: decode tokens and extract identity (access + optional id_token).
 */
export function identityFromTokens(tokens: Tokens): Identity {
  const accessClaims = decodeJwt(tokens.accessToken);
  let idClaims: Record<string, unknown> | undefined;
  if (tokens.idToken) {
    try {
      idClaims = decodeJwt(tokens.idToken);
    } catch (err) {
      logger.debug(
        `id_token decode skipped: ${(err as Error).message}`,
      );
    }
  }
  return extractIdentity(accessClaims, idClaims);
}
