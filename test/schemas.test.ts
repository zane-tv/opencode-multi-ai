import { describe, expect, it } from "vitest";
import {
  AccountMetadataSchema,
  AccountStorageSchema,
  LegacyCodexAccountStorageSchema,
  LegacyXaiAccountStorageSchema,
} from "../lib/core/schemas.js";

const baseShared = {
  accountId: "acc-1",
  refreshToken: "rt-secret",
  addedAt: 1_700_000_000_000,
};

function makeXaiAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...baseShared,
    accountId: "xai-1",
    provider: "xai",
    planTier: 2,
    planName: "SuperGrok",
    billingRemainingPercent: 42,
    lastCostInUsdTicks: 1e9,
    ...overrides,
  };
}

function makeCodexAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...baseShared,
    accountId: "codex-1",
    provider: "codex",
    organizationId: "org-abc",
    planType: "plus",
    primaryUsedPercent: 12,
    primaryWindowMinutes: 180,
    secondaryUsedPercent: 5,
    activeLimit: "primary",
    usageObservedAt: 1_700_000_100_000,
    ...overrides,
  };
}

describe("AccountMetadataSchema (v2 discriminated)", () => {
  it("parses a valid xai account with xai-only fields", () => {
    const parsed = AccountMetadataSchema.parse(makeXaiAccount());
    expect(parsed.provider).toBe("xai");
    if (parsed.provider === "xai") {
      expect(parsed.planTier).toBe(2);
      expect(parsed.billingRemainingPercent).toBe(42);
    }
  });

  it("parses a valid codex account with codex-only fields", () => {
    const parsed = AccountMetadataSchema.parse(makeCodexAccount());
    expect(parsed.provider).toBe("codex");
    if (parsed.provider === "codex") {
      expect(parsed.planType).toBe("plus");
      expect(parsed.primaryUsedPercent).toBe(12);
      expect(parsed.organizationId).toBe("org-abc");
    }
  });

  it("rejects a codex account carrying xai-only planTier", () => {
    const bad = makeCodexAccount({ planTier: 3 });
    const result = AccountMetadataSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an xai account carrying codex-only primaryUsedPercent", () => {
    const bad = makeXaiAccount({ primaryUsedPercent: 50 });
    const result = AccountMetadataSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a providerless account in v2", () => {
    const result = AccountMetadataSchema.safeParse({
      ...baseShared,
      // no provider
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown provider literal", () => {
    const result = AccountMetadataSchema.safeParse({
      ...baseShared,
      provider: "openai",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty refreshToken", () => {
    const result = AccountMetadataSchema.safeParse(
      makeXaiAccount({ refreshToken: "" }),
    );
    expect(result.success).toBe(false);
  });
});

describe("AccountStorageSchema (v2 sticky map)", () => {
  it("parses a mixed xai+codex v2 document and round-trips sticky", () => {
    const doc = {
      version: 2 as const,
      accounts: [makeXaiAccount(), makeCodexAccount()],
      sticky: {
        xai: "xai-1",
        codex: "codex-1",
      },
    };

    const parsed = AccountStorageSchema.parse(doc);
    expect(parsed.version).toBe(2);
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts.map((a) => a.provider).sort()).toEqual([
      "codex",
      "xai",
    ]);
    expect(parsed.sticky).toEqual({ xai: "xai-1", codex: "codex-1" });

    // re-parse the output (defaults applied) to prove round-trip
    const again = AccountStorageSchema.parse(parsed);
    expect(again.sticky.xai).toBe("xai-1");
    expect(again.sticky.codex).toBe("codex-1");
  });

  it("defaults sticky to {} and accounts to [] when omitted", () => {
    const parsed = AccountStorageSchema.parse({ version: 2 });
    expect(parsed.accounts).toEqual([]);
    expect(parsed.sticky).toEqual({});
  });

  it("rejects unknown version", () => {
    const result = AccountStorageSchema.safeParse({
      version: 1,
      accounts: [],
      sticky: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects version 3", () => {
    const result = AccountStorageSchema.safeParse({
      version: 3,
      accounts: [],
      sticky: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects a mixed doc when one account is providerless", () => {
    const result = AccountStorageSchema.safeParse({
      version: 2,
      accounts: [
        makeXaiAccount(),
        { accountId: "orphan", refreshToken: "rt", addedAt: 1 },
      ],
      sticky: {},
    });
    expect(result.success).toBe(false);
  });

  it("does not accept a shared activeIndex field as sticky", () => {
    // activeIndex is legacy-only; sticky must be the map form
    const parsed = AccountStorageSchema.parse({
      version: 2,
      accounts: [makeXaiAccount()],
      sticky: { xai: "xai-1" },
      activeIndex: 0,
    });
    // unknown keys are stripped by default object; sticky remains the map
    expect(parsed.sticky).toEqual({ xai: "xai-1" });
    expect("activeIndex" in parsed).toBe(false);
  });
});

describe("LegacyXaiAccountStorageSchema (v1)", () => {
  it("parses a sample without provider field", () => {
    const doc = {
      version: 1 as const,
      accounts: [
        {
          accountId: "legacy-xai",
          refreshToken: "rt-xai",
          addedAt: 1_700_000_000_000,
          planTier: 1,
          planName: "Free",
          billingMonthlyUsedPercent: 10,
          lastCostInUsdTicks: 100,
        },
      ],
      activeIndex: 0,
    };

    const parsed = LegacyXaiAccountStorageSchema.parse(doc);
    expect(parsed.version).toBe(1);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]?.accountId).toBe("legacy-xai");
    expect(parsed.accounts[0]?.planTier).toBe(1);
    expect(parsed.activeIndex).toBe(0);
    // no provider on legacy shape
    expect(
      (parsed.accounts[0] as { provider?: string }).provider,
    ).toBeUndefined();
  });
});

describe("LegacyCodexAccountStorageSchema (v1)", () => {
  it("parses a sample without provider field", () => {
    const doc = {
      version: 1 as const,
      accounts: [
        {
          accountId: "legacy-codex",
          refreshToken: "rt-codex",
          addedAt: 1_700_000_000_000,
          organizationId: "org-1",
          planType: "team",
          primaryUsedPercent: 33,
          secondaryUsedPercent: 8,
          activeLimit: "secondary",
        },
      ],
      activeIndex: 0,
    };

    const parsed = LegacyCodexAccountStorageSchema.parse(doc);
    expect(parsed.version).toBe(1);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]?.accountId).toBe("legacy-codex");
    expect(parsed.accounts[0]?.planType).toBe("team");
    expect(parsed.accounts[0]?.primaryUsedPercent).toBe(33);
    expect(parsed.activeIndex).toBe(0);
    expect(
      (parsed.accounts[0] as { provider?: string }).provider,
    ).toBeUndefined();
  });
});
