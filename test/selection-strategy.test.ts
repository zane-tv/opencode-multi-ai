import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cycleSelectionStrategy,
  getSelectionStrategy,
  resetSelectionStrategyForTests,
  setSelectionStrategy,
} from "../lib/core/selection-strategy.js";
import {
  AccountManager,
  isRotationReady,
} from "../lib/core/accounts.js";
import type { AccountMetadata } from "../lib/core/schemas.js";

const tmp = path.join(
  os.tmpdir(),
  `multi-ai-sel-${process.pid}-${Date.now()}.json`,
);
const settingsTmp = path.join(
  os.tmpdir(),
  `multi-ai-settings-sel-${process.pid}-${Date.now()}.json`,
);

afterEach(() => {
  resetSelectionStrategyForTests();
  delete process.env.MULTI_AI_SELECTION_STRATEGY;
  delete process.env.MULTI_AI_SETTINGS_PATH;
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* */
  }
  try {
    fs.unlinkSync(settingsTmp);
  } catch {
    /* */
  }
});

function xaiAcc(
  id: string,
  pri: number,
  rem: number,
): Extract<AccountMetadata, { provider: "xai" }> {
  const now = Date.now();
  return {
    provider: "xai",
    accountId: id,
    refreshToken: "r-" + id,
    accessToken: "a-" + id,
    expiresAt: now + 3600_000,
    enabled: true,
    priority: pri,
    addedAt: now,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    tags: [],
    billingRemainingPercent: rem,
    billingMonthlyUsedPercent: 100 - rem,
    billingPeriodType: "weekly",
    billingResetsAt: now + 86400_000,
    billingPeriodEndMs: now + 86400_000,
  };
}

describe("selection strategy settings", () => {
  it("defaults sticky and cycles", () => {
    process.env.MULTI_AI_SETTINGS_PATH = settingsTmp;
    resetSelectionStrategyForTests();
    expect(getSelectionStrategy()).toBe("sticky");
    expect(cycleSelectionStrategy()).toBe("round-robin");
    expect(getSelectionStrategy()).toBe("round-robin");
    expect(cycleSelectionStrategy()).toBe("lowest-usage");
    expect(cycleSelectionStrategy()).toBe("sticky");
  });

  it("env overrides settings", () => {
    process.env.MULTI_AI_SETTINGS_PATH = settingsTmp;
    setSelectionStrategy("sticky", true);
    process.env.MULTI_AI_SELECTION_STRATEGY = "round-robin";
    resetSelectionStrategyForTests();
    expect(getSelectionStrategy()).toBe("round-robin");
  });
});

describe("round-robin selectAccount", () => {
  it("advances sticky to next ready account each call", async () => {
    process.env.MULTI_AI_SETTINGS_PATH = settingsTmp;
    setSelectionStrategy("round-robin", true);
    const mgr = new AccountManager(tmp);
    await mgr.load();
    // higher priority first in list
    await mgr.add(xaiAcc("a", 30, 50));
    await mgr.add(xaiAcc("b", 20, 50));
    await mgr.add(xaiAcc("c", 10, 50));
    // seed sticky at a
    await mgr.switchTo("xai", "a");
    expect(mgr.sticky("xai")).toBe("a");

    const attempted = new Set<string>();
    const first = mgr.selectAccount("xai", attempted, "round-robin");
    expect(first?.accountId).toBe("b");
    attempted.add(first!.accountId);

    const second = mgr.selectAccount("xai", attempted, "round-robin");
    expect(second?.accountId).toBe("c");
    attempted.add(second!.accountId);

    const third = mgr.selectAccount("xai", attempted, "round-robin");
    expect(third?.accountId).toBe("a");
  });

  it("skips not-ready accounts in round-robin", async () => {
    const mgr = new AccountManager(tmp);
    await mgr.load();
    const deadish = xaiAcc("dead", 30, 0);
    deadish.billingResetsAt = Date.now() - 1000;
    deadish.billingPeriodEndMs = Date.now() - 1000;
    await mgr.add(deadish);
    await mgr.add(xaiAcc("ok1", 20, 80));
    await mgr.add(xaiAcc("ok2", 10, 80));
    await mgr.switchTo("xai", "dead");
    // force sticky to dead even if not ready
    // switchTo may set quotaResetAt — clear sticky manually via select
    const next = mgr.selectAccount("xai", new Set(), "round-robin");
    expect(next?.accountId).toBe("ok1");
    expect(isRotationReady(deadish, Date.now())).toBe(false);
  });
});
