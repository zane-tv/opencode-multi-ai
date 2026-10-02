import type { FetchLike, ProviderFetchContext } from "../../../core/adapter.js";
import type { AccountOf, AccountSelectionStrategy } from "../../../core/schemas.js";
import { logger } from "../../../core/logger.js";
import {
  ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_SANDBOX_URL,
  getAntigravityUserAgent,
} from "../constants.js";
import { directGoogleFetch } from "./direct-fetch.js";
import { transformOpenAiToGemini, type OpenAiRequestBody } from "./transform.js";
import { convertGeminiStreamToOpenAi } from "../streaming/sse-converter.js";
import { createSseResponse } from "../streaming/sse-response.js";
import { getSelectionStrategy } from "../../../core/selection-strategy.js";

type ManagerLike = {
  selectAccount(
    provider: "antigravity",
    attempted: Set<string>,
    policy?: AccountSelectionStrategy,
  ): { accountId: string } | null;
  ensureFreshToken(
    provider: "antigravity",
    id: string,
    force?: boolean,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }>;
  markQuotaExhausted(
    provider: "antigravity",
    id: string,
    resetAt?: number,
  ): Promise<void>;
  markEntitlementBlocked(provider: "antigravity", id: string): Promise<void>;
  markDeadCandidate(provider: "antigravity", id: string): Promise<void>;
  touchLastUsed(provider: "antigravity", id: string): Promise<void>;
  list(provider: "antigravity"): Array<{ accountId: string }>;
  get(provider: "antigravity", id: string): AccountOf<"antigravity"> | undefined;
};

const DEFAULT_ANTIGRAVITY_QUOTA_COOLDOWN_MS = 5 * 60_000;

function parseRetryTime(text: string, headers?: Headers): number | undefined {
  if (headers) {
    const retryAfter = headers.get("retry-after");
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!Number.isNaN(seconds) && seconds > 0) {
        return Date.now() + seconds * 1000;
      }
    }
  }

  if (text) {
    const match = text.match(/resets?\s+(?:in|after)\s*(\d+h)?\s*(\d+m)?\s*(\d+s)?/i);
    if (match) {
      let totalMs = 0;
      if (match[1]) totalMs += parseInt(match[1], 10) * 3600 * 1000;
      if (match[2]) totalMs += parseInt(match[2], 10) * 60 * 1000;
      if (match[3]) totalMs += parseInt(match[3], 10) * 1000;
      if (totalMs > 0) return Date.now() + totalMs;
    }

    try {
      const parsed = JSON.parse(text);
      const details = parsed?.error?.details;
      if (Array.isArray(details)) {
        for (const d of details) {
          if (typeof d?.retryDelay === "string") {
            const sec = parseFloat(d.retryDelay);
            if (!Number.isNaN(sec) && sec > 0) return Date.now() + Math.ceil(sec * 1000);
          }
        }
      }
    } catch {
      // not json
    }
  }

  return undefined;
}

