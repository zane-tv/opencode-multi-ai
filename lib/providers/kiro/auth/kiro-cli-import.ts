import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AccountOf } from "../../../core/schemas.js";
import { isValidKiroRegion, normalizeKiroRegion } from "../constants.js";
import { normalizeCredentialCandidate } from "./credentials-import.js";
import { readSqliteQuery, sqliteValueToString } from "./sqlite-reader.js";

export type KiroCandidate = AccountOf<"kiro">;

type JsonRecord = Record<string, unknown>;

type KiroCliCredential = {
  authMethod: "api-key" | "desktop" | "external-idp" | "idc";
  refreshToken: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  region: string;
  oidcRegion?: string;
  profileArn?: string;
  startUrl?: string;
  email?: string;
  expiresAt?: number;
};

type StructuredSource = {
  authMethod: "desktop" | "external-idp" | "idc";
  token: JsonRecord;
  registration?: JsonRecord;
};

export function defaultKiroCliDbPath(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "kiro-cli",
      "data.sqlite3",
    );
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "kiro-cli",
      "data.sqlite3",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "kiro-cli",
    "data.sqlite3",
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function parseJson(value: string | undefined): { value: unknown } | undefined {
  if (!value) return undefined;
  try {
    return { value: JSON.parse(value) as unknown };
  } catch {
    return undefined;
  }
}

function parseJsonRecord(value: string | undefined): JsonRecord | undefined {
  return asRecord(parseJson(value)?.value);
}

