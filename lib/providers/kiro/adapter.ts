import type {
  ProviderFetchContext,
  TransportProviderAdapter,
} from "../../core/adapter.js";
import {
  DUMMY_API_KEY,
  KIRO_BASE_URL,
  PROVIDER_ID,
} from "./constants.js";
import { resolveKiroMultiModels } from "./models-sync.js";
import { createKiroFetch } from "./request/kiro-fetch.js";
import { fetchKiroUsageLimits } from "./request/usage.js";
import type {
  AccountOf,
  AccountSelectionStrategy,
} from "../../core/schemas.js";

export type KiroAdapterOptions = {
  accountSelectionStrategy?: AccountSelectionStrategy;
};

export function createKiroAdapter(
  options: KiroAdapterOptions = {},
): TransportProviderAdapter {
  const strategy = options.accountSelectionStrategy ?? "sticky";
  return {
    id: PROVIDER_ID,
    provider: "kiro",
    displayName: "Kiro Multi-Account",
    npmPackage: "@ai-sdk/openai-compatible",
    baseURL: KIRO_BASE_URL,
    dummyApiKey: DUMMY_API_KEY,
    async resolveModels(opts) {
      return resolveKiroMultiModels({
        userModels: opts.userModels,
        allowNetwork: opts.allowNetwork,
        cachePath: opts.cachePath,
      });
    },
    providerDefaultOptions() {
      return { accountSelectionStrategy: strategy };
    },
    listSubtitle(account) {
      const method =
        typeof account.authMethod === "string" ? account.authMethod : "kiro";
      const used =
        typeof account.usedCount === "number" ? account.usedCount : undefined;
      const limit =
        typeof account.limitCount === "number" ? account.limitCount : undefined;
      if (used !== undefined && limit !== undefined && limit > 0) {
        const rem = Math.max(0, Math.round(100 - (used / limit) * 100));
        return `${method} · ${rem}% left`;
      }
      return method;
    },
    detailLines(account) {
      const lines: string[] = [];
      if (typeof account.email === "string") lines.push(account.email);
      if (typeof account.authMethod === "string") {
        lines.push(`auth: ${account.authMethod}`);
      }
      if (typeof account.region === "string") lines.push(`region: ${account.region}`);
      if (
        typeof account.usedCount === "number" &&
        typeof account.limitCount === "number"
      ) {
        lines.push(`usage: ${account.usedCount}/${account.limitCount}`);
      }
      return lines;
    },
    async probeQuota(accessToken, account) {
      const stub: AccountOf<"kiro"> = {
        provider: "kiro",
        accountId: account.accountId,
        tags: [],
        refreshToken: "",
        enabled: true,
        priority: 0,
        addedAt: 0,
        lastUsed: 0,
        lastSwitchReason: "initial",
        subscriptionStatus: "active",
        flaggedForRemoval: false,
        entitlementBlocked: false,
        authMethod: "desktop",
        region: "us-east-1",
      };
      const snap = await fetchKiroUsageLimits(stub, accessToken);
      return { ...snap };
    },
    transport: {
      kind: "custom",
      createFetch(ctx: ProviderFetchContext) {
        return createKiroFetch(ctx, {
          accountSelectionStrategy: strategy,
        });
      },
    },
  };
}

export const kiroAdapter = createKiroAdapter();
