/**
 * Bridge AccountManager → RotationManager for createRotationFetch.
 *
 * AccountManager methods take `(provider, id, …)`. Success-metric sinks on
 * RotationManager take `(id, snap)` only — the provider is fixed by the
 * adapter that owns the fetch. This wrapper closes over that provider for
 * record* calls so metrics land on the correct identity.
 */

import type { ProviderKind } from "./adapter.js";
import type { AccountManager } from "./accounts.js";
import type { AccountMetadata } from "./schemas.js";
import type { RotationAccount, RotationManager } from "./rotation-fetch.js";
import { getSelectionStrategy } from "./selection-strategy.js";

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toRotationAccount(account: AccountMetadata): RotationAccount {
  return {
    accountId: account.accountId,
    organizationId:
      account.provider === "codex" ? account.organizationId : undefined,
    quotaResetAt: account.quotaResetAt,
    coolingDownUntil: account.coolingDownUntil,
  };
}

/**
 * Build a RotationManager that scopes success metrics to `provider`
 * while still accepting the provider argument on selection/refresh APIs
 * (createRotationFetch always passes adapter.provider).
 */
export function toRotationManager(
  manager: AccountManager,
  provider: ProviderKind,
): RotationManager {
  return {
    selectAccount: (p, attempted) => {
      const account = manager.selectAccount(
        p,
        attempted,
        getSelectionStrategy(),
      );
      return account ? toRotationAccount(account) : null;
    },
    ensureFreshToken: (p, id, force) => manager.ensureFreshToken(p, id, force),
    markQuotaExhausted: (p, id, resetAt) =>
      manager.markQuotaExhausted(p, id, resetAt),
    markEntitlementBlocked: (p, id) =>
      manager.markEntitlementBlocked(p, id),
    recordCooldown: (p, id, reason, until) =>
      manager.recordCooldown(p, id, reason, until),
    markDeadCandidate: (p, id) => manager.markDeadCandidate(p, id),
    touchLastUsed: (p, id) => manager.touchLastUsed(p, id),
    list: (p) => manager.list(p).map(toRotationAccount),
    get: (p, id) => {
      const account = manager.get(p, id);
      return account ? toRotationAccount(account) : undefined;
    },
    recordRateLimit: async (id, snap) => {
      await manager.recordRateLimit(provider, id, {
        limitRequests: asOptionalNumber(snap.limitRequests),
        remainingRequests: asOptionalNumber(snap.remainingRequests),
        limitTokens: asOptionalNumber(snap.limitTokens),
        remainingTokens: asOptionalNumber(snap.remainingTokens),
        costInUsdTicks: asOptionalNumber(snap.costInUsdTicks),
        observedAt: asOptionalNumber(snap.observedAt),
      });
    },
    recordUsage: async (id, snap) => {
      await manager.recordUsage(provider, id, {
        planType: asOptionalString(snap.planType),
        primaryUsedPercent: asOptionalNumber(snap.primaryUsedPercent),
        primaryWindowMinutes: asOptionalNumber(snap.primaryWindowMinutes),
        primaryResetAt: asOptionalNumber(snap.primaryResetAt),
        secondaryUsedPercent: asOptionalNumber(snap.secondaryUsedPercent),
        secondaryWindowMinutes: asOptionalNumber(snap.secondaryWindowMinutes),
        secondaryResetAt: asOptionalNumber(snap.secondaryResetAt),
        activeLimit: asOptionalString(snap.activeLimit),
        observedAt: asOptionalNumber(snap.observedAt),
      });
    },
    recordPlan: async (id, snap) => {
      await manager.recordPlan(provider, id, {
        planTier: asOptionalNumber(snap.planTier),
        planName:
          asOptionalString(snap.planName) ??
          asOptionalString(snap.name) ??
          "unknown",
        planMonthlyLimit: asOptionalNumber(snap.planMonthlyLimit),
        planUsed: asOptionalNumber(snap.planUsed),
        planPeriodStartMs: asOptionalNumber(snap.planPeriodStartMs),
        planPeriodEndMs: asOptionalNumber(snap.planPeriodEndMs),
        observedAt: asOptionalNumber(snap.observedAt),
      });
    },
    recordBillingQuota: async (id, snap) => {
      const monthlyUsed = asOptionalNumber(snap.monthlyUsedPercent) ?? 0;
      const remaining =
        asOptionalNumber(snap.remainingPercent) ??
        Math.max(0, 100 - monthlyUsed);
      const periodTypeRaw = asOptionalString(snap.periodType);
      const periodType =
        periodTypeRaw === "weekly" ||
        periodTypeRaw === "monthly" ||
        periodTypeRaw === "unknown"
          ? periodTypeRaw
          : undefined;
      await manager.recordBillingQuota(provider, id, {
        monthlyUsedPercent: monthlyUsed,
        remainingPercent: remaining,
        resetsAtMs: asOptionalNumber(snap.resetsAtMs),
        periodType,
        periodStartMs: asOptionalNumber(snap.periodStartMs),
        periodEndMs: asOptionalNumber(snap.periodEndMs),
        isUnifiedBillingUser:
          typeof snap.isUnifiedBillingUser === "boolean"
            ? snap.isUnifiedBillingUser
            : undefined,
        observedAt: asOptionalNumber(snap.observedAt),
      });
    },
  };
}

/** Full-account manager shape required by Kiro AWS SDK custom fetch. */
export type KiroFetchManager = {
  selectAccount(
    provider: ProviderKind,
    attempted: Set<string>,
    policy?: import("./schemas.js").AccountSelectionStrategy,
  ): AccountMetadata | null;
  ensureFreshToken: RotationManager["ensureFreshToken"];
  markQuotaExhausted: RotationManager["markQuotaExhausted"];
  markEntitlementBlocked: RotationManager["markEntitlementBlocked"];
  recordCooldown: RotationManager["recordCooldown"];
  markDeadCandidate: RotationManager["markDeadCandidate"];
  touchLastUsed: RotationManager["touchLastUsed"];
  list(provider: ProviderKind): AccountMetadata[];
  get(provider: ProviderKind, id: string): AccountMetadata | undefined;
  recordKiroUsage(
    provider: ProviderKind,
    id: string,
    snap: {
      usedCount?: number;
      limitCount?: number;
      email?: string;
      observedAt?: number;
    },
  ): Promise<void>;
};

/**
 * Bridge AccountManager for Kiro custom fetch. Unlike toRotationManager,
 * list/get keep full rows (authMethod, region, profileArn, secrets).
 */
export function toKiroFetchManager(manager: AccountManager): KiroFetchManager {
  return {
    selectAccount: (p, attempted, policy) =>
      manager.selectAccount(p, attempted, policy ?? getSelectionStrategy()),
    ensureFreshToken: (p, id, force) => manager.ensureFreshToken(p, id, force),
    markQuotaExhausted: (p, id, resetAt) =>
      manager.markQuotaExhausted(p, id, resetAt),
    markEntitlementBlocked: (p, id) =>
      manager.markEntitlementBlocked(p, id),
    recordCooldown: (p, id, reason, until) =>
      manager.recordCooldown(p, id, reason, until),
    markDeadCandidate: (p, id) => manager.markDeadCandidate(p, id),
    touchLastUsed: (p, id) => manager.touchLastUsed(p, id),
    list: (p) => manager.list(p),
    get: (p, id) => manager.get(p, id),
    recordKiroUsage: (p, id, snap) => manager.recordKiroUsage(p, id, snap),
  };
}
