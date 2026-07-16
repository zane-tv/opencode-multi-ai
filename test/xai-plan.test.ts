import { describe, expect, it } from "vitest";
import {
  deriveRemainingFromPlanUsage,
  inferPlanNameFromLimit,
  planNameFromTier,
  formatPlanLimit,
  resolveXaiRemainingPercent,
} from "../lib/providers/xai/request/plan.js";

describe("plan labels", () => {
  it("maps JWT tier 5 as Heavy (observed SuperGrok Heavy OAuth)", () => {
    expect(planNameFromTier(5)).toBe("SuperGrok Heavy");
    expect(planNameFromTier(2)).toBe("SuperGrok Lite");
    expect(planNameFromTier(3)).toBe("SuperGrok");
  });

  it("uses monthly limit and never downgrades Heavy", () => {
    expect(inferPlanNameFromLimit(150_000)).toBe("SuperGrok Heavy");
    expect(planNameFromTier(5, 150_000)).toBe("SuperGrok Heavy");
    // limit Heavy wins over a lower tier label
    expect(planNameFromTier(3, 150_000)).toBe("SuperGrok Heavy");
    expect(inferPlanNameFromLimit(40_000)).toBe("SuperGrok Lite");
    expect(inferPlanNameFromLimit(100_000)).toBe("SuperGrok");
  });

  it("formats limits compactly", () => {
    expect(formatPlanLimit(150000)).toBe("150k");
    expect(formatPlanLimit(5241)).toBe("5k");
  });

  it("derives remaining % from absolute plan usage", () => {
    const d = deriveRemainingFromPlanUsage(1104, 15000);
    expect(d).toBeDefined();
    expect(d!.remainingPercent).toBe(93);
    expect(d!.monthlyUsedPercent).toBeCloseTo(7.36, 1);
    expect(deriveRemainingFromPlanUsage(undefined, 15000)).toBeUndefined();
  });

  it("resolveXaiRemainingPercent prefers plan absolute over grpc %", () => {
    expect(
      resolveXaiRemainingPercent({
        planUsed: 61012,
        planMonthlyLimit: 150000,
        billingRemainingPercent: 12,
      }),
    ).toBe(59);
    expect(
      resolveXaiRemainingPercent({
        planUsed: 0,
        planMonthlyLimit: 150000,
        billingRemainingPercent: 59,
      }),
    ).toBe(100);
    expect(
      resolveXaiRemainingPercent({
        billingRemainingPercent: 72,
      }),
    ).toBe(72);
  });
});
