import { describe, expect, it } from "vitest";
import { isProviderAdapter } from "../lib/core/adapter.js";
import { xaiAdapter } from "../lib/providers/xai/index.js";
import {
  CLIENT_ID,
  REDIRECT_URI,
  OAUTH_EXTRA_PARAMS,
  PROVIDER_ID,
  XAI_API_BASE,
  defaultModelsCachePath,
} from "../lib/providers/xai/constants.js";

function transport() {
  if (xaiAdapter.transport.kind !== "http") {
    throw new Error("xAI must use the HTTP transport");
  }
  return xaiAdapter.transport;
}

describe("xaiAdapter", () => {
  it("satisfies ProviderAdapter and identity fields", () => {
    expect(isProviderAdapter(xaiAdapter)).toBe(true);
    expect(xaiAdapter.id).toBe("xai-multi");
    expect(xaiAdapter.provider).toBe("xai");
    expect(xaiAdapter.displayName).toBe("Grok Multi-Account");
    expect(xaiAdapter.npmPackage).toBe("@ai-sdk/xai");
    expect(xaiAdapter.baseURL).toBe(XAI_API_BASE);
    expect(xaiAdapter.dummyApiKey).toBe("multi-xai-dummy-key");
    expect(xaiAdapter.hostAuth).toBeUndefined();
  });

  it("host-pins api.x.ai and never rewrites", () => {
    const ok = "https://api.x.ai/v1/chat/completions";
    expect(transport().resolveUrl(ok)).toBe(ok);
    expect(() =>
      transport().resolveUrl("https://api.openai.com/v1/chat"),
    ).toThrow(/non-xAI host/);
  });

  it("overwrites Authorization bearer", () => {
    const h = transport().buildHeaders({
      accessToken: "tok-abc",
      accountId: "a1",
      initHeaders: { Authorization: "Bearer dummy" },
    });
    expect(h.get("Authorization")).toBe("Bearer tok-abc");
  });

  it("classifies ok / quota / 429 via adapter surface", async () => {
    const ok = await transport().classifyResponse(
      new Response("{}", { status: 200 }),
      "{}",
    );
    expect(ok).toEqual({ kind: "ok" });

    const quota = await transport().classifyResponse(
      new Response(
        JSON.stringify({
          error: "Your team has used all available credits",
        }),
        { status: 403 },
      ),
      JSON.stringify({
        error: "Your team has used all available credits",
      }),
    );
    expect(quota.kind).toBe("quota-exhausted");
  });

  it("keeps public OAuth constants stable", () => {
    expect(CLIENT_ID).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(REDIRECT_URI).toBe("http://127.0.0.1:56121/callback");
    expect(OAUTH_EXTRA_PARAMS).toEqual({ plan: "generic" });
    expect(PROVIDER_ID).toBe("xai-multi");
    expect(defaultModelsCachePath()).toMatch(/multi-ai-models-xai\.json$/);
  });

  it("surfaces weekly limit + credits/plan reset like Grok Build", () => {
    const now = Date.UTC(2026, 6, 19, 12, 0, 0);
    const creditReset = now + 3 * 24 * 60 * 60 * 1000;
    const planReset = now + 12 * 24 * 60 * 60 * 1000;
    const account = {
      accountId: "acc-heavy",
      label: "Heavy",
      planName: "SuperGrok Heavy",
      planUsed: 94_000,
      planMonthlyLimit: 150_000,
      planPeriodEndMs: planReset,
      billingRemainingPercent: 27,
      billingMonthlyUsedPercent: 73,
      billingPeriodType: "weekly",
      billingResetsAt: creditReset,
    };
    const subtitle = xaiAdapter.listSubtitle?.(account, now) ?? "";
    expect(subtitle).toMatch(/Weekly limit 73%/i);
    expect(subtitle).toMatch(/credits /i);
    expect(subtitle).toMatch(/plan /i);
    const lines = xaiAdapter.detailLines?.(account, now) ?? [];
    expect(lines.some((l) => /Weekly limit:\s*73%/i.test(l))).toBe(true);
    expect(lines.some((l) => /^Credits reset:/i.test(l))).toBe(true);
    expect(lines.some((l) => /^Plan reset:/i.test(l))).toBe(true);
    expect(lines.some((l) => /allowance:/i.test(l))).toBe(true);
  });

  it("shows plan reset when only planPeriodEndMs is present", () => {
    const now = Date.UTC(2026, 6, 19, 12, 0, 0);
    const periodEnd = now + 5 * 24 * 60 * 60 * 1000;
    const lines =
      xaiAdapter.detailLines?.(
        {
          accountId: "acc-lite",
          planName: "SuperGrok Lite",
          planUsed: 10_000,
          planMonthlyLimit: 15_000,
          planPeriodEndMs: periodEnd,
        },
        now,
      ) ?? [];
    expect(lines.some((l) => /^Plan reset:/i.test(l))).toBe(true);
    expect(lines.some((l) => /^Credits reset:/i.test(l))).toBe(false);
  });
});
