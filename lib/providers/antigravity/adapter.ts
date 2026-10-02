import type {
  ProviderFetchContext,
  TransportProviderAdapter,
} from "../../core/adapter.js";
import {
  ANTIGRAVITY_BASE_URL,
  DUMMY_API_KEY,
  PROVIDER_ID,
} from "./constants.js";
import { resolveAntigravityMultiModels } from "./models-sync.js";
import { createAntigravityFetch } from "./request/antigravity-fetch.js";
import type { AccountSelectionStrategy } from "../../core/schemas.js";

export type AntigravityAdapterOptions = {
  accountSelectionStrategy?: AccountSelectionStrategy;
};

export function createAntigravityAdapter(
  options: AntigravityAdapterOptions = {},
): TransportProviderAdapter {
  const strategy = options.accountSelectionStrategy ?? "sticky";

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
      return { accountSelectionStrategy: strategy };
    },

    listSubtitle(account, now) {
      if (typeof account.quotaResetAt === "number" && account.quotaResetAt > now) {
        const minsLeft = Math.ceil((account.quotaResetAt - now) / 60_000);
        return `recovering · ${minsLeft}m left`;
      }
      if (typeof account.tier === "string") return account.tier;
      if (typeof account.accountType === "string") return account.accountType;
      return "google-cloud-code";
    },

    detailLines(account) {
      const lines: string[] = [];
      if (typeof account.email === "string") lines.push(account.email);
      if (typeof account.projectId === "string") {
        lines.push(`project: ${account.projectId}`);
      }
      if (typeof account.accountType === "string") {
        lines.push(`tier: ${account.accountType}`);
      }
      return lines;
    },

    transport: {
      kind: "custom",
      createFetch(ctx: ProviderFetchContext) {
        return createAntigravityFetch(ctx, { accountSelectionStrategy: strategy });
      },
    },
  };
}

export const antigravityAdapter = createAntigravityAdapter();
