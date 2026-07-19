/**
 * xAI SuperGrok ProviderAdapter — host-pin, bearer overwrite, classify table,
 * rate-limit success recording, models catalog.
 */

import type {
  BuildHeadersContext,
  Classification,
  RecordSuccessContext,
  ResolveModelsOptions,
  TransportProviderAdapter,
  TransformBodyContext,
} from "../../core/adapter.js";
import {
  accountDisplayName,
  shortAccountId,
} from "../../core/tui-status.js";
import { formatBillingReset, formatUntil } from "../../core/format-time.js";
import { getSessionOptions, sessionIdFromHeaders } from "../../core/session-options.js";
import {
  DUMMY_API_KEY,
  PROVIDER_ID,
  XAI_API_BASE,
  XAI_API_HOST,
} from "./constants.js";
import {
  classifyResponse as classifyXaiResponse,
  classifyThrownError as classifyXaiThrownError,
} from "./request/classify-error.js";
import {
  hasRateLimitData,
  parseRateLimitHeaders,
  formatRemaining,
  formatCostUsd,
} from "./request/rate-limit.js";
import { injectXaiReasoningBody } from "./request/body-bridge.js";
import { resolveXaiMultiModels } from "./models-sync.js";
import {
  billingPeriodLabel,
  fetchGrokBillingQuota,
} from "./request/billing-quota.js";
import {
  deriveRemainingFromPlanUsage,
  fetchGrokPlan,
  formatPlanLimit,
  resolveXaiCreditResetsAtMs,
  resolveXaiPlanResetsAtMs,
  resolveXaiRemainingPercent,
} from "./request/plan.js";

function toUrl(input: string | URL): URL {
  return typeof input === "string" ? new URL(input) : new URL(input.href);
}

function resolveXaiUrl(input: string | URL): string {
  const url = toUrl(input);
  if (url.host !== XAI_API_HOST) {
    throw new Error(
      `xai resolveUrl refusing non-xAI host "${url.host}" (expected ${XAI_API_HOST})`,
    );
  }
  return url.toString();
}

function buildXaiHeaders(ctx: BuildHeadersContext): Headers {
  const headers = new Headers(ctx.initHeaders);
  // Always overwrite — SDK may have stuffed the dummy key.
  headers.set("Authorization", `Bearer ${ctx.accessToken}`);
  return headers;
}

function transformXaiBody(
  init: RequestInit | undefined,
  ctx: TransformBodyContext,
): RequestInit | undefined {
  const url = toUrl(ctx.url);
  const sessionId = sessionIdFromHeaders(
    init?.headers as Headers | Record<string, string> | undefined,
  );
  const sessionOptions =
    (ctx.sessionOptions as
      | {
          reasoningEffort?: string;
          reasoningSummary?: string;
          store?: boolean;
          include?: string[];
          promptCacheKey?: string;
        }
      | undefined) ?? getSessionOptions(sessionId);
  return injectXaiReasoningBody(url, init, sessionOptions);
}

async function classifyXaiHttp(
  res: Response,
  bodyText: string,
): Promise<Classification> {
  return classifyXaiResponse(res.status, res.headers, bodyText);
}

async function recordXaiSuccess(ctx: RecordSuccessContext): Promise<void> {
  try {
    const snap = parseRateLimitHeaders(ctx.response.headers);
    if (ctx.bodyText) {
      try {
        const body = JSON.parse(ctx.bodyText) as {
          usage?: { cost_in_usd_ticks?: number };
        };
        if (typeof body.usage?.cost_in_usd_ticks === "number") {
          snap.costInUsdTicks = body.usage.cost_in_usd_ticks;
        }
      } catch {
        // ignore body parse — headers still useful
      }
    }
    if (hasRateLimitData(snap) && ctx.record.recordRateLimit) {
      await ctx.record.recordRateLimit(ctx.accountId, { ...snap });
    }
  } catch {
    // never throw into the success path
  }
}

function periodTypeOf(account: Record<string, unknown>): string | undefined {
  return typeof account.billingPeriodType === "string"
    ? account.billingPeriodType
    : undefined;
}

