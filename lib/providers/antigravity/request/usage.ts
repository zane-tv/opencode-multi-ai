/**
 * Antigravity (Google Cloud Code / Gemini Code Assist) quota & usage fetching.
 *
 * Calls:
 * 1. `v1internal:loadCodeAssist` to fetch subscription tier and companion project.
 * 2. `v1internal:fetchAvailableModels` to fetch per-model quota buckets, remaining fractions,
 *    and reset timestamps.
 */

import {
  ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_PROD_URL,
  ANTIGRAVITY_SANDBOX_URL,
  getAntigravityUserAgent,
} from "../constants.js";
import { logger } from "../../../core/logger.js";

export type AntigravityModelQuota = {
  displayName?: string;
  remainingPercent: number;
  resetAt?: number;
};

export type AntigravityUsageSnapshot = {
  planType?: string;
  projectId?: string;
  primaryUsedPercent?: number;
  primaryResetAt?: number;
  secondaryUsedPercent?: number;
  secondaryResetAt?: number;
  modelQuotas?: Record<string, AntigravityModelQuota>;
  observedAt: number;
};

const LOAD_ENDPOINTS = [
  `${ANTIGRAVITY_PROD_URL}/v1internal:loadCodeAssist`,
  `${ANTIGRAVITY_BASE_URL}/v1internal:loadCodeAssist`,
  `${ANTIGRAVITY_SANDBOX_URL}/v1internal:loadCodeAssist`,
];

const MODELS_ENDPOINTS = [
  `${ANTIGRAVITY_PROD_URL}/v1internal:fetchAvailableModels`,
  `${ANTIGRAVITY_BASE_URL}/v1internal:fetchAvailableModels`,
  `${ANTIGRAVITY_SANDBOX_URL}/v1internal:fetchAvailableModels`,
];

/**
 * Fetch subscription tier & Google Cloud project from loadCodeAssist.
 */
async function fetchSubscriptionInfo(
  accessToken: string,
  timeoutMs = 10_000,
): Promise<{
  planType: string;
  projectId?: string;
}> {
  let lastError: Error | null = null;
  const userAgent = getAntigravityUserAgent();

  for (const url of LOAD_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": userAgent,
          "Content-Type": "application/json",
          "x-request-source": "local",
        },
        body: JSON.stringify({
          metadata: { ideType: 9, platform: 2, pluginType: 2 },
          mode: 1,
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = (await res.json()) as {
          paidTier?: { id?: string; name?: string };
          currentTier?: { id?: string; name?: string };
          cloudaicompanionProject?: string;
        };

        const paid = data.paidTier?.name || data.paidTier?.id;
        const current = data.currentTier?.name || data.currentTier?.id;
        let planType = paid || (current === "Antigravity" ? "Free" : current) || "Free";

        if (planType.toLowerCase().includes("free")) {
          planType = "Free";
        }

        return {
          planType,
          projectId: data.cloudaicompanionProject,
        };
      }
    } catch (err) {
      lastError = err as Error;
    } finally {
      clearTimeout(timer);
    }
  }

  logger.debug(`[antigravity-usage] loadCodeAssist failed: ${lastError?.message || "all endpoints failed"}`);
  return { planType: "Antigravity" };
}

type ModelsResponse = {
  models?: Record<
    string,
    {
      displayName?: string;
      quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
      };
    }
  >;
};

/**
 * Fetches available models and parses quota information for Antigravity accounts.
 */
export async function fetchAntigravityUsage(
  accessToken: string,
  options: { projectId?: string; timeoutMs?: number } = {},
): Promise<AntigravityUsageSnapshot> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const userAgent = getAntigravityUserAgent();

  const subInfo = await fetchSubscriptionInfo(accessToken, timeoutMs);
  const projectId = subInfo.projectId || options.projectId || "aicode-consumers";

  let responseData: ModelsResponse | null = null;
  let lastError: Error | null = null;

  for (const url of MODELS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": userAgent,
          "Content-Type": "application/json",
          "X-Client-Name": "antigravity",
          "X-Client-Version": "1.107.0",
          "x-request-source": "local",
        },
        body: JSON.stringify(projectId ? { project: projectId } : {}),
        signal: controller.signal,
      });

      // 403 fallback: retry without project payload
      if (res.status === 403 && projectId) {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": userAgent,
            "Content-Type": "application/json",
            "X-Client-Name": "antigravity",
            "X-Client-Version": "1.107.0",
            "x-request-source": "local",
          },
          body: JSON.stringify({}),
          signal: controller.signal,
        });
      }

      if (res.ok) {
        responseData = (await res.json()) as ModelsResponse;
        break;
      }
    } catch (err) {
      lastError = err as Error;
    } finally {
      clearTimeout(timer);
    }
  }

  const modelQuotas: Record<string, AntigravityModelQuota> = {};
  let minGeminiFraction: number | undefined;
  let geminiResetAt: number | undefined;

  let minClaudeFraction: number | undefined;
  let claudeResetAt: number | undefined;

  if (responseData?.models) {
    for (const [modelId, model] of Object.entries(responseData.models)) {
      const q = model?.quotaInfo;
      if (!q || typeof q.remainingFraction !== "number") continue;

      const frac = Math.max(0, Math.min(1, q.remainingFraction));
      const resetAt = q.resetTime ? Date.parse(q.resetTime) : undefined;
      const validReset = typeof resetAt === "number" && !Number.isNaN(resetAt) ? resetAt : undefined;

      // Track display quotas for prominent models
      const isTargetModel =
        modelId.startsWith("gemini-3.8-flash") ||
        modelId.startsWith("gemini-3.1-pro") ||
        modelId.startsWith("gemini-3.6-flash") ||
        modelId.startsWith("gemini-3-flash") ||
        modelId.startsWith("claude-sonnet") ||
        modelId.startsWith("claude-opus") ||
        modelId.startsWith("gpt-oss");

      if (isTargetModel) {
        modelQuotas[modelId] = {
          displayName: model.displayName || modelId,
          remainingPercent: Math.round(frac * 100),
          resetAt: validReset,
        };
      }

      // Group into Primary (Gemini) and Secondary (Claude)
      if (modelId.includes("gemini")) {
        if (
          modelId.startsWith("gemini-3.8-flash") ||
          modelId.startsWith("gemini-3.1-pro") ||
          modelId.startsWith("gemini-3.6-flash")
        ) {
          if (minGeminiFraction === undefined || frac < minGeminiFraction) {
            minGeminiFraction = frac;
            geminiResetAt = validReset;
          }
        }
      } else if (modelId.includes("claude")) {
        if (minClaudeFraction === undefined || frac < minClaudeFraction) {
          minClaudeFraction = frac;
          claudeResetAt = validReset;
        }
      }
    }
  }

  const primaryUsedPercent =
    minGeminiFraction !== undefined
      ? Math.max(0, Math.min(100, Math.round((1 - minGeminiFraction) * 100)))
      : undefined;

  const secondaryUsedPercent =
    minClaudeFraction !== undefined
      ? Math.max(0, Math.min(100, Math.round((1 - minClaudeFraction) * 100)))
      : undefined;

  return {
    planType: subInfo.planType,
    projectId,
    primaryUsedPercent,
    primaryResetAt: geminiResetAt,
    secondaryUsedPercent,
    secondaryResetAt: claudeResetAt,
    modelQuotas: Object.keys(modelQuotas).length > 0 ? modelQuotas : undefined,
    observedAt: Date.now(),
  };
}