function readString(
  record: JsonRecord | undefined,
  ...keys: readonly string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function parseExpiresAt(value: unknown): number | undefined {
  const toEpochMilliseconds = (epoch: number): number | undefined => {
    if (!Number.isFinite(epoch)) return undefined;
    return Math.abs(epoch) < 10_000_000_000 ? epoch * 1000 : epoch;
  };

  if (typeof value === "number") return toEpochMilliseconds(value);
  const text = asString(value);
  if (!text) return undefined;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return toEpochMilliseconds(numeric);

  const match = text.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/,
  );
  if (match) {
    const milliseconds = (match[2] ?? "").slice(0, 3).padEnd(3, "0");
    const parsed = Date.parse(`${match[1]}.${milliseconds}${match[3]}`);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readStateString(value: string | undefined): string | undefined {
  const parsed = parseJson(value);
  return parsed ? asString(parsed.value) : asString(value);
}

function isArn(value: string | undefined): value is string {
  const parts = value?.split(":");
  return Boolean(
    parts &&
      parts.length >= 6 &&
      parts[0] === "arn" &&
      parts[1] &&
      parts[2] &&
      parts[3] &&
      parts[5],
  );
}

function rawArnRegion(arn: string | undefined): string | undefined {
  return isArn(arn) ? arn.split(":")[3] : undefined;
}

function sanitizeProfileArn(value: string | undefined): string | undefined {
  return isArn(value) ? value : undefined;
}

function sanitizeStartUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readProfileArn(value: string | undefined): string | undefined {
  const parsed = parseJson(value);
  const profileArn = readString(
    asRecord(parsed?.value),
    "arn",
    "profile_arn",
    "profileArn",
  );
  if (profileArn) return sanitizeProfileArn(profileArn);

  const rawProfileArn = parsed ? asString(parsed.value) : asString(value);
  return sanitizeProfileArn(rawProfileArn);
}

function tokenRefreshToken(token: JsonRecord): string | undefined {
  return readString(token, "refresh_token", "refreshToken");
}

function findStructuredSource(
  values: ReadonlyMap<string, string>,
): StructuredSource | undefined {
  const sources: ReadonlyArray<{
    tokenKey: string;
    registrationKey?: string;
    authMethod: StructuredSource["authMethod"];
  }> = [
    { tokenKey: "kirocli:social:token", authMethod: "desktop" },
    {
      tokenKey: "kirocli:odic:token",
      registrationKey: "kirocli:odic:device-registration",
      authMethod: "idc",
    },
    {
      tokenKey: "codewhisperer:odic:token",
      registrationKey: "codewhisperer:odic:device-registration",
      authMethod: "idc",
    },
    { tokenKey: "kirocli:external-idp:token", authMethod: "external-idp" },
    {
      tokenKey: "kirocli:oidc:token",
      registrationKey: "kirocli:oidc:device-registration",
      authMethod: "idc",
    },
  ];

  for (const source of sources) {
    const token = parseJsonRecord(values.get(source.tokenKey));
    if (!token || !tokenRefreshToken(token)) continue;
    const registration = source.registrationKey
      ? parseJsonRecord(values.get(source.registrationKey))
      : undefined;
    if (source.registrationKey && !registration) continue;
    return { authMethod: source.authMethod, token, registration };
  }
  return undefined;
}

function flatCredential(
  values: ReadonlyMap<string, string>,
  profileArn: string | undefined,
): KiroCliCredential | undefined {
  const refreshToken =
    values.get("refreshToken") ??
    values.get("refresh_token") ??
    values.get("kiro.refreshToken");
  if (!refreshToken) return undefined;

  const clientId = values.get("clientId") ?? values.get("client_id");
  const clientSecret =
    values.get("clientSecret") ?? values.get("client_secret");
  const region = values.get("region") ?? values.get("sso_region");
  const authMethod =
    clientId && clientSecret
      ? "idc"
      : refreshToken.startsWith("ksk_")
        ? "api-key"
        : "desktop";

  return {
    authMethod,
    refreshToken,
    accessToken:
      values.get("accessToken") ??
      values.get("access_token") ??
      values.get("kiro.accessToken"),
    clientId,
    clientSecret,
    tokenEndpoint:
      values.get("tokenEndpoint") ?? values.get("token_endpoint"),
    region: region ?? normalizeKiroRegion(undefined),
    oidcRegion: region ?? normalizeKiroRegion(undefined),
    profileArn,
    startUrl: sanitizeStartUrl(
      values.get("startUrl") ?? values.get("start_url"),
    ),
    email: values.get("email"),
    expiresAt: parseExpiresAt(
      values.get("expiresAt") ?? values.get("expires_at"),
    ),
  };
}

function structuredCredential(
  source: StructuredSource,
  values: ReadonlyMap<string, string>,
  profileArn: string | undefined,
  stateRegion: string | undefined,
  stateStartUrl: string | undefined,
): KiroCliCredential {
  const { token, registration } = source;
  const refreshToken = tokenRefreshToken(token)!;
  const tokenRegion = readString(token, "region", "sso_region");
  const registrationRegion = readString(registration, "region", "sso_region");
  const tokenProfileArn = sanitizeProfileArn(
    readString(token, "profile_arn", "profileArn", "arn"),
  );
  const clientId =
    readString(registration, "client_id", "clientId") ??
    readString(token, "client_id", "clientId") ??
    values.get("clientId") ??
    values.get("client_id");
  const clientSecret =
    readString(registration, "client_secret", "clientSecret") ??
    readString(token, "client_secret", "clientSecret") ??
    values.get("clientSecret") ??
    values.get("client_secret");
  const fallbackRegion = tokenRegion ?? stateRegion;

  const credential: KiroCliCredential = {
    authMethod: source.authMethod,
    refreshToken,
    accessToken:
      readString(token, "access_token", "accessToken") ??
      values.get("accessToken") ??
      values.get("access_token") ??
      values.get("kiro.accessToken"),
    clientId,
    clientSecret,
    tokenEndpoint:
      readString(token, "token_endpoint", "tokenEndpoint") ??
      values.get("tokenEndpoint") ??
      values.get("token_endpoint"),
    region: fallbackRegion ?? normalizeKiroRegion(undefined),
    profileArn: profileArn ?? tokenProfileArn,
    startUrl:
      sanitizeStartUrl(readString(token, "start_url", "startUrl")) ??
      stateStartUrl ??
      sanitizeStartUrl(values.get("startUrl") ?? values.get("start_url")),
    email: readString(token, "email") ?? values.get("email"),
    expiresAt: parseExpiresAt(token.expires_at ?? token.expiresAt),
  };

  if (source.authMethod === "idc") {
    credential.region =
      rawArnRegion(credential.profileArn) ?? normalizeKiroRegion(undefined);
    credential.oidcRegion =
      registrationRegion ??
      tokenRegion ??
      stateRegion ??
      normalizeKiroRegion(undefined);
  }

  return credential;
}

function assertSupportedCredentialRegions(credential: KiroCliCredential): void {
  const profileArnRegion = rawArnRegion(credential.profileArn);
  const unsupported = [
    !isValidKiroRegion(credential.region)
      ? `service region: ${credential.region}`
      : undefined,
    credential.oidcRegion && !isValidKiroRegion(credential.oidcRegion)
      ? `OIDC region: ${credential.oidcRegion}`
      : undefined,
    profileArnRegion &&
    !isValidKiroRegion(profileArnRegion) &&
    profileArnRegion !== credential.region
      ? `profile ARN region: ${profileArnRegion}`
      : undefined,
  ].filter((region): region is string => Boolean(region));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported Kiro ${unsupported.join("; ")}`);
  }
}

export async function readKiroCliCandidates(
  dbPath = defaultKiroCliDbPath(),
): Promise<{ candidates: KiroCandidate[]; warnings: string[] }> {
  await fs.access(dbPath);
  const warnings: string[] = [];
  const candidates: KiroCandidate[] = [];

  let authRows: Array<Record<string, unknown>> = [];
  try {
    const result = await readSqliteQuery(
      dbPath,
      "SELECT key, value FROM auth_kv",
    );
    authRows = result.rows;
  } catch (error) {
    warnings.push(
      `auth_kv unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { candidates, warnings };
  }

  const map = new Map<string, string>();
  for (const row of authRows) {
    const key = sqliteValueToString(row.key);
    const value = sqliteValueToString(row.value);
    if (key && value) map.set(key, value);
  }

  let profileArn: string | undefined;
  let stateRegion: string | undefined;
  let stateStartUrl: string | undefined;
  try {
    const state = await readSqliteQuery(
      dbPath,
      "SELECT key, value FROM state WHERE key IN (?, ?, ?)",
      [
        "api.codewhisperer.profile",
        "auth.idc.region",
        "auth.idc.start-url",
      ],
    );
    const stateValues = new Map<string, string>();
    for (const row of state.rows) {
      const key = sqliteValueToString(row.key);
      const value = sqliteValueToString(row.value);
      if (key && value) stateValues.set(key, value);
    }
    profileArn = readProfileArn(stateValues.get("api.codewhisperer.profile"));
    stateRegion = readStateString(stateValues.get("auth.idc.region"));
    stateStartUrl = sanitizeStartUrl(
      readStateString(stateValues.get("auth.idc.start-url")),
    );
  } catch {
    // profile is optional
  }

  const source = findStructuredSource(map);
  const credential = source
    ? structuredCredential(
        source,
        map,
        profileArn,
        stateRegion,
        stateStartUrl,
      )
    : flatCredential(map, profileArn);

  if (!credential) {
    warnings.push("No refresh token found in kiro-cli auth_kv");
    return { candidates, warnings };
  }

  try {
    assertSupportedCredentialRegions(credential);
    const candidate = await normalizeCredentialCandidate(
      credential,
      { validateRefresh: false },
    );
    candidate.credentialSource = "kiro-cli";
    candidates.push(candidate);
  } catch (error) {
    warnings.push(
      `skipped kiro-cli credentials: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { candidates, warnings };
}
