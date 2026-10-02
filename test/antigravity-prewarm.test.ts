import { describe, expect, it, vi } from "vitest";
import { prewarmAntigravityAccounts } from "../lib/providers/antigravity/auth/prewarm.js";

describe("antigravity background pre-warmer", () => {
  it("only pre-refreshes accounts that are near-expiry or expired", async () => {
    const now = Date.now();

    const mockAccounts = [
      {
        accountId: "fresh-acc",
        email: "fresh@example.com",
        provider: "antigravity",
        enabled: true,
        subscriptionStatus: "active",
        refreshToken: "rt_fresh",
        expiresAt: now + 30 * 60 * 1000, // 30 minutes left -> fresh
      },
      {
        accountId: "near-expiry-acc",
        email: "near@example.com",
        provider: "antigravity",
        enabled: true,
        subscriptionStatus: "active",
        refreshToken: "rt_near",
        expiresAt: now + 2 * 60 * 1000, // 2 minutes left -> within 5min buffer -> refresh!
      },
      {
        accountId: "expired-acc",
        email: "expired@example.com",
        provider: "antigravity",
        enabled: true,
        subscriptionStatus: "active",
        refreshToken: "rt_expired",
        expiresAt: now - 60 * 1000, // expired 1 min ago -> refresh!
      },
      {
        accountId: "disabled-acc",
        email: "disabled@example.com",
        provider: "antigravity",
        enabled: false,
        subscriptionStatus: "active",
        refreshToken: "rt_disabled",
        expiresAt: now - 60 * 1000,
      },
      {
        accountId: "dead-acc",
        email: "dead@example.com",
        provider: "antigravity",
        enabled: true,
        subscriptionStatus: "dead",
        refreshToken: "rt_dead",
        expiresAt: now - 60 * 1000,
      },
    ];

    const refreshedAccounts: string[] = [];

    const mockManager = {
      list: vi.fn().mockReturnValue(mockAccounts),
      ensureFreshToken: vi.fn().mockImplementation(async (_provider, accountId) => {
        refreshedAccounts.push(accountId);
        return { accessToken: "new-access-token" };
      }),
      markDeadCandidate: vi.fn(),
    };

    await prewarmAntigravityAccounts(mockManager as any);

    expect(mockManager.list).toHaveBeenCalledWith("antigravity");
    expect(refreshedAccounts).toEqual(["near-expiry-acc", "expired-acc"]);
    expect(mockManager.ensureFreshToken).toHaveBeenCalledTimes(2);
    expect(mockManager.ensureFreshToken).toHaveBeenCalledWith("antigravity", "near-expiry-acc");
    expect(mockManager.ensureFreshToken).toHaveBeenCalledWith("antigravity", "expired-acc");
  });

  it("marks account dead candidate if refresh returns invalid_grant", async () => {
    const now = Date.now();
    const mockAccounts = [
      {
        accountId: "invalid-grant-acc",
        email: "invalid@example.com",
        provider: "antigravity",
        enabled: true,
        subscriptionStatus: "active",
        refreshToken: "rt_revoked",
        expiresAt: now - 1000,
      },
    ];

    const mockManager = {
      list: vi.fn().mockReturnValue(mockAccounts),
      ensureFreshToken: vi.fn().mockRejectedValue(new Error("OAuth failed: invalid_grant")),
      markDeadCandidate: vi.fn().mockResolvedValue(undefined),
    };

    await prewarmAntigravityAccounts(mockManager as any);

    expect(mockManager.markDeadCandidate).toHaveBeenCalledWith("antigravity", "invalid-grant-acc");
  });
});
