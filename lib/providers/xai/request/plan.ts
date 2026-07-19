/**
 * SuperGrok subscription plan snapshot.
 *
 * Sources (best-effort, no secrets logged):
 * 1. Access JWT claim `tier` (numeric)
 * 2. GET https://cli-chat-proxy.grok.com/v1/billing — monthlyLimit / used / period
 */

import { decodeJwt } from "../auth/oauth.js";

export const GROK_LEGACY_BILLING_URL =
  "https://cli-chat-proxy.grok.com/v1/billing";

export type PlanSnapshot = {
  planTier?: number;
  planName: string;
  planMonthlyLimit?: number;
  planUsed?: number;
  planPeriodStartMs?: number;
  planPeriodEndMs?: number;
  observedAt: number;
};

/**
 * JWT `tier` → label (best-effort).
 *
 * Public docs do not publish a full map. Observed SuperGrok OAuth accounts:
 * - tier 5 + monthlyLimit ~150k → SuperGrok Heavy (user-confirmed)
 * Prefer monthlyLimit over JWT when both exist (limit is the billing truth).
 */
const TIER_LABELS: Record<number, string> = {
  0: "Free",
  1: "Free",
  2: "SuperGrok Lite",
  3: "SuperGrok",
  4: "X Premium+",
  // tier 5 previously mislabeled "SuperGrok"; Heavy accounts report tier 5.
  5: "SuperGrok Heavy",
  6: "SuperGrok Heavy",
  7: "SuperGrok Heavy",
  8: "Team / Business",
  9: "Enterprise",
};

/** Rank for merging tier vs limit labels (higher wins). */
const PLAN_RANK: Record<string, number> = {
  Free: 0,
  "SuperGrok Lite": 1,
  SuperGrok: 2,
  "X Premium+": 2,
  "SuperGrok Heavy": 3,
  "SuperGrok Heavy+": 4,
  "Team / Business": 4,
  Enterprise: 5,
};

