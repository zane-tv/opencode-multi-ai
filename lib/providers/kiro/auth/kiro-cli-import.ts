import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AccountOf } from "../../../core/schemas.js";
import { normalizeKiroRegion } from "../constants.js";
import { normalizeCredentialCandidate } from "./credentials-import.js";
import { readSqliteQuery } from "./sqlite-reader.js";

export type KiroCandidate = AccountOf<"kiro">;

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
  return path.join(os.homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    const key = asString(row.key);
    const value = asString(row.value);
    if (key && value) map.set(key, value);
  }

  let profileArn: string | undefined;
  try {
    const profile = await readSqliteQuery(
      dbPath,
      "SELECT value FROM state WHERE key = ?",
      ["api.codewhisperer.profile"],
    );
    profileArn = asString(profile.rows[0]?.value);
  } catch {
    // profile is optional
  }

  const refreshToken =
    map.get("refreshToken") ??
    map.get("refresh_token") ??
    map.get("kiro.refreshToken");
  const accessToken =
    map.get("accessToken") ??
    map.get("access_token") ??
    map.get("kiro.accessToken");
  const clientId = map.get("clientId") ?? map.get("client_id");
  const clientSecret = map.get("clientSecret") ?? map.get("client_secret");
  const startUrl = map.get("startUrl") ?? map.get("start_url");
  const region = map.get("region") ?? map.get("sso_region") ?? "us-east-1";
  const email = map.get("email");

  if (!refreshToken) {
    warnings.push("No refresh token found in kiro-cli auth_kv");
    return { candidates, warnings };
  }

  const authMethod =
    clientId && clientSecret
      ? "idc"
      : refreshToken.startsWith("ksk_")
        ? "api-key"
        : "desktop";

  try {
    const candidate = await normalizeCredentialCandidate(
      {
        authMethod,
        refreshToken,
        accessToken,
        clientId,
        clientSecret,
        region: normalizeKiroRegion(region),
        oidcRegion: normalizeKiroRegion(region),
        startUrl,
        profileArn,
        email,
      },
      { validateRefresh: false },
    );
    candidate.credentialSource = "kiro-cli";
    candidates.push(candidate);
  } catch (error) {
    warnings.push(
      `skipped incomplete kiro-cli credentials: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { candidates, warnings };
}
