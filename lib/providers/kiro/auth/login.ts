import { createHash } from "node:crypto";
import { exec } from "node:child_process";

import type { AccountOf } from "../../../core/schemas.js";
import {
  extractRegionFromArn,
  isValidKiroRegion,
  KIRO_AUTH_SERVICE,
  normalizeKiroRegion,
  type KiroRegion,
} from "../constants.js";
import { buildApiKeyCandidate, validateKiroApiKey } from "./api-key.js";
import { normalizeCredentialCandidate } from "./credentials-import.js";
import {
  authorizeKiroIDC,
  pollKiroIDCToken,
  type KiroIDCAuthorization,
} from "./oauth-idc.js";
import { fetchKiroUsageLimits } from "../request/usage.js";

export type KiroCandidate = AccountOf<"kiro">;

export type KiroIdcLoginInputs = {
  startUrl?: string;
  idcRegion?: string;
  profileArn?: string;
  openBrowser?: boolean;
  signal?: AbortSignal;
};

export type KiroLoginResult = {
  account: KiroCandidate;
  outcome: "added" | "updated";
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function openBrowserUrl(url: string): void {
  const escaped = url.replace(/"/g, '\\"');
  const cmd =
    process.platform === "win32"
      ? `cmd /c start "" "${escaped}"`
      : process.platform === "darwin"
        ? `open "${escaped}"`
        : `xdg-open "${escaped}"`;
  exec(cmd, () => {
    /* best-effort */
  });
}

export function normalizeStartUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const url = new URL(trimmed);
  url.hash = "";
  url.search = "";
  if (url.pathname.endsWith("/start/")) {
    url.pathname = url.pathname.replace(/\/start\/$/, "/start");
  }
  if (!url.pathname.endsWith("/start")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/start`;
  }
  return url.toString();
}

export function buildDeviceUrl(startUrl: string, userCode: string): string {
  const url = new URL(startUrl);
  url.search = "";
  if (url.pathname.endsWith("/start")) url.pathname = `${url.pathname}/`;
  url.pathname = url.pathname.replace(/\/start\/?$/, "/start/");
  url.hash = `#/device?user_code=${encodeURIComponent(userCode)}`;
  return url.toString();
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

function emailFromAccessToken(accessToken: string | undefined): string | undefined {
  if (!accessToken) return undefined;
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof payload.email === "string" && payload.email) return payload.email;
    if (typeof payload.sub === "string" && payload.sub) return payload.sub;
  } catch {
    return undefined;
  }
  return undefined;
}

export async function loginWithApiKey(
  apiKey: string,
  region?: string,
): Promise<KiroCandidate> {
  const key = validateKiroApiKey(apiKey);
  const candidate = buildApiKeyCandidate(key, region);
  try {
    const usage = await fetchKiroUsageLimits(candidate, key);
    const email = usage.email?.trim() || candidate.email;
    const label = usage.subscriptionTitle
      ? `Kiro API · ${usage.subscriptionTitle}`
      : candidate.label;
    return {
      ...candidate,
      email,
      label,
      usedCount: usage.usedCount,
      limitCount: usage.limitCount,
      usageObservedAt: usage.observedAt,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/HTTP 401|invalid.*token|unauthorized|AccessDenied|rejected/i.test(msg)) {
      throw new Error(
        `API key rejected in region ${candidate.region}. Check the key and region (e.g. eu-central-1 for EU keys). ${msg}`,
      );
    }
    return candidate;
  }
}

export type IdcDeviceSession = {
  auth: KiroIDCAuthorization;
  verificationUrl: string;
  startUrl: string;
  oidcRegion: KiroRegion;
  profileArn?: string;
  serviceRegion: KiroRegion;
};

export async function beginIdcDeviceLogin(
  inputs: KiroIdcLoginInputs = {},
): Promise<IdcDeviceSession> {
  const startUrl =
    normalizeStartUrl(inputs.startUrl) ?? KIRO_AUTH_SERVICE.BUILDER_ID_START_URL;
  const oidcRegion = normalizeKiroRegion(inputs.idcRegion);
  const profileArn = inputs.profileArn?.trim() || undefined;
  const serviceRegion =
    extractRegionFromArn(profileArn) ?? normalizeKiroRegion(undefined);
  const auth = await authorizeKiroIDC(oidcRegion, startUrl);
  const verificationUrl = inputs.startUrl
    ? buildDeviceUrl(startUrl, auth.userCode)
    : auth.verificationUriComplete || auth.verificationUrl;
  if (inputs.openBrowser !== false) {
    openBrowserUrl(verificationUrl);
  }
  return {
    auth,
    verificationUrl,
    startUrl,
    oidcRegion,
    profileArn,
    serviceRegion,
  };
}

export async function completeIdcDeviceLogin(
  session: IdcDeviceSession,
  options?: { signal?: AbortSignal },
): Promise<KiroCandidate> {
  const tokens = await pollKiroIDCToken(
    session.auth.clientId,
    session.auth.clientSecret,
    session.auth.deviceCode,
    session.auth.interval,
    session.auth.expiresIn,
    session.oidcRegion,
    { signal: options?.signal },
  );

  let email =
    tokens.email ||
    emailFromAccessToken(tokens.accessToken) ||
    "builder-id@aws.amazon.com";
  let usedCount: number | undefined;
  let limitCount: number | undefined;
  let usageObservedAt: number | undefined;

  const draft: KiroCandidate = {
    provider: "kiro",
    accountId: identity(email, "idc", tokens.clientId, session.profileArn),
    email,
    tags: [],
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    authMethod: "idc",
    region: session.serviceRegion,
    oidcRegion: session.oidcRegion,
    clientId: tokens.clientId,
    clientSecret: tokens.clientSecret,
    profileArn: session.profileArn,
    startUrl: session.startUrl,
    credentialSource: "login",
  };

  try {
    const usage = await fetchKiroUsageLimits(draft, tokens.accessToken);
    if (usage.email) email = usage.email;
    usedCount = usage.usedCount;
    limitCount = usage.limitCount;
    usageObservedAt = usage.observedAt;
  } catch {
    /* usage is best-effort */
  }

  return {
    ...draft,
    accountId: identity(email, "idc", tokens.clientId, session.profileArn),
    email,
    usedCount,
    limitCount,
    usageObservedAt,
  };
}

export async function loginWithIdcDevice(
  inputs: KiroIdcLoginInputs = {},
  onPrompt?: (prompt: {
    verificationUri: string;
    userCode: string;
    verificationUriComplete?: string;
  }) => void,
): Promise<KiroCandidate> {
  const session = await beginIdcDeviceLogin({
    ...inputs,
    openBrowser: inputs.openBrowser ?? true,
  });
  onPrompt?.({
    verificationUri: session.verificationUrl,
    userCode: session.auth.userCode,
    verificationUriComplete: session.auth.verificationUriComplete,
  });
  return completeIdcDeviceLogin(session, { signal: inputs.signal });
}

export async function importCredentialsJson(
  raw: string,
  options?: { validateRefresh?: boolean },
): Promise<KiroCandidate> {
  return normalizeCredentialCandidate(JSON.parse(raw), options);
}

export async function importAccountManagerExport(
  raw: string,
  options?: { validateRefresh?: boolean },
): Promise<KiroCandidate[]> {
  const payload = JSON.parse(raw) as unknown;
  const root = asRecord(payload);
  const accounts = Array.isArray(payload)
    ? payload
    : Array.isArray(root.accounts)
      ? (root.accounts as unknown[])
      : null;
  if (!accounts || accounts.length === 0) {
    throw new Error('Export JSON must contain a non-empty "accounts" array');
  }
  const flattened = accounts.map((entry) => {
    const row = asRecord(entry);
    const cred = asRecord(row.credentials);
    if (Object.keys(cred).length === 0) return entry;
    return {
      ...cred,
      idp: cred.idp ?? row.idp,
      provider: cred.provider ?? row.provider,
      region: cred.region ?? row.region,
      email: cred.email ?? row.email,
      profileArn: cred.profileArn ?? row.profileArn ?? row.profile_arn,
      startUrl: cred.startUrl ?? row.startUrl ?? row.start_url,
    };
  });
  const out: KiroCandidate[] = [];
  for (const row of flattened) {
    out.push(await normalizeCredentialCandidate(row, options));
  }
  return out;
}

export function validateAwsRegionInput(value: string): string | undefined {
  if (!value.trim()) return undefined;
  if (!isValidKiroRegion(value.trim())) {
    return "Please enter a valid AWS region (e.g. us-east-1, eu-central-1)";
  }
  return undefined;
}
