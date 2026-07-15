import { describe, expect, it } from "vitest";

import { resolveAccount, shortId } from "../lib/tools/resolve.js";
import type { AccountMetadata } from "../lib/core/schemas.js";

function acct(id: string): AccountMetadata {
  return {
    provider: "xai",
    accountId: id,
    tags: [],
    refreshToken: `rt-${id}`,
    enabled: true,
    priority: 0,
    addedAt: 0,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "unknown",
    flaggedForRemoval: false,
    entitlementBlocked: false,
  };
}

const pool = [acct("alpha-123"), acct("alpha-999"), acct("beta-000")];

describe("resolveAccount (port from xai/codex resolve.test.ts)", () => {
  it("resolves a valid 0-based index", () => {
    expect(resolveAccount(pool, { index: 2 }).accountId).toBe("beta-000");
  });

  it("throws on an out-of-range index", () => {
    expect(() => resolveAccount(pool, { index: 5 })).toThrow(/out of range/);
    expect(() => resolveAccount(pool, { index: -1 })).toThrow(/out of range/);
  });

  it("throws on a non-integer index", () => {
    expect(() => resolveAccount(pool, { index: 1.5 })).toThrow(/out of range/);
  });

  it("resolves an exact id", () => {
    expect(resolveAccount(pool, { id: "beta-000" }).accountId).toBe("beta-000");
  });

  it("resolves a unique prefix", () => {
    expect(resolveAccount(pool, { id: "beta" }).accountId).toBe("beta-000");
  });

  it("prefers an exact match over a prefix collision", () => {
    // "alpha-123" is an exact id even though it is also a prefix of itself.
    expect(resolveAccount(pool, { id: "alpha-123" }).accountId).toBe(
      "alpha-123",
    );
  });

  it("throws on an ambiguous prefix", () => {
    expect(() => resolveAccount(pool, { id: "alpha" })).toThrow(/ambiguous/);
  });

  it("throws when the id matches nothing", () => {
    expect(() => resolveAccount(pool, { id: "zzz" })).toThrow(/no account/);
  });

  it("throws when neither index nor id is provided", () => {
    expect(() => resolveAccount(pool, {})).toThrow(/either/);
  });

  it("index takes priority over id", () => {
    expect(resolveAccount(pool, { index: 0, id: "beta-000" }).accountId).toBe(
      "alpha-123",
    );
  });
});

describe("shortId", () => {
  it("passes short ids through unchanged", () => {
    expect(shortId("abc")).toBe("abc");
  });

  it("truncates long ids with an ellipsis", () => {
    expect(shortId("0123456789abcdefghij")).toBe("0123456789ab…");
  });
});
