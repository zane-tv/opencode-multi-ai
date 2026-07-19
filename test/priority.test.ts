import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountManager } from "../lib/core/accounts.js";
import type {
  AccountMetadata,
  AccountStorage,
  ProviderKind,
} from "../lib/core/schemas.js";
import { saveAccounts } from "../lib/core/storage.js";

const PROVIDER_CASES = [
  { provider: "xai", source: "opencode-mutil-xai" },
  { provider: "codex", source: "opencode-multi-codex" },
] as const;

function tmpStorePath(provider: ProviderKind): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-${provider}-priority-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

function makeAccount(
  provider: ProviderKind,
  id: string,
  priority: number,
  addedAt: number,
): AccountMetadata {
  const common = {
    accountId: id,
    tags: [],
    refreshToken: `rt-${id}`,
    enabled: true,
    priority,
    addedAt,
    lastUsed: 0,
    lastSwitchReason: "initial" as const,
    subscriptionStatus: "unknown" as const,
    flaggedForRemoval: false,
    entitlementBlocked: false,
  };
  return provider === "xai"
    ? { provider: "xai", ...common }
    : { provider: "codex", ...common };
}

function stickyFor(
  provider: ProviderKind,
  accountId: string,
): AccountStorage["sticky"] {
  return provider === "xai" ? { xai: accountId } : { codex: accountId };
}

async function cleanStore(storePath: string): Promise<void> {
  const dir = path.dirname(storePath);
  const base = path.basename(storePath);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(base))
      .map((entry) =>
        fs.rm(path.join(dir, entry), { force: true }).catch(() => undefined),
      ),
  );
}