export function createAntigravityFetch(
  ctx: ProviderFetchContext,
  options?: { accountSelectionStrategy?: AccountSelectionStrategy },
): FetchLike {
  const manager = ctx.manager as ManagerLike;
  return async function antigravityFetch(input, init): Promise<Response> {
    const urlStr = String(input);

    // If request is not for chat completions or models, pass through
    if (!urlStr.includes("chat/completions") && !urlStr.includes("cloudcode-pa.googleapis.com")) {
      return fetch(input, init);
    }

    if (!init?.body || typeof init.body !== "string") {
      return fetch(input, init);
    }

    let openAiBody: OpenAiRequestBody;
    try {
      openAiBody = JSON.parse(init.body);
    } catch {
      return fetch(input, init);
    }

    const attempted = new Set<string>();
    const pool = manager.list("antigravity");
    const maxAttempts = Math.max(1, pool.length);

    const effectivePolicy = options?.accountSelectionStrategy ?? getSelectionStrategy();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const selected = manager.selectAccount("antigravity", attempted, effectivePolicy);
      if (!selected) break;

      const accountId = selected.accountId;
      attempted.add(accountId);

      const account = manager.get("antigravity", accountId);
      const projectId = account?.projectId || `useful-fuze-${accountId.slice(0, 5)}`;

      let tokens: { accessToken: string };
      try {
        tokens = await manager.ensureFreshToken("antigravity", accountId);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("invalid_grant")) {
          await manager.markDeadCandidate("antigravity", accountId);
        }
        logger.warn(`Antigravity token refresh failed for ${accountId}: ${msg}`);
        continue;
      }

      const geminiPayload = transformOpenAiToGemini(openAiBody, {
        projectId,
        sessionId: accountId,
      });

      const endpoints = [
        {
          url: `${ANTIGRAVITY_BASE_URL}/v1internal:streamGenerateContent?alt=sse`,
          isPrimary: true,
          timeoutMs: 60000,
        },
        {
          url: "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
          isPrimary: false,
          timeoutMs: 60000,
        },
      ];

      for (const ep of endpoints) {
        try {
          const res = await directGoogleFetch(ep.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${tokens.accessToken}`,
              "User-Agent": getAntigravityUserAgent(),
              "x-request-source": "local",
              "X-Machine-Session-Id": accountId,
              Accept: "text/event-stream",
            },
            body: JSON.stringify(geminiPayload),
            signal: init.signal,
            timeoutMs: ep.timeoutMs,
          });

          if (res.status === 200 && res.body) {
            void manager.touchLastUsed("antigravity", accountId);
            const chunkGenerator = convertGeminiStreamToOpenAi(
              res.body,
              openAiBody.model || "gemini-3.8-flash",
            );
            return createSseResponse(chunkGenerator, {
              signal: init.signal ?? undefined,
            });
          }

          const errorBody = await res.text();

          if (
            res.status === 403 &&
            (errorBody.includes("VALIDATION_REQUIRED") ||
              errorBody.includes("PERMISSION_DENIED"))
          ) {
            await manager.markEntitlementBlocked("antigravity", accountId);
            logger.warn(
              `Antigravity account ${account?.email || accountId} requires verification (VALIDATION_REQUIRED), blocked and rotating`,
            );
            break;
          }

          if (res.status === 429 || res.status === 403) {
            if (ep.isPrimary) {
              // Primary endpoint is exhausted for this account, fall back to secondary before rotating
              logger.debug(
                `Antigravity account ${account?.email || accountId} hit HTTP ${res.status} on primary, trying fallback endpoint...`,
              );
              continue;
            }
            const resetAt =
              parseRetryTime(errorBody, res.headers) ??
              Date.now() + DEFAULT_ANTIGRAVITY_QUOTA_COOLDOWN_MS;
            await manager.markQuotaExhausted("antigravity", accountId, resetAt);
            logger.info(
              `Antigravity account ${account?.email || accountId} quota exhausted, cooldown until ${new Date(resetAt).toLocaleTimeString()}, rotating to next account`,
            );
            break; // Break inner endpoint loop, rotate account
          }

          logger.warn(
            `Antigravity request failed: HTTP ${res.status} from ${ep.url} (account: ${account?.email || accountId})`,
            { error: errorBody.slice(0, 300) },
          );

          if (res.status === 401) {
            // Try refreshing once
            try {
              tokens = await manager.ensureFreshToken("antigravity", accountId, true);
              continue; // retry endpoint with fresh token
            } catch {
              break;
            }
          }

          if (res.status >= 500) {
            // Server error on this endpoint, try fallback endpoint
            continue;
          }

          // Other 4xx errors
          lastError = new Error(`Antigravity API error ${res.status}: ${errorBody}`);
          break;
        } catch (fetchErr) {
          lastError = fetchErr as Error;
          if (ep.isPrimary) {
            logger.debug(
              `Antigravity primary endpoint error (${(fetchErr as Error).message}), attempting fallback...`,
            );
            continue;
          }
          logger.warn(`Antigravity fetch error on ${ep.url}: ${(fetchErr as Error).message}`);
        }
      }
    }

    throw (
      lastError ||
      new Error(
        `All eligible Antigravity accounts (${pool.length}) exhausted or failed.`,
      )
    );
  };
}
