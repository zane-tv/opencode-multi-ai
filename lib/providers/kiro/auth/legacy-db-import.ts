import fs from "node:fs/promises";

import type { AccountOf } from "../../../core/schemas.js";
import { normalizeCredentialCandidate } from "./credentials-import.js";
import { readSqliteQuery } from "./sqlite-reader.js";

export type KiroCandidate = AccountOf<"kiro">;

export async function readLegacyKiroDbCandidates(
  dbPath: string,
): Promise<{ candidates: KiroCandidate[]; warnings: string[] }> {
  await fs.access(dbPath);
  const warnings: string[] = [];
  const candidates: KiroCandidate[] = [];

  let rows: Array<Record<string, unknown>> = [];
  try {
    const result = await readSqliteQuery(
      dbPath,
      `SELECT id, email, auth_method, region, oidc_region, client_id, client_secret,
              profile_arn, start_url, token_endpoint, refresh_token, access_token,
              expires_at, rate_limit_reset, used_count, limit_count, last_sync
       FROM accounts`,
    );
    rows = result.rows;
  } catch (error) {
    throw new Error(
      `Failed to read legacy kiro.db accounts table: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  for (const row of rows) {
    try {
      const candidate = await normalizeCredentialCandidate(
        {
          authMethod: row.auth_method,
          refreshToken: row.refresh_token,
          accessToken: row.access_token,
          region: row.region,
          oidcRegion: row.oidc_region,
          clientId: row.client_id,
          clientSecret: row.client_secret,
          profileArn: row.profile_arn,
          startUrl: row.start_url,
          tokenEndpoint: row.token_endpoint,
          email: row.email,
          expiresAt:
            typeof row.expires_at === "number" ? row.expires_at : undefined,
        },
        { validateRefresh: false },
      );
      if (typeof row.id === "string" && row.id) {
        candidate.accountId = row.id;
      }
      if (typeof row.used_count === "number") candidate.usedCount = row.used_count;
      if (typeof row.limit_count === "number") candidate.limitCount = row.limit_count;
      if (typeof row.last_sync === "number") candidate.externalSyncAt = row.last_sync;
      if (
        typeof row.rate_limit_reset === "number" &&
        row.rate_limit_reset > Date.now()
      ) {
        candidate.coolingDownUntil = row.rate_limit_reset;
        candidate.cooldownReason = "rate-limit";
      }
      candidate.credentialSource = "legacy-db";
      candidates.push(candidate);
    } catch (error) {
      warnings.push(
        `skipped legacy row: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { candidates, warnings };
}
