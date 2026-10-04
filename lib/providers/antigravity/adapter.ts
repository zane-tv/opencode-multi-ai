import type {
  ProviderFetchContext,
  TransportProviderAdapter,
} from "../../core/adapter.js";
import { formatUntil } from "../../core/format-time.js";
import { getSelectionStrategy } from "../../core/selection-strategy.js";
import {
  ANTIGRAVITY_BASE_URL,
  DUMMY_API_KEY,
  PROVIDER_ID,
} from "./constants.js";
import { resolveAntigravityMultiModels } from "./models-sync.js";
import { createAntigravityFetch } from "./request/antigravity-fetch.js";
import { fetchAntigravityUsage } from "./request/usage.js";
import type { AccountSelectionStrategy } from "../../core/schemas.js";

export type AntigravityAdapterOptions = {
  accountSelectionStrategy?: AccountSelectionStrategy;
};

function leftPercent(used: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - used)));
}

export function createAntigravityAdapter(
  options: AntigravityAdapterOptions = {},
): TransportProviderAdapter {
  return {
    id: PROVIDER_ID,
    provider: "antigravity",
    displayName: "Antigravity Multi-Account (Gemini)",
    npmPackage: "@ai-sdk/openai-compatible",
    baseURL: ANTIGRAVITY_BASE_URL,
    dummyApiKey: DUMMY_API_KEY,

    async resolveModels(opts) {
      return resolveAntigravityMultiModels({
        userModels: opts.userModels,
        allowNetwork: opts.allowNetwork,
      });
    },

    providerDefaultOptions() {
      return {
        accountSelectionStrategy:
          options.accountSelectionStrategy ??
          getSelectionStrategy("antigravity"),
      };
    },

    listSubtitle(account, now) {
      if (typeof account.quotaResetAt === "number" && account.quotaResetAt > now) {
        const minsLeft = Math.ceil((account.quotaResetAt - now) / 60_000);
        return `recovering · ${minsLeft}m left`;
      }
      const plan =
        (typeof account.planType === "string" && account.planType.trim()) ||
        (typeof account.tier === "string" && account.tier.trim()) ||
        (typeof account.accountType === "string" && account.accountType.trim());
      const primary =
        typeof account.primaryUsedPercent === "number" &&
        Number.isFinite(account.primaryUsedPercent)
          ? account.primaryUsedPercent
          : undefined;
      const resetAt =
        typeof account.primaryResetAt === "number" ? account.primaryResetAt : undefined;

      const parts: string[] = [];
      if (plan) parts.push(plan);
      if (primary !== undefined) {
        parts.push(`${leftPercent(primary)}% left`);
        if (typeof resetAt === "number" && resetAt > now) {
          parts.push(`resets ${formatUntil(resetAt, now)}`);
        }
      }
      if (parts.length === 0) {
        return "google-cloud-code";
      }
      return parts.join(" · ");
    },

    detailLines(account, now) {
      const lines: string[] = [];
      if (typeof account.email === "string") lines.push(account.email);
      const plan =
        (typeof account.planType === "string" && account.planType.trim()) ||
        (typeof account.tier === "string" && account.tier.trim()) ||
        (typeof account.accountType === "string" && account.accountType.trim());
      if (plan) lines.push(`plan: ${plan}`);

      if (typeof account.projectId === "string" && account.projectId.trim()) {
        lines.push(`project: ${account.projectId}`);
      }

      const primary =
        typeof account.primaryUsedPercent === "number" &&
        Number.isFinite(account.primaryUsedPercent)
          ? account.primaryUsedPercent
          : undefined;
      if (primary !== undefined) {
        const resetAt =
          typeof account.primaryResetAt === "number" ? account.primaryResetAt : undefined;
        const until =
          typeof resetAt === "number" && resetAt > now
            ? ` · resets ${formatUntil(resetAt, now)}`
            : "";
        lines.push(`primary: ${leftPercent(primary)}% left (Gemini)${until}`);
      }

      const secondary =
        typeof account.secondaryUsedPercent === "number" &&
        Number.isFinite(account.secondaryUsedPercent)
          ? account.secondaryUsedPercent
          : undefined;
      if (secondary !== undefined) {
        const resetAt =
          typeof account.secondaryResetAt === "number" ? account.secondaryResetAt : undefined;
        const until =
          typeof resetAt === "number" && resetAt > now
            ? ` · resets ${formatUntil(resetAt, now)}`
            : "";
        lines.push(`secondary: ${leftPercent(secondary)}% left (Claude)${until}`);
      }

      if (account.enabled === false) lines.push("disabled");
      if (account.subscriptionStatus === "dead") lines.push("dead");
      if (account.entitlementBlocked === true) lines.push("entitlement blocked");

      return lines;
    },

    async probeQuota(accessToken, account) {
      const snap = await fetchAntigravityUsage(accessToken, {
        projectId: typeof account.projectId === "string" ? account.projectId : undefined,
      });
      return { ...snap };
    },

    transport: {
      kind: "custom",
      createFetch(ctx: ProviderFetchContext) {
        return createAntigravityFetch(ctx, {
          accountSelectionStrategy: options.accountSelectionStrategy,
        });
      },
    },
  };
}

export const antigravityAdapter = createAntigravityAdapter();