function asFiniteMs(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function listSubtitle(account: Record<string, unknown>, now: number): string {
  const name = accountDisplayName({
    accountId: String(account.accountId ?? ""),
    email: typeof account.email === "string" ? account.email : undefined,
    label: typeof account.label === "string" ? account.label : undefined,
  });
  const parts: string[] = [name];
  if (typeof account.planName === "string" && account.planName) {
    parts.push(account.planName);
  }
  const rem = resolveXaiRemainingPercent({
    billingRemainingPercent:
      typeof account.billingRemainingPercent === "number"
        ? account.billingRemainingPercent
        : undefined,
    planUsed:
      typeof account.planUsed === "number" ? account.planUsed : undefined,
    planMonthlyLimit:
      typeof account.planMonthlyLimit === "number"
        ? account.planMonthlyLimit
        : undefined,
  });
  const usedPct =
    typeof account.billingMonthlyUsedPercent === "number"
      ? account.billingMonthlyUsedPercent
      : rem !== undefined
        ? 100 - rem
        : undefined;
  if (usedPct !== undefined) {
    const label = billingPeriodLabel(periodTypeOf(account));
    parts.push(`${label} ${Math.floor(usedPct)}%`);
  } else if (rem !== undefined) {
    parts.push(`${Math.round(rem)}% left`);
  }
  const creditReset = resolveXaiCreditResetsAtMs({
    billingResetsAt: asFiniteMs(account.billingResetsAt),
    billingPeriodEndMs: asFiniteMs(account.billingPeriodEndMs),
  });
  const planReset = resolveXaiPlanResetsAtMs({
    planPeriodEndMs: asFiniteMs(account.planPeriodEndMs),
  });
  if (creditReset !== undefined) {
    parts.push(
      `credits ${formatBillingReset(creditReset, now, {
        periodType: periodTypeOf(account),
      })}`,
    );
  }
  if (planReset !== undefined && planReset !== creditReset) {
    parts.push(`plan ${formatBillingReset(planReset, now)}`);
  }
  if (
    creditReset === undefined &&
    planReset === undefined &&
    typeof account.quotaResetAt === "number" &&
    account.quotaResetAt > now
  ) {
    parts.push(`quota ${formatUntil(account.quotaResetAt, now)}`);
  }
  return parts.join(" · ");
}

function detailLines(account: Record<string, unknown>, now: number): string[] {
  const lines: string[] = [];
  const id = String(account.accountId ?? "");
  lines.push(`id: ${shortAccountId(id)}`);
  if (typeof account.email === "string" && account.email) {
    lines.push(`email: ${account.email}`);
  }
  if (typeof account.planName === "string" && account.planName) {
    lines.push(`plan: ${account.planName}`);
  }
  const usedPct =
    typeof account.billingMonthlyUsedPercent === "number"
      ? account.billingMonthlyUsedPercent
      : undefined;
  const rem = resolveXaiRemainingPercent({
    billingRemainingPercent:
      typeof account.billingRemainingPercent === "number"
        ? account.billingRemainingPercent
        : undefined,
    planUsed:
      typeof account.planUsed === "number" ? account.planUsed : undefined,
    planMonthlyLimit:
      typeof account.planMonthlyLimit === "number"
        ? account.planMonthlyLimit
        : undefined,
  });
  if (usedPct !== undefined || rem !== undefined) {
    const label = billingPeriodLabel(periodTypeOf(account));
    const pct =
      usedPct !== undefined
        ? Math.floor(usedPct)
        : Math.round(100 - (rem ?? 0));
    lines.push(`${label}: ${pct}%`);
  }
  const creditReset = resolveXaiCreditResetsAtMs({
    billingResetsAt: asFiniteMs(account.billingResetsAt),
    billingPeriodEndMs: asFiniteMs(account.billingPeriodEndMs),
  });
  if (creditReset !== undefined) {
    lines.push(
      `Credits reset: ${formatBillingReset(creditReset, now, {
        periodType: periodTypeOf(account),
      })}`,
    );
  }
  if (
    typeof account.planUsed === "number" &&
    typeof account.planMonthlyLimit === "number" &&
    Number.isFinite(account.planUsed) &&
    Number.isFinite(account.planMonthlyLimit) &&
    account.planMonthlyLimit > 0
  ) {
    const derived = deriveRemainingFromPlanUsage(
      account.planUsed,
      account.planMonthlyLimit,
    );
    lines.push(
      `allowance: ${formatPlanLimit(account.planUsed)} / ${formatPlanLimit(account.planMonthlyLimit)}` +
        (derived ? ` (${Math.round(derived.remainingPercent)}% left)` : ""),
    );
  }
  const planReset = resolveXaiPlanResetsAtMs({
    planPeriodEndMs: asFiniteMs(account.planPeriodEndMs),
  });
  if (planReset !== undefined) {
    lines.push(`Plan reset: ${formatBillingReset(planReset, now)}`);
  }
  if (
    typeof account.rateLimitRemainingRequests === "number" ||
    typeof account.rateLimitLimitRequests === "number"
  ) {
    lines.push(
      `rate: ${formatRemaining(
        typeof account.rateLimitRemainingRequests === "number"
          ? account.rateLimitRemainingRequests
          : undefined,
        typeof account.rateLimitLimitRequests === "number"
          ? account.rateLimitLimitRequests
          : undefined,
      )}`,
    );
  }
  if (typeof account.lastCostInUsdTicks === "number") {
    lines.push(`last cost: ${formatCostUsd(account.lastCostInUsdTicks)}`);
  }
  if (
    typeof account.quotaResetAt === "number" &&
    account.quotaResetAt > now
  ) {
    lines.push(`quota until: ${formatUntil(account.quotaResetAt, now)}`);
  }
  if (
    typeof account.coolingDownUntil === "number" &&
    account.coolingDownUntil > now
  ) {
    lines.push(
      `cooling until: ${formatUntil(account.coolingDownUntil, now)}`,
    );
  }
  return lines;
}

async function probeXaiQuota(
  accessToken: string,
  _account: { accountId: string; organizationId?: string },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const billing = await fetchGrokBillingQuota(accessToken);
    out.billing = billing;
  } catch (err) {
    out.billingError = (err as Error).message;
  }
  try {
    const plan = await fetchGrokPlan(accessToken);
    out.plan = plan;
  } catch (err) {
    out.planError = (err as Error).message;
  }
  return out;
}

export const xaiAdapter: TransportProviderAdapter = {
  id: PROVIDER_ID,
  provider: "xai",
  displayName: "Grok Multi-Account",
  npmPackage: "@ai-sdk/xai",
  baseURL: XAI_API_BASE,
  dummyApiKey: DUMMY_API_KEY,

  resolveModels: (opts: ResolveModelsOptions) =>
    resolveXaiMultiModels({
      accessToken: opts.accessToken,
      userModels: opts.userModels,
      allowNetwork: opts.allowNetwork,
      cachePath: opts.cachePath,
    }),
  providerDefaultOptions: () => ({}),
  listSubtitle,
  detailLines,
  probeQuota: probeXaiQuota,
  transport: {
    kind: "http",
    resolveUrl: resolveXaiUrl,
    buildHeaders: buildXaiHeaders,
    transformBody: transformXaiBody,
    classifyResponse: classifyXaiHttp,
    classifyThrownError: classifyXaiThrownError,
    recordSuccess: recordXaiSuccess,
  },
};
