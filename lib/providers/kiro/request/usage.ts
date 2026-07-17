import type { AccountOf } from "../../../core/schemas.js";
import { kiroCodeWhispererEndpoint } from "../constants.js";

export type KiroUsageSnapshot = {
  usedCount?: number;
  limitCount?: number;
  email?: string;
  subscriptionTitle?: string;
  observedAt: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseUsagePayload(payload: Record<string, unknown>): KiroUsageSnapshot {
  const breakdown = Array.isArray(payload.usageBreakdownList)
    ? payload.usageBreakdownList
    : [];
  let used = 0;
  let limit = 0;
  for (const entry of breakdown) {
    const row = asRecord(entry);
    const trial = asRecord(row.freeTrialInfo);
    used +=
      asNumber(row.currentUsage) ??
      asNumber(row.currentUsageWithPrecision) ??
      0;
    used +=
      asNumber(trial.currentUsage) ??
      asNumber(trial.currentUsageWithPrecision) ??
      0;
    limit +=
      asNumber(row.usageLimit) ?? asNumber(row.usageLimitWithPrecision) ?? 0;
    limit +=
      asNumber(trial.usageLimit) ?? asNumber(trial.usageLimitWithPrecision) ?? 0;
  }
  const userInfo = asRecord(payload.userInfo);
  const subscription = asRecord(payload.subscriptionInfo);
  return {
    usedCount: breakdown.length > 0 ? used : undefined,
    limitCount: breakdown.length > 0 ? limit : undefined,
    email:
      typeof payload.email === "string"
        ? payload.email
        : typeof userInfo.email === "string"
          ? userInfo.email
          : undefined,
    subscriptionTitle:
      typeof subscription.subscriptionTitle === "string"
        ? subscription.subscriptionTitle
        : typeof subscription.type === "string"
          ? subscription.type
          : undefined,
    observedAt: Date.now(),
  };
}

function usageHosts(account: AccountOf<"kiro">): string[] {
  const region = account.region || "us-east-1";
  if (account.authMethod === "api-key") {
    const hosts = [
      `https://management.${region}.kiro.dev/getUsageLimits`,
      kiroCodeWhispererEndpoint(region) + "/getUsageLimits",
    ];
    // Subscription/userInfo for API keys is often served from us-east-1.
    if (region !== "us-east-1") {
      hosts.push(
        "https://management.us-east-1.kiro.dev/getUsageLimits",
        "https://q.us-east-1.amazonaws.com/getUsageLimits",
      );
    }
    return hosts;
  }
  return [kiroCodeWhispererEndpoint(region) + "/getUsageLimits"];
}

function authHeaders(
  account: AccountOf<"kiro">,
  accessToken: string,
  host: string,
): Record<string, string> {
  if (account.authMethod === "api-key" && host.includes("management.")) {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      TokenType: "API_KEY",
    };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-amzn-kiro-agent-mode": "vibe",
  };
  if (account.authMethod === "external-idp") {
    headers.TokenType = "EXTERNAL_IDP";
  } else if (account.authMethod === "api-key") {
    headers.TokenType = "API_KEY";
    headers.tokentype = "API_KEY";
  }
  if (account.profileArn && account.authMethod !== "api-key") {
    headers["x-amzn-codewhisperer-profile-arn"] = account.profileArn;
  }
  return headers;
}

const PARAM_SETS: ReadonlyArray<{
  resourceType?: string;
  origin?: string;
}> = [
  { resourceType: "AGENTIC_REQUEST", origin: "AI_EDITOR" },
  { origin: "AI_EDITOR" },
  { resourceType: "CONVERSATION", origin: "AI_EDITOR" },
  {},
];

export async function fetchKiroUsageLimits(
  account: AccountOf<"kiro">,
  accessToken: string,
): Promise<KiroUsageSnapshot> {
  let lastError: Error | undefined;

  for (const host of usageHosts(account)) {
    for (const params of PARAM_SETS) {
      try {
        const query = new URL(host);
        query.searchParams.set("isEmailRequired", "true");
        if (params.origin) query.searchParams.set("origin", params.origin);
        if (params.resourceType) {
          query.searchParams.set("resourceType", params.resourceType);
        }
        if (account.profileArn && account.authMethod !== "api-key") {
          query.searchParams.set("profileArn", account.profileArn);
        }
        const res = await fetch(query.toString(), {
          method: "GET",
          headers: authHeaders(account, accessToken, host),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (
            body.includes("FEATURE_NOT_SUPPORTED") &&
            params.resourceType !== undefined
          ) {
            continue;
          }
          lastError = new Error(`usage HTTP ${res.status}`);
          continue;
        }
        const payload = asRecord(await res.json());
        return parseUsagePayload(payload);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  throw lastError ?? new Error("Failed to fetch Kiro usage limits");
}
