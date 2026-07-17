import { createHash } from "node:crypto";

import type { AccountOf } from "../../../core/schemas.js";
import { normalizeKiroRegion } from "../constants.js";
import { refreshKiroAccount } from "./refresh.js";
import { buildApiKeyCandidate } from "./api-key.js";

export type KiroCandidate = AccountOf<"kiro">;

type RawCredential = {
  authMethod?: string;
  refreshToken?: string;
  accessToken?: string;
  region?: string;
  oidcRegion?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  profileArn?: string;
  startUrl?: string;
  email?: string;
  expiresAt?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identity(
  email: string,
  method: string,
  clientId?: string,
  profileArn?: string,
): string {
  return createHash("sha256")
    .update(`${email}:${method}:${clientId ?? ""}:${profileArn ?? ""}`)
    .digest("hex")
    .slice(0, 24);
}

function normalizeAuthMethodLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (
    v === "idc" ||
    v === "builderid" ||
    v === "builder-id" ||
    v === "builder_id" ||
    v === "aws-builder-id" ||
    v === "iam-identity-center"
  ) {
    return "idc";
  }
  if (v === "external-idp" || v === "external_idp" || v === "externalidp") {
    return "external-idp";
  }
  if (v === "api-key" || v === "apikey" || v === "api_key") return "api-key";
  if (v === "desktop") return "desktop";
  if (v === "social" || v === "google" || v === "github") {
    throw new Error(
      `Auth method "${raw}" (social login) is not supported for credential import. Supported: idc, external-idp, desktop, api-key.`,
    );
  }
  return raw;
}

function flattenCredentialRow(value: unknown): Record<string, unknown> {
  const row = asRecord(value);
  const cred = asRecord(row.credentials);
  if (Object.keys(cred).length === 0) return row;
  return {
    ...cred,
    idp: cred.idp ?? row.idp,
    provider: cred.provider ?? row.provider,
    region: cred.region ?? row.region,
    email: cred.email ?? row.email,
    profileArn: cred.profileArn ?? row.profileArn ?? row.profile_arn,
    startUrl: cred.startUrl ?? row.startUrl ?? row.start_url,
  };
}

function parseRaw(value: unknown): RawCredential {
  const row = flattenCredentialRow(value);
  const rawMethod =
    typeof row.authMethod === "string"
      ? row.authMethod
      : typeof row.auth_method === "string"
        ? row.auth_method
        : typeof row.provider === "string"
          ? row.provider
          : typeof row.idp === "string"
            ? row.idp
            : undefined;
  return {
    authMethod: normalizeAuthMethodLabel(rawMethod),
    refreshToken:
      typeof row.refreshToken === "string"
        ? row.refreshToken
        : typeof row.refresh_token === "string"
          ? row.refresh_token
          : undefined,
    accessToken:
      typeof row.accessToken === "string"
        ? row.accessToken
        : typeof row.access_token === "string"
          ? row.access_token
          : undefined,
    region: typeof row.region === "string" ? row.region : undefined,
    oidcRegion:
      typeof row.oidcRegion === "string"
        ? row.oidcRegion
        : typeof row.oidc_region === "string"
          ? row.oidc_region
          : undefined,
    clientId:
      typeof row.clientId === "string"
        ? row.clientId
        : typeof row.client_id === "string"
          ? row.client_id
          : undefined,
    clientSecret:
      typeof row.clientSecret === "string"
        ? row.clientSecret
        : typeof row.client_secret === "string"
          ? row.client_secret
          : undefined,
    tokenEndpoint:
      typeof row.tokenEndpoint === "string"
        ? row.tokenEndpoint
        : typeof row.token_endpoint === "string"
          ? row.token_endpoint
          : undefined,
    profileArn:
      typeof row.profileArn === "string"
        ? row.profileArn
        : typeof row.profile_arn === "string"
          ? row.profile_arn
          : undefined,
    startUrl:
      typeof row.startUrl === "string"
        ? row.startUrl
        : typeof row.start_url === "string"
          ? row.start_url
          : undefined,
    email: typeof row.email === "string" ? row.email : undefined,
    expiresAt:
      typeof row.expiresAt === "number"
        ? row.expiresAt
        : typeof row.expires_at === "number"
          ? row.expires_at
          : undefined,
  };
}

export async function normalizeCredentialCandidate(
  value: unknown,
  options?: { validateRefresh?: boolean },
): Promise<KiroCandidate> {
  const raw = parseRaw(value);
  const method = raw.authMethod ?? "desktop";
  if (method === "api-key") {
    return buildApiKeyCandidate(
      raw.refreshToken ?? raw.accessToken ?? "",
      raw.region,
    );
  }
  if (
    method !== "desktop" &&
    method !== "idc" &&
    method !== "external-idp"
  ) {
    throw new Error(`Unsupported Kiro auth method: ${method}`);
  }
  if (!raw.refreshToken) {
    throw new Error("Missing refreshToken");
  }
  if (method === "idc" && (!raw.clientId || !raw.clientSecret)) {
    throw new Error("IDC credentials require clientId and clientSecret");
  }
  if (method === "external-idp" && (!raw.clientId || !raw.tokenEndpoint)) {
    throw new Error(
      "external-idp credentials require clientId and tokenEndpoint",
    );
  }

  const email = raw.email ?? `${method}@kiro.local`;
  let candidate: KiroCandidate = {
    provider: "kiro",
    accountId: identity(email, method, raw.clientId, raw.profileArn),
    email,
    tags: [],
    refreshToken: raw.refreshToken,
    accessToken: raw.accessToken,
    expiresAt: raw.expiresAt,
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    authMethod: method,
    region: normalizeKiroRegion(raw.region),
    oidcRegion: raw.oidcRegion
      ? normalizeKiroRegion(raw.oidcRegion)
      : undefined,
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    tokenEndpoint: raw.tokenEndpoint,
    profileArn: raw.profileArn,
    startUrl: raw.startUrl,
    credentialSource: "import",
  };

  if (options?.validateRefresh !== false) {
    const tokens = await refreshKiroAccount(candidate);
    candidate = {
      ...candidate,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
  }
  return candidate;
}

export async function normalizeCredentialCandidates(
  value: unknown,
): Promise<KiroCandidate[]> {
  const payload =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload).accounts)
      ? (asRecord(payload).accounts as unknown[])
      : [payload];
  const out: KiroCandidate[] = [];
  for (const row of rows) {
    out.push(await normalizeCredentialCandidate(row));
  }
  return out;
}
