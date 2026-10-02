import type { AccountOf } from "../../../core/schemas.js";
import { logger } from "../../../core/logger.js";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_OAUTH_TOKEN_URL,
} from "../constants.js";

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function refreshAntigravityTokens(
  refreshToken: string,
): Promise<RefreshedTokens> {
  if (!refreshToken) {
    throw new Error("Missing refreshToken for Antigravity");
  }

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorJson: { error?: string; error_description?: string } = {};
    try {
      errorJson = JSON.parse(errorText);
    } catch {
      // not json
    }

    if (
      response.status === 400 &&
      (errorJson.error === "invalid_grant" || errorText.includes("invalid_grant"))
    ) {
      logger.error("Antigravity OAuth refresh token is invalid_grant (revoked)", {
        status: response.status,
        error: errorJson.error,
      });
      throw new Error(`invalid_grant: ${errorJson.error_description || errorText}`);
    }

    throw new Error(
      `Failed to refresh Antigravity token: HTTP ${response.status} ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };

  const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
  const expiresAt = Date.now() + expiresInSec * 1000;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
  };
}

export async function refreshAntigravityAccount(
  account: AccountOf<"antigravity">,
): Promise<RefreshedTokens> {
  return refreshAntigravityTokens(account.refreshToken);
}
