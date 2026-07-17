import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApiKeyCandidate } from "../lib/providers/kiro/auth/api-key.js";
import { loginWithApiKey } from "../lib/providers/kiro/auth/login.js";
import { fetchKiroUsageLimits } from "../lib/providers/kiro/request/usage.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchKiroUsageLimits for api-key", () => {
  it("reads email + usage from management.us-east-1 userInfo payload", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("management.eu-central-1")) {
          return new Response(JSON.stringify({ message: "Invalid token" }), {
            status: 403,
          });
        }
        if (url.includes("management.us-east-1.kiro.dev/getUsageLimits")) {
          return new Response(
            JSON.stringify({
              usageBreakdownList: [
                {
                  currentUsage: 0,
                  usageLimit: 10000,
                  freeTrialInfo: null,
                },
              ],
              userInfo: { email: "user@example.com", userId: "u1" },
              subscriptionInfo: { subscriptionTitle: "KIRO POWER" },
            }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 404 });
      }),
    );

    const account = buildApiKeyCandidate(
      `ksk_${"a".repeat(24)}`,
      "eu-central-1",
    );
    const snap = await fetchKiroUsageLimits(account, account.refreshToken);
    expect(snap.email).toBe("user@example.com");
    expect(snap.usedCount).toBe(0);
    expect(snap.limitCount).toBe(10000);
    expect(snap.subscriptionTitle).toBe("KIRO POWER");
    expect(calls.some((u) => u.includes("management.us-east-1"))).toBe(true);
  });
});

describe("loginWithApiKey user fetch", () => {
  it("populates email, label, and usage from getUsageLimits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            usageBreakdownList: [
              { currentUsage: 12, usageLimit: 10000 },
            ],
            userInfo: { email: "power@example.com" },
            subscriptionInfo: { subscriptionTitle: "KIRO POWER" },
          }),
          { status: 200 },
        ),
      ),
    );

    const account = await loginWithApiKey(`ksk_${"b".repeat(24)}`, "eu-central-1");
    expect(account.email).toBe("power@example.com");
    expect(account.label).toBe("Kiro API · KIRO POWER");
    expect(account.usedCount).toBe(12);
    expect(account.limitCount).toBe(10000);
    expect(account.region).toBe("eu-central-1");
  });
});
