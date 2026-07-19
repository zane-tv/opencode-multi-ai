import { describe, expect, it } from "vitest";

import type { AccountStorage } from "../lib/core/schemas.js";
import {
  buildActiveQuotaRows,
  formatActiveQuotaLines,
  meterBar,
  meterTone,
} from "../lib/sidebar/active-quota.js";

const NOW = 1_700_000_000_000;

function storage(partial: Partial<AccountStorage>): AccountStorage {
  return {
    version: 3,
    accounts: [],
    sticky: {},
    ...partial,
  };
}

describe("meterBar / meterTone", () => {
  it("renders filled and empty cells", () => {
    expect(meterBar(100, 10)).toBe("██████████");
    expect(meterBar(0, 10)).toBe("░░░░░░░░░░");
    expect(meterBar(undefined, 10)).toMatch(/—+/);
  });

  it("maps remaining % to tone bands", () => {
    expect(meterTone(90)).toBe("ok");
    expect(meterTone(50)).toBe("warn");
    expect(meterTone(10)).toBe("bad");
    expect(meterTone(undefined)).toBe("muted");
  });
});

describe("buildActiveQuotaRows", () => {
  it("returns empty when pool is empty", () => {
    expect(buildActiveQuotaRows(storage({}), NOW)).toEqual([]);
  });

  it("prefers sticky account and formats xAI plan absolute remaining", () => {
    const rows = buildActiveQuotaRows(
      storage({
        sticky: { xai: "xai-heavy" },
        accounts: [
          {
            provider: "xai",
            accountId: "xai-other",
            refreshToken: "r",
            accessToken: "a",
            expiresAt: NOW + 3600_000,
            enabled: true,
            priority: 1,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            planName: "SuperGrok Lite",
            planUsed: 0,
            planMonthlyLimit: 15_000,
            billingRemainingPercent: 100,
          },
          {
            provider: "xai",
            accountId: "xai-heavy",
            refreshToken: "r",
            accessToken: "a",
            expiresAt: NOW + 3600_000,
            enabled: true,
            priority: 10,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "Heavy",
            planName: "SuperGrok Heavy",
            planUsed: 0,
            planMonthlyLimit: 150_000,
            planPeriodEndMs: NOW + 12 * 24 * 60 * 60 * 1000,
            billingRemainingPercent: 27,
            billingMonthlyUsedPercent: 73,
            billingPeriodType: "weekly",
            billingResetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
          },
        ],
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("xai");
    expect(rows[0]!.displayName).toBe("Heavy");
    expect(rows[0]!.remainingPercent).toBe(27);
    expect(rows[0]!.planLabel).toBe("SuperGrok Heavy");
    expect(rows[0]!.detail).toBeUndefined();
  });

  it("renders the sticky Kiro account with count-based remaining quota", () => {
    const rows = buildActiveQuotaRows(
      storage({
        sticky: { kiro: "kiro-work" },
        accounts: [
          {
            provider: "kiro",
            accountId: "kiro-work",
            refreshToken: "desktop-refresh-token",
            authMethod: "desktop",
            region: "us-east-1",
            enabled: true,
            priority: 1,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "Kiro Work",
            usedCount: 25,
            limitCount: 100,
          },
        ],
      }),
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("kiro");
    expect(rows[0]?.displayName).toBe("Kiro Work");
    expect(rows[0]?.remainingPercent).toBe(75);
  });

  it.each([0, undefined])(
    "does not calculate a Kiro percentage when limitCount is %s",
    (limitCount) => {
      const rows = buildActiveQuotaRows(
        storage({
          sticky: { kiro: "kiro-work" },
          accounts: [
            {
              provider: "kiro",
              accountId: "kiro-work",
              refreshToken: "desktop-refresh-token",
              authMethod: "desktop",
              region: "us-east-1",
              enabled: true,
              priority: 1,
              addedAt: NOW,
              lastUsed: 0,
              lastSwitchReason: "initial",
              subscriptionStatus: "active",
              flaggedForRemoval: false,
              entitlementBlocked: false,
              tags: [],
              usedCount: 25,
              limitCount,
            },
          ],
        }),
        NOW,
      );

      expect(rows[0]?.remainingPercent).toBeUndefined();
      expect(rows[0]?.meter).not.toMatch(/NaN|Infinity/);
    },
  );

  it("lists Codex, xAI, then Kiro when all three are sticky", () => {
    const rows = buildActiveQuotaRows(
      storage({
        sticky: { xai: "x1", codex: "c1", kiro: "k1" },
        accounts: [
          {
            provider: "xai",
            accountId: "x1",
            refreshToken: "r",
            accessToken: "a",
            expiresAt: NOW + 3600_000,
            enabled: true,
            priority: 1,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "g",
            billingRemainingPercent: 80,
          },
          {
            provider: "codex",
            accountId: "c1",
            refreshToken: "r",
            accessToken: "a",
            expiresAt: NOW + 3600_000,
            enabled: true,
            priority: 1,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "c",
            organizationId: "org",
            planType: "plus",
            primaryUsedPercent: 40,
            primaryWindowMinutes: 180,
          },
          {
            provider: "kiro",
            accountId: "k1",
            refreshToken: "desktop-refresh-token",
            authMethod: "desktop",
            region: "us-east-1",
            enabled: true,
            priority: 1,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "k",
            usedCount: 10,
            limitCount: 100,
          },
        ],
      }),
      NOW,
    );
    // No session: sort by remaining % DESC (kiro 90 > xai 80 > codex 60)
    expect(rows.map((r) => r.provider)).toEqual(["kiro", "xai", "codex"]);
    expect(rows[0]!.remainingPercent).toBe(90);
    expect(rows[2]!.planLabel).toBe("plus");
    expect(rows[2]!.remainingPercent).toBe(60);
  });

  it("falls back to most-recently-used when sticky is dead/missing", () => {
    const rows = buildActiveQuotaRows(
      storage({
        sticky: { xai: "dead-id" },
        accounts: [
          {
            provider: "xai",
            accountId: "old",
            refreshToken: "r",
            accessToken: "a",
            expiresAt: NOW + 3600_000,
            enabled: true,
            priority: 1,
            addedAt: NOW,
            lastUsed: NOW - 10_000,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "old",
            billingRemainingPercent: 10,
          },
          {
            provider: "xai",
            accountId: "fresh",
            refreshToken: "r",
            accessToken: "a",
            expiresAt: NOW + 3600_000,
            enabled: true,
            priority: 0,
            addedAt: NOW,
            lastUsed: NOW,
            lastSwitchReason: "rotation",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "fresh",
            billingRemainingPercent: 90,
          },
        ],
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe("fresh");
    expect(rows[0]!.accountId).toBe("fresh");
  });

  it("skips exhausted sticky Codex and picks a ready account", () => {
    const rows = buildActiveQuotaRows(
      storage({
        sticky: { codex: "exhausted" },
        accounts: [
          {
            provider: "codex",
            accountId: "exhausted",
            refreshToken: "r",
            accessToken: "a",
            expiresAt: NOW + 3600_000,
            enabled: true,
            priority: 10,
            addedAt: NOW,
            lastUsed: NOW,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "buckler",
            organizationId: "org-e",
            planType: "plus",
            primaryUsedPercent: 100,
            primaryWindowMinutes: 10_080,
            secondaryWindowMinutes: 0,
          },
          {
            provider: "codex",
            accountId: "ready",
            refreshToken: "r",
            accessToken: "a",
            expiresAt: NOW + 3600_000,
            enabled: true,
            priority: 1,
            addedAt: NOW,
            lastUsed: NOW - 1000,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "bunts",
            organizationId: "org-r",
            planType: "plus",
            primaryUsedPercent: 10,
            primaryWindowMinutes: 10_080,
          },
        ],
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe("ready");
    expect(rows[0]!.displayName).toBe("bunts");
    expect(rows[0]!.remainingPercent).toBe(90);
  });

  it("skips entitlement-blocked sticky Kiro for ready MRU", () => {
    const rows = buildActiveQuotaRows(
      storage({
        sticky: { kiro: "api-blocked" },
        accounts: [
          {
            provider: "kiro",
            accountId: "api-blocked",
            refreshToken: "ksk_x",
            authMethod: "api-key",
            region: "eu-central-1",
            enabled: true,
            priority: 5,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: true,
            tags: [],
            label: "Kiro API · KIRO POWER",
            usedCount: 0,
            limitCount: 10_000,
          },
          {
            provider: "kiro",
            accountId: "rachel",
            refreshToken: "desktop-refresh-token",
            authMethod: "idc",
            region: "us-east-1",
            enabled: true,
            priority: 0,
            addedAt: NOW,
            lastUsed: NOW,
            lastSwitchReason: "rotation",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            email: "user.rachel.smith.32ony@example.com",
            usedCount: 1319,
            limitCount: 10_000,
          },
        ],
      }),
      NOW,
    );
    expect(rows[0]!.accountId).toBe("rachel");
    expect(rows[0]!.displayName).toContain("rachel");
  });

  it("marks and sorts the session provider first", () => {
    const rows = buildActiveQuotaRows(
      storage({
        sticky: { xai: "x1", kiro: "k1" },
        accounts: [
          {
            provider: "xai",
            accountId: "x1",
            refreshToken: "r",
            accessToken: "a",
            expiresAt: NOW + 3600_000,
            enabled: true,
            priority: 1,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "x",
            billingRemainingPercent: 50,
          },
          {
            provider: "kiro",
            accountId: "k1",
            refreshToken: "desktop-refresh-token",
            authMethod: "api-key",
            region: "eu-central-1",
            enabled: true,
            priority: 1,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
            tags: [],
            label: "k",
            usedCount: 0,
            limitCount: 100,
          },
        ],
      }),
      NOW,
      { sessionProviderID: "kiro-multi" },
    );
    expect(rows.map((r) => r.provider)).toEqual(["kiro", "xai"]);
    expect(rows[0]!.sessionActive).toBe(true);
    expect(rows[1]!.sessionActive).toBe(false);
  });
});

describe("formatActiveQuotaLines", () => {
  it("shows empty-pool help", () => {
    const lines = formatActiveQuotaLines([]);
    expect(lines[0]).toMatch(/No multi-ai/i);
  });

  it("prefixes sticky with star and session-active with bullet + ACTIVE", () => {
    const sticky = formatActiveQuotaLines([
      {
        provider: "codex",
        providerLabel: "Codex",
        displayName: "work",
        remainingPercent: 60,
        planLabel: "plus",
        meter: "██████░░░░",
        accountId: "c1",
      },
    ]);
    expect(sticky[0]).toMatch(/^★ Codex/);
    expect(sticky[0]).toContain("work");
    expect(sticky[1]).toMatch(/│.*│/);

    const session = formatActiveQuotaLines([
      {
        provider: "kiro",
        providerLabel: "Kiro",
        displayName: "api",
        remainingPercent: 100,
        meter: "██████████",
        accountId: "k1",
        sessionActive: true,
      },
    ]);
    expect(session[0]).toMatch(/^● Kiro/);
    expect(session[0]).toContain("ACTIVE");
  });
});
