import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountManager } from "../lib/core/accounts.js";
import type { AccountStorageV2 } from "../lib/core/schemas.js";
import { loadAccounts } from "../lib/core/storage.js";

const NOW = 1_700_000_000_000;

const V2_STORAGE: AccountStorageV2 = {
  version: 2,
  accounts: [
    {
      provider: "xai",
      accountId: "xai-account",
      email: "xai@example.com",
      label: "Primary xAI",
      tags: ["paid", "work"],
      note: "keep every xAI field",
      refreshToken: "xai-refresh-token",
      accessToken: "xai-access-token",
      expiresAt: NOW + 60_000,
      oauthScope: "openid profile",
      enabled: true,
      priority: 20,
      addedAt: NOW,
      lastUsed: NOW + 1,
      lastSwitchReason: "manual",
      quotaResetAt: NOW + 2,
      coolingDownUntil: NOW + 3,
      cooldownReason: "rate-limit",
      subscriptionStatus: "active",
      subscriptionCheckedAt: NOW + 4,
      flaggedForRemoval: false,
      entitlementBlocked: false,
      rateLimitLimitRequests: 100,
      rateLimitRemainingRequests: 80,
      rateLimitLimitTokens: 10_000,
      rateLimitRemainingTokens: 8_000,
      rateLimitObservedAt: NOW + 5,
      lastCostInUsdTicks: 42,
      billingMonthlyUsedPercent: 12,
      billingRemainingPercent: 88,
      billingResetsAt: NOW + 6,
      billingObservedAt: NOW + 7,
      planTier: 2,
      planName: "SuperGrok",
      planMonthlyLimit: 1_000,
      planUsed: 120,
      planPeriodStartMs: NOW - 1_000,
      planPeriodEndMs: NOW + 1_000,
      planObservedAt: NOW + 8,
    },
    {
      provider: "codex",
      accountId: "codex-account",
      email: "codex@example.com",
      label: "Primary Codex",
      tags: ["team"],
      note: "keep every Codex field",
      refreshToken: "codex-refresh-token",
      accessToken: "codex-access-token",
      expiresAt: NOW + 120_000,
      oauthScope: "openid email",
      enabled: true,
      priority: 10,
      addedAt: NOW + 10,
      lastUsed: NOW + 11,
      lastSwitchReason: "rotation",
      quotaResetAt: NOW + 12,
      coolingDownUntil: NOW + 13,
      cooldownReason: "network-error",
      subscriptionStatus: "unknown",
      subscriptionCheckedAt: NOW + 14,
      flaggedForRemoval: true,
      entitlementBlocked: false,
      rateLimitLimitRequests: 200,
      rateLimitRemainingRequests: 150,
      rateLimitLimitTokens: 20_000,
      rateLimitRemainingTokens: 15_000,
      rateLimitObservedAt: NOW + 15,
      organizationId: "org-example",
      planType: "team",
      primaryUsedPercent: 25,
      primaryWindowMinutes: 180,
      primaryResetAt: NOW + 16,
      secondaryUsedPercent: 40,
      secondaryWindowMinutes: 10_080,
      secondaryResetAt: NOW + 17,
      activeLimit: "primary",
      usageObservedAt: NOW + 18,
    },
  ],
  sticky: {
    xai: "xai-account",
    codex: "codex-account",
  },
};

function storageBytes(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

describe("account storage v2 to v3 migration", () => {
  let fixtureDir: string;
  let storagePath: string;

  beforeEach(async () => {
    fixtureDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `multi-ai-storage-v3-${process.pid}-`),
    );
    storagePath = path.join(fixtureDir, "multi-ai-accounts.json");
  });

  afterEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it("preserves mixed provider accounts and sticky pointers when AccountManager loads v2", async () => {
    // Given
    await fs.writeFile(storagePath, storageBytes(V2_STORAGE), { mode: 0o600 });
    const manager = new AccountManager(storagePath);

    // When
    await manager.load();

    // Then
    const migrated = await loadAccounts(storagePath);
    expect(migrated.version).toBe(3);
    expect(migrated.accounts).toEqual(V2_STORAGE.accounts);
    expect(migrated.sticky).toEqual({
      xai: "xai-account",
      codex: "codex-account",
    });
    expect(migrated.sticky).not.toHaveProperty("kiro");
    expect(manager.listAll()).toEqual(V2_STORAGE.accounts);
  });

  it("writes the v3 file and exact v2 backup with mode 0600", async () => {
    // Given
    const originalBytes = storageBytes(V2_STORAGE);
    await fs.writeFile(storagePath, originalBytes, { mode: 0o644 });

    // When
    await loadAccounts(storagePath);

    // Then
    const backupPath = `${storagePath}.v2.bak`;
    expect(await fs.readFile(backupPath, "utf8")).toBe(originalBytes);
    expect((await fs.stat(storagePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  it("does not rewrite v3 or churn the backup on a second load", async () => {
    // Given
    await fs.writeFile(storagePath, storageBytes(V2_STORAGE), { mode: 0o600 });
    const first = await loadAccounts(storagePath);
    const backupPath = `${storagePath}.v2.bak`;
    const firstStorageBytes = await fs.readFile(storagePath, "utf8");
    const firstStorageStat = await fs.stat(storagePath);
    const firstBackupBytes = await fs.readFile(backupPath, "utf8");
    const firstBackupStat = await fs.stat(backupPath);

    // When
    const second = await loadAccounts(storagePath);

    // Then
    const secondStorageStat = await fs.stat(storagePath);
    const secondBackupStat = await fs.stat(backupPath);
    expect(second).toEqual(first);
    expect(await fs.readFile(storagePath, "utf8")).toBe(firstStorageBytes);
    expect(secondStorageStat.ino).toBe(firstStorageStat.ino);
    expect(secondStorageStat.mtimeMs).toBe(firstStorageStat.mtimeMs);
    expect(await fs.readFile(backupPath, "utf8")).toBe(firstBackupBytes);
    expect(secondBackupStat.ino).toBe(firstBackupStat.ino);
    expect(secondBackupStat.mtimeMs).toBe(firstBackupStat.mtimeMs);
  });

  it("leaves an unknown-version file byte-identical and rejects it", async () => {
    // Given
    const originalBytes = '{\n  "version": 99,\n  "sentinel": "keep-me"\n}\n';
    await fs.writeFile(storagePath, originalBytes, { mode: 0o640 });

    // When / Then
    await expect(loadAccounts(storagePath)).rejects.toThrow(/failed validation/i);
    expect(await fs.readFile(storagePath, "utf8")).toBe(originalBytes);
    await expect(fs.stat(`${storagePath}.v2.bak`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves a legacy v1 file byte-identical and rejects it", async () => {
    // Given
    const originalBytes = storageBytes({
      version: 1,
      accounts: [
        {
          accountId: "legacy-xai",
          refreshToken: "legacy-refresh-token",
          addedAt: NOW,
        },
      ],
      activeIndex: 0,
    });
    await fs.writeFile(storagePath, originalBytes, { mode: 0o640 });

    // When / Then
    await expect(loadAccounts(storagePath)).rejects.toThrow(/failed validation/i);
    expect(await fs.readFile(storagePath, "utf8")).toBe(originalBytes);
    await expect(fs.stat(`${storagePath}.v2.bak`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
