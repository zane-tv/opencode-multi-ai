import { describe, expect, it, vi } from "vitest";

import type {
  ProviderAdapter,
  TransportProviderAdapter,
} from "../lib/core/adapter.js";
import { createProviderFetch } from "../lib/core/provider-fetch.js";
import type { RotationManager } from "../lib/core/rotation-fetch.js";

const manager: RotationManager = {
  selectAccount() {
    return null;
  },
  async ensureFreshToken() {
    return { accessToken: "token" };
  },
  async markQuotaExhausted() {},
  async markEntitlementBlocked() {},
  async recordCooldown() {},
  async markDeadCandidate() {},
  async touchLastUsed() {},
  list() {
    return [];
  },
};

const legacyHttp: ProviderAdapter = {
  id: "xai-multi",
  provider: "xai",
  displayName: "xAI",
  npmPackage: "@ai-sdk/xai",
  baseURL: "https://api.x.ai/v1",
  dummyApiKey: "dummy",
  resolveUrl(input) {
    return String(input);
  },
  buildHeaders() {
    return new Headers();
  },
  transformBody(init) {
    return init;
  },
  classifyResponse() {
    return { kind: "ok" };
  },
  classifyThrownError() {
    return { kind: "network" };
  },
  async recordSuccess() {},
  async resolveModels() {
    return {};
  },
  providerDefaultOptions() {
    return {};
  },
  listSubtitle() {
    return "";
  },
  detailLines() {
    return [];
  },
};

describe("createProviderFetch", () => {
  it("delegates a custom transport once with its descriptor and manager", async () => {
    const fetch = vi.fn(async () => new Response("custom"));
    const createFetch = vi.fn(() => fetch);
    const custom: TransportProviderAdapter = {
      id: "kiro-multi",
      provider: "kiro",
      displayName: "Kiro",
      npmPackage: "@ai-sdk/openai-compatible",
      baseURL: "https://q.us-east-1.amazonaws.com",
      dummyApiKey: "dummy",
      async resolveModels() {
        return {};
      },
      providerDefaultOptions() {
        return {};
      },
      listSubtitle() {
        return "";
      },
      detailLines() {
        return [];
      },
      transport: {
        kind: "custom",
        createFetch,
      },
    };

    const result = await createProviderFetch(custom, manager)("https://example.com");

    expect(await result.text()).toBe("custom");
    expect(createFetch).toHaveBeenCalledWith({
      descriptor: custom,
      manager,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accepts legacy HTTP adapters during the Wave 5 migration", () => {
    expect(typeof createProviderFetch(legacyHttp, manager)).toBe("function");
  });
});
