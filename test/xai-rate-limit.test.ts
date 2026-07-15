import { describe, expect, it, vi, afterEach } from "vitest";

import {
  formatCostUsd,
  formatRemaining,
  hasRateLimitData,
  parseRateLimitHeaders,
  probeAccountRateLimit,
} from "../lib/providers/xai/request/rate-limit.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRateLimitHeaders", () => {
  it("reads x-ratelimit remaining/limit headers", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "8300",
      "x-ratelimit-remaining-requests": "8299",
      "x-ratelimit-limit-tokens": "53000000",
      "x-ratelimit-remaining-tokens": "52999000",
    });
    const snap = parseRateLimitHeaders(headers);
    expect(snap.limitRequests).toBe(8300);
    expect(snap.remainingRequests).toBe(8299);
    expect(snap.limitTokens).toBe(53_000_000);
    expect(snap.remainingTokens).toBe(52_999_000);
    expect(hasRateLimitData(snap)).toBe(true);
  });

  it("formats remaining and cost", () => {
    expect(formatRemaining(8300, 8300)).toContain("100%");
    expect(formatRemaining(53_000_000, 53_000_000)).toContain("53M");
    expect(formatCostUsd(17_320_000)).toMatch(/\$0\.00/);
  });
});

describe("probeAccountRateLimit", () => {
  it("parses headers + cost from a successful probe", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          usage: { cost_in_usd_ticks: 17320000 },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit-requests": "8300",
            "x-ratelimit-remaining-requests": "8300",
            "x-ratelimit-limit-tokens": "53000000",
            "x-ratelimit-remaining-tokens": "53000000",
          },
        },
      ),
    ) as typeof fetch;

    const snap = await probeAccountRateLimit("tok");
    expect(snap.remainingRequests).toBe(8300);
    expect(snap.remainingTokens).toBe(53_000_000);
    expect(snap.costInUsdTicks).toBe(17_320_000);
  });
});
