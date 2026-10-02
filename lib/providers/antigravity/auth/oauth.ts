import crypto from "node:crypto";
import http from "node:http";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_SCOPES,
} from "../constants.js";
import { logger } from "../../../core/logger.js";
import type { AccountOf } from "../../../core/schemas.js";
import type { AccountManager } from "../../../core/accounts.js";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
  projectId?: string;
}

export function buildAuthorizeUrl(options: {
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: options.state,
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(options: {
  code: string;
  redirectUri: string;
}): Promise<GoogleTokens> {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      code: options.code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: options.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed: HTTP ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.refresh_token) {
    throw new Error("Google OAuth did not return a refresh token. Make sure prompt=consent is used.");
  }

  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  const expiresAt = Date.now() + expiresIn * 1000;

  // Try fetching userinfo for email
  let email: string | undefined;
  try {
    const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (userinfoRes.ok) {
      const info = (await userinfoRes.json()) as { email?: string };
      email = info.email;
    }
  } catch {
    // optional
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    email,
    projectId: `useful-fuze-${crypto.randomUUID().slice(0, 5)}`,
  };
}

export async function waitForOAuthCallback(
  expectedState: string,
  port = 8085,
  signal?: AbortSignal,
): Promise<{ code: string }> {
  if (signal?.aborted) {
    throw new Error("login cancelled");
  }

  return new Promise((resolve, reject) => {
    let resolved = false;

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", `http://localhost:${port}`);
        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>Google Sign-in failed</h2><p>" + error + "</p>");
          cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (state !== expectedState || !code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>Invalid OAuth callback state</h2>");
          cleanup();
          reject(new Error("OAuth state mismatch or missing code"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h2>Đăng nhập Antigravity thành công!</h2><p>Bạn có thể đóng tab này và quay lại OpenCode.</p>",
        );
        cleanup();
        resolve({ code });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth callback timed out after 3 minutes"));
    }, 180_000);

    function cleanup() {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      server.close();
    }

    function onAbort() {
      cleanup();
      reject(new Error("login cancelled"));
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    server.listen(port, () => {
      logger.debug(`Antigravity OAuth server listening on port ${port}`);
    });

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

export async function finalizeAntigravityLogin(
  target: AccountManager | { provider: string; upsertFromOAuth: (acc: AccountOf<"antigravity">) => Promise<"added" | "updated"> },
  tokens: GoogleTokens,
): Promise<AccountOf<"antigravity"> & { outcome: "added" | "updated" }> {
  const accountId = `ag-${tokens.email ? tokens.email.replace(/[^a-zA-Z0-9]/g, "_") : crypto.randomUUID().slice(0, 8)}`;
  const label = tokens.email || `Antigravity ${accountId.slice(0, 6)}`;

  const account: AccountOf<"antigravity"> = {
    provider: "antigravity",
    accountId,
    email: tokens.email,
    label,
    tags: ["oauth"],
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    projectId: tokens.projectId || `useful-fuze-${crypto.randomUUID().slice(0, 5)}`,
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
  };

  const outcome =
    "provider" in target && target.provider === "antigravity"
      ? await target.upsertFromOAuth(account)
      : await (target as AccountManager).upsertFromOAuth("antigravity", account);

  return Object.assign(account, { outcome });
}