function numVal(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "val" in (v as object)) {
    const n = Number((v as { val: unknown }).val);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function parseIsoMs(v: unknown): number | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Infer display name from absolute monthly credit limit
 * (cli-chat-proxy /v1/billing monthlyLimit).
 *
 * Observed: SuperGrok Heavy ≈ 150_000 monthly units.
 */
export function inferPlanNameFromLimit(limit?: number): string | undefined {
  if (limit === undefined) return undefined;
  if (limit <= 0) return "Free";
  if (limit < 50_000) return "SuperGrok Lite";
  if (limit < 150_000) return "SuperGrok";
  if (limit < 400_000) return "SuperGrok Heavy";
  return "SuperGrok Heavy+";
}

/**
 * Resolve plan label.
 * Priority: monthly limit (billing) > JWT tier map > generic SuperGrok.
 * When both exist, pick the higher-ranked label so Heavy is not downgraded.
 */
export function planNameFromTier(tier?: number, limit?: number): string {
  const fromLimit = inferPlanNameFromLimit(limit);
  const fromTier =
    tier !== undefined && TIER_LABELS[tier]
      ? TIER_LABELS[tier]
      : tier !== undefined
        ? `SuperGrok (tier ${tier})`
        : undefined;

  if (fromLimit && fromTier) {
    const rL = PLAN_RANK[fromLimit] ?? 0;
    const rT = PLAN_RANK[fromTier] ?? 0;
    return rL >= rT ? fromLimit : fromTier;
  }
  if (fromLimit) return fromLimit;
  if (fromTier) return fromTier;
  return "SuperGrok";
}

/** Read plan tier from a JWT access token (no network). */
export function planFromAccessToken(
  accessToken: string,
  nowMs: number = Date.now(),
): Pick<PlanSnapshot, "planTier" | "planName" | "observedAt"> {
  try {
    const claims = decodeJwt(accessToken);
    const raw = claims["tier"];
    const tier =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim()
          ? Number(raw)
          : undefined;
    const planTier =
      tier !== undefined && Number.isFinite(tier) ? tier : undefined;
    return {
      planTier,
      planName: planNameFromTier(planTier),
      observedAt: nowMs,
    };
  } catch {
    return { planName: "SuperGrok", observedAt: nowMs };
  }
}

/**
 * Fetch absolute monthly limit / used / period from legacy Grok billing JSON.
 * Complements gRPC % remaining used elsewhere.
 */
export async function fetchGrokPlan(
  accessToken: string,
  nowMs: number = Date.now(),
): Promise<PlanSnapshot> {
  const fromJwt = planFromAccessToken(accessToken, nowMs);

  const res = await fetch(GROK_LEGACY_BILLING_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": "opencode-multi-ai",
    },
  });

  if (res.status === 401 || res.status === 403) {
    // Still return JWT tier if present.
    return {
      ...fromJwt,
      planName: planNameFromTier(fromJwt.planTier),
    };
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 120);
    throw new Error(
      `plan billing HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }

  const body = (await res.json()) as Record<string, unknown>;
  const config =
    body["config"] && typeof body["config"] === "object"
      ? (body["config"] as Record<string, unknown>)
      : body;

  const planMonthlyLimit = numVal(config["monthlyLimit"]);
  const usage =
    config["usage"] && typeof config["usage"] === "object"
      ? (config["usage"] as Record<string, unknown>)
      : undefined;
  const planUsed =
    numVal(config["used"]) ??
    numVal(config["totalUsed"]) ??
    numVal(usage?.["totalUsed"]) ??
    numVal(usage?.["includedUsed"]);

  const cycle =
    config["billingCycle"] && typeof config["billingCycle"] === "object"
      ? (config["billingCycle"] as Record<string, unknown>)
      : undefined;
  const planPeriodStartMs =
    parseIsoMs(config["billingPeriodStart"]) ??
    parseIsoMs(cycle?.["billingPeriodStart"]);
  const planPeriodEndMs =
    parseIsoMs(config["billingPeriodEnd"]) ??
    parseIsoMs(cycle?.["billingPeriodEnd"]);

  const planName = planNameFromTier(fromJwt.planTier, planMonthlyLimit);

  return {
    planTier: fromJwt.planTier,
    planName,
    planMonthlyLimit,
    planUsed,
    planPeriodStartMs,
    planPeriodEndMs,
    observedAt: nowMs,
  };
}

export function deriveRemainingFromPlanUsage(
  used?: number,
  limit?: number,
): { monthlyUsedPercent: number; remainingPercent: number } | undefined {
  if (
    used === undefined ||
    limit === undefined ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return undefined;
  }
  const monthlyUsedPercent = Math.min(
    999,
    Math.max(0, (used / limit) * 100),
  );
  const remainingPercent = Math.max(0, 100 - Math.round(monthlyUsedPercent));
  return { monthlyUsedPercent, remainingPercent };
}

/** Prefer Grok Build period credits % over legacy absolute monthly units. */
export function resolveXaiRemainingPercent(account: {
  billingRemainingPercent?: number;
  billingPeriodType?: string;
  planUsed?: number;
  planMonthlyLimit?: number;
}): number | undefined {
  const bill = account.billingRemainingPercent;
  if (typeof bill === "number" && Number.isFinite(bill)) {
    return Math.max(0, Math.min(100, bill));
  }

  const fromPlan = deriveRemainingFromPlanUsage(
    account.planUsed,
    account.planMonthlyLimit,
  );
  if (fromPlan) return fromPlan.remainingPercent;
  return undefined;
}

export function formatPlanLimit(n?: number): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

export function resolveXaiCreditResetsAtMs(account: {
  billingResetsAt?: number;
  billingPeriodEndMs?: number;
}): number | undefined {
  if (
    typeof account.billingResetsAt === "number" &&
    Number.isFinite(account.billingResetsAt)
  ) {
    return account.billingResetsAt;
  }
  if (
    typeof account.billingPeriodEndMs === "number" &&
    Number.isFinite(account.billingPeriodEndMs)
  ) {
    return account.billingPeriodEndMs;
  }
  return undefined;
}

export function resolveXaiPlanResetsAtMs(account: {
  planPeriodEndMs?: number;
}): number | undefined {
  if (
    typeof account.planPeriodEndMs === "number" &&
    Number.isFinite(account.planPeriodEndMs)
  ) {
    return account.planPeriodEndMs;
  }
  return undefined;
}