describe.each(PROVIDER_CASES)(
  "$source priority port ($provider namespace)",
  ({ provider }) => {
    let storePath: string;

    beforeEach(() => {
      storePath = tmpStorePath(provider);
    });

    afterEach(async () => {
      await cleanStore(storePath);
    });

    it("sorts higher priority first and move up/down works", async () => {
      const storage: AccountStorage = {
        version: 3,
        accounts: [
          makeAccount(provider, "a", 0, 1),
          makeAccount(provider, "b", 0, 2),
          makeAccount(provider, "c", 5, 3),
        ],
        sticky: stickyFor(provider, "a"),
      };
      await saveAccounts(storage, storePath);

      const manager = new AccountManager(storePath);
      await manager.load();
      expect(manager.list(provider).map((account) => account.accountId)).toEqual([
        "c",
        "a",
        "b",
      ]);

      await manager.movePriority(provider, "a", "up");
      expect(manager.list(provider).map((account) => account.accountId)).toEqual([
        "a",
        "c",
        "b",
      ]);

      await manager.movePriority(provider, "a", "down");
      expect(manager.list(provider).map((account) => account.accountId)).toEqual([
        "c",
        "a",
        "b",
      ]);

      await manager.moveToFront(provider, "b");
      expect(manager.list(provider).map((account) => account.accountId)).toEqual([
        "b",
        "c",
        "a",
      ]);
    });

    it("move up/down swaps adjacent list rows and renumbers priorities", async () => {
      const storage: AccountStorage = {
        version: 3,
        accounts: [
          makeAccount(provider, "a", 3, 1),
          makeAccount(provider, "b", 2, 2),
          makeAccount(provider, "c", 1, 3),
        ],
        sticky: stickyFor(provider, "a"),
      };
      await saveAccounts(storage, storePath);
      const manager = new AccountManager(storePath);
      await manager.load();

      await manager.movePriority(provider, "c", "up");
      expect(manager.list(provider).map((a) => a.accountId)).toEqual([
        "a",
        "c",
        "b",
      ]);
      expect(manager.list(provider).map((a) => a.priority)).toEqual([2, 1, 0]);

      await manager.movePriority(provider, "c", "up");
      expect(manager.list(provider).map((a) => a.accountId)).toEqual([
        "c",
        "a",
        "b",
      ]);
      expect(manager.list(provider).map((a) => a.priority)).toEqual([2, 1, 0]);
    });

    it("does not swap across health bands (quota stays below ready)", async () => {
      const now = Date.now();
      const readyA = makeAccount(provider, "ready", 5, 1);
      const readyB = makeAccount(provider, "ready2", 4, 2);
      const quota = makeAccount(provider, "quota", 3, 3);
      quota.quotaResetAt = now + 60_000;
      const storage: AccountStorage = {
        version: 3,
        accounts: [readyA, readyB, quota],
        sticky: stickyFor(provider, "ready"),
      };
      await saveAccounts(storage, storePath);
      const manager = new AccountManager(storePath);
      await manager.load();

      expect(manager.list(provider).map((a) => a.accountId)).toEqual([
        "ready",
        "ready2",
        "quota",
      ]);

      await manager.movePriority(provider, "quota", "up");
      expect(manager.list(provider).map((a) => a.accountId)).toEqual([
        "ready",
        "ready2",
        "quota",
      ]);

      await manager.moveToFront(provider, "quota");
      expect(manager.list(provider).map((a) => a.accountId)).toEqual([
        "ready",
        "ready2",
        "quota",
      ]);
    });

    it("selectAccount prefers sticky then the first priority-sorted account", async () => {
      const storage: AccountStorage = {
        version: 3,
        accounts: [
          makeAccount(provider, "low", 0, 1),
          makeAccount(provider, "high", 10, 2),
        ],
        sticky: stickyFor(provider, "low"),
      };
      await saveAccounts(storage, storePath);
      const manager = new AccountManager(storePath);
      await manager.load();

      const sticky = manager.selectAccount(provider, new Set());
      expect(sticky?.accountId).toBe("low");

      await manager.setEnabled(provider, "low", false);
      const next = manager.selectAccount(provider, new Set());
      expect(next?.accountId).toBe("high");
      expect(manager.sticky(provider)).toBe("high");
    });

    it("quota exhaustion demotes an account so rotation prefers others", async () => {
      const storage: AccountStorage = {
        version: 3,
        accounts: [
          makeAccount(provider, "a", 10, 1),
          makeAccount(provider, "b", 5, 2),
          makeAccount(provider, "c", 1, 3),
        ],
        sticky: stickyFor(provider, "a"),
      };
      await saveAccounts(storage, storePath);
      const manager = new AccountManager(storePath);
      await manager.load();

      await manager.markQuotaExhausted(
        provider,
        "a",
        Date.now() + 60_000,
      );
      expect(manager.list(provider).map((account) => account.accountId)).toEqual([
        "b",
        "c",
        "a",
      ]);
      expect(manager.selectAccount(provider, new Set())?.accountId).toBe("b");
    });

    it("dead accounts sink below ready accounts and cleanDead removes them", async () => {
      const storage: AccountStorage = {
        version: 3,
        accounts: [
          makeAccount(provider, "alive", 10, 1),
          makeAccount(provider, "dead-high", 100, 2),
          makeAccount(provider, "alive2", 5, 3),
        ],
        sticky: stickyFor(provider, "dead-high"),
      };
      await saveAccounts(storage, storePath);
      const manager = new AccountManager(storePath);
      await manager.load();

      await manager.markDeadCandidate(provider, "dead-high");
      expect(manager.list(provider).map((a) => a.accountId)).toEqual([
        "alive",
        "alive2",
        "dead-high",
      ]);
      expect(manager.selectAccount(provider, new Set())?.accountId).toBe(
        "alive",
      );

      const dry = manager.deadAccounts(provider);
      expect(dry.map((a) => a.accountId)).toEqual(["dead-high"]);
      const { removed } = await manager.cleanDeadAccounts(provider);
      expect(removed).toEqual(["dead-high"]);
      expect(manager.list(provider).map((a) => a.accountId)).toEqual([
        "alive",
        "alive2",
      ]);
    });
  },
);
