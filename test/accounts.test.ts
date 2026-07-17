import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccountManager,
  getAccountManager,
  resetAccountManager,
  type RefreshFn,
} from "../lib/core/accounts.js";
import type {
  AccountMetadata,
  AccountStorage,
  ProviderKind,
} from "../lib/core/schemas.js";
import { loadAccounts, saveAccounts } from "../lib/core/storage.js";

const HOUR = 3_600_000;

const PROVIDER_CASES = [
  { provider: "xai", source: "opencode-mutil-xai" },
  { provider: "codex", source: "opencode-multi-codex" },
] as const;

type TestedProviderKind = Exclude<ProviderKind, "kiro">;
type TestedAccount = Extract<AccountMetadata, { provider: TestedProviderKind }>;

type CommonAccountOverrides = Partial<
  Omit<AccountMetadata, "provider" | "accountId">
>;

function tmpStorePath(provider: ProviderKind): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-${provider}-accts-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

function makeAccount(
  provider: TestedProviderKind,
  id: string,
  overrides: CommonAccountOverrides = {},
): TestedAccount {
  const common = {
    accountId: id,
    tags: [],
    refreshToken: `rt-${id}`,
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial" as const,
    subscriptionStatus: "unknown" as const,
    flaggedForRemoval: false,
    entitlementBlocked: false,
    ...overrides,
  };
  return provider === "xai"
    ? { provider: "xai", ...common }
    : { provider: "codex", ...common };
}

function stickyFor(
  provider: TestedProviderKind,
  accountId?: string,
): AccountStorage["sticky"] {
  if (accountId === undefined) return {};
  return provider === "xai" ? { xai: accountId } : { codex: accountId };
}

function handlersFor(
  provider: TestedProviderKind,
  refresh: RefreshFn,
): Partial<Record<ProviderKind, RefreshFn>> {
  return provider === "xai" ? { xai: refresh } : { codex: refresh };
}

async function writeStore(
  storePath: string,
  accounts: AccountMetadata[],
  sticky: AccountStorage["sticky"] = {},
): Promise<void> {
  await saveAccounts({ version: 3, accounts, sticky }, storePath);
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
  "$source accounts port ($provider namespace)",
  ({ provider }) => {
    let storePath: string;

    beforeEach(() => {
      storePath = tmpStorePath(provider);
      resetAccountManager();
    });

    afterEach(async () => {
      await cleanStore(storePath);
      resetAccountManager();
    });

    describe("selectAccount (sticky / drain-first)", () => {
      it("skips disabled / entitlementBlocked / quota-exhausted / cooling-down and picks lowest eligible", async () => {
        const now = Date.now();
        await writeStore(storePath, [
          makeAccount(provider, "a0", { enabled: false }),
          makeAccount(provider, "a1", { entitlementBlocked: true }),
          makeAccount(provider, "a2", { quotaResetAt: now + HOUR }),
          makeAccount(provider, "a3", { coolingDownUntil: now + HOUR }),
          makeAccount(provider, "a4"),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        const picked = manager.selectAccount(provider, new Set());
        expect(picked?.accountId).toBe("a4");
        expect(manager.sticky(provider)).toBe("a4");
      });

      it("skips already-attempted accounts", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0"),
          makeAccount(provider, "a1"),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        const picked = manager.selectAccount(provider, new Set(["a0"]));
        expect(picked?.accountId).toBe("a1");
      });

      it("skips a dead account even when it is the current sticky account", async () => {
        await writeStore(
          storePath,
          [
            makeAccount(provider, "a0", { subscriptionStatus: "dead" }),
            makeAccount(provider, "a1"),
          ],
          stickyFor(provider, "a0"),
        );
        const manager = new AccountManager(storePath);
        await manager.load();

        const picked = manager.selectAccount(provider, new Set());
        expect(picked?.accountId).toBe("a1");
        expect(manager.sticky(provider)).toBe("a1");
      });

      it("returns null when every account is skipped", async () => {
        const now = Date.now();
        await writeStore(storePath, [
          makeAccount(provider, "a0", { enabled: false }),
          makeAccount(provider, "a1", { quotaResetAt: now + HOUR }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        expect(manager.selectAccount(provider, new Set())).toBeNull();
      });

      it("treats an expired quotaResetAt as eligible again", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", { quotaResetAt: Date.now() - 1_000 }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        expect(manager.selectAccount(provider, new Set())?.accountId).toBe("a0");
      });

      it("prefers the current sticky account when it is eligible", async () => {
        await writeStore(
          storePath,
          [
            makeAccount(provider, "a0"),
            makeAccount(provider, "a1"),
            makeAccount(provider, "a2"),
          ],
          stickyFor(provider, "a1"),
        );
        const manager = new AccountManager(storePath);
        await manager.load();

        const picked = manager.selectAccount(provider, new Set());
        expect(picked?.accountId).toBe("a1");
        expect(manager.sticky(provider)).toBe("a1");
      });
    });

    describe("add / remove", () => {
      it("adds an account and persists it, updating canonical", async () => {
        const manager = new AccountManager(storePath);
        await manager.add(makeAccount(provider, "a0"));

        expect(manager.get(provider, "a0")?.accountId).toBe("a0");
        const onDisk = await loadAccounts(storePath);
        expect(
          onDisk.accounts
            .filter((account) => account.provider === provider)
            .map((account) => account.accountId),
        ).toEqual(["a0"]);
      });

      it("rejects duplicate ids within the same provider", async () => {
        const manager = new AccountManager(storePath);
        await manager.add(makeAccount(provider, "a0"));
        await expect(manager.add(makeAccount(provider, "a0"))).rejects.toThrow(
          /already exists/,
        );
      });

      it("removes an account and clears that provider's sticky pointer", async () => {
        await writeStore(
          storePath,
          [makeAccount(provider, "a0"), makeAccount(provider, "a1")],
          stickyFor(provider, "a1"),
        );
        const manager = new AccountManager(storePath);
        await manager.load();

        await manager.remove(provider, "a1");
        expect(manager.get(provider, "a1")).toBeUndefined();
        expect(manager.sticky(provider)).toBeUndefined();
        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts.map((account) => account.accountId)).toEqual([
          "a0",
        ]);
        expect(onDisk.sticky[provider]).toBeUndefined();
      });
    });

    describe("ensureFreshToken", () => {
      it("fast path returns a still-valid token with no refresh call", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at-valid",
            refreshToken: "rt-current",
            expiresAt: Date.now() + HOUR,
          }),
        ]);
        const refresh = vi.fn<RefreshFn>();
        const manager = new AccountManager(
          storePath,
          handlersFor(provider, refresh),
        );
        await manager.load();

        const tokens = await manager.ensureFreshToken(provider, "a0");
        expect(tokens.accessToken).toBe("at-valid");
        expect(refresh).not.toHaveBeenCalled();
      });

      it("refreshes an expired token and persists the rotated token", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at-old",
            refreshToken: "rt-old",
            expiresAt: Date.now() - 1_000,
          }),
        ]);
        const refresh = vi.fn<RefreshFn>();
        refresh.mockResolvedValueOnce({
          accessToken: "at-new",
          refreshToken: "rt-rotated",
          expiresAt: Date.now() + HOUR,
        });
        const manager = new AccountManager(
          storePath,
          handlersFor(provider, refresh),
        );
        await manager.load();

        const tokens = await manager.ensureFreshToken(provider, "a0");
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledWith("rt-old");
        expect(tokens.refreshToken).toBe("rt-rotated");
        expect(manager.get(provider, "a0")?.refreshToken).toBe("rt-rotated");
        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts[0]?.refreshToken).toBe("rt-rotated");
      });

      it("reload-under-lock skips refresh when disk already has a fresh rotation", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at-expired",
            refreshToken: "rt-old",
            expiresAt: Date.now() - 1_000,
          }),
        ]);
        const refresh = vi.fn<RefreshFn>();
        const manager = new AccountManager(
          storePath,
          handlersFor(provider, refresh),
        );
        await manager.load();

        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at-fresh-from-other-proc",
            refreshToken: "rt-rotated-elsewhere",
            expiresAt: Date.now() + HOUR,
          }),
        ]);

        const tokens = await manager.ensureFreshToken(provider, "a0");
        expect(refresh).not.toHaveBeenCalled();
        expect(tokens.accessToken).toBe("at-fresh-from-other-proc");
        expect(tokens.refreshToken).toBe("rt-rotated-elsewhere");
        expect(manager.get(provider, "a0")?.refreshToken).toBe(
          "rt-rotated-elsewhere",
        );
      });

      it("single-flight shares one refresh between concurrent callers", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at-old",
            refreshToken: "rt-old",
            expiresAt: Date.now() - 1_000,
          }),
        ]);
        const refresh = vi.fn<RefreshFn>();
        refresh.mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            accessToken: "at-new",
            refreshToken: "rt-rotated",
            expiresAt: Date.now() + HOUR,
          };
        });
        const manager = new AccountManager(
          storePath,
          handlersFor(provider, refresh),
        );
        await manager.load();

        const [first, second] = await Promise.all([
          manager.ensureFreshToken(provider, "a0"),
          manager.ensureFreshToken(provider, "a0"),
        ]);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(first.refreshToken).toBe("rt-rotated");
        expect(second.refreshToken).toBe("rt-rotated");
      });
    });

    describe("mutation API", () => {
      it("does not clobber a freshly rotated token during a non-token mutation", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at",
            refreshToken: "rt-old",
            expiresAt: Date.now() + HOUR,
          }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at",
            refreshToken: "rt-rotated",
            expiresAt: Date.now() + HOUR,
          }),
        ]);
        await manager.markQuotaExhausted(provider, "a0", Date.now() + HOUR);

        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts[0]?.refreshToken).toBe("rt-rotated");
        expect(onDisk.accounts[0]?.quotaResetAt).toBeGreaterThan(Date.now());
        expect(onDisk.accounts[0]?.lastSwitchReason).toBe("quota-exhausted");
      });

      it("markQuotaExhausted demotes the account and switches sticky", async () => {
        await writeStore(
          storePath,
          [
            makeAccount(provider, "hot", { priority: 10, addedAt: 1 }),
            makeAccount(provider, "mid", { priority: 5, addedAt: 2 }),
            makeAccount(provider, "cold", { priority: 0, addedAt: 3 }),
          ],
          stickyFor(provider, "hot"),
        );
        const manager = new AccountManager(storePath);
        await manager.load();
        expect(manager.list(provider).map((account) => account.accountId)).toEqual([
          "hot",
          "mid",
          "cold",
        ]);
        expect(manager.sticky(provider)).toBe("hot");

        await manager.markQuotaExhausted(
          provider,
          "hot",
          Date.now() + HOUR,
        );

        const ids = manager.list(provider).map((account) => account.accountId);
        expect(ids[ids.length - 1]).toBe("hot");
        expect(ids.slice(0, 2)).toEqual(["mid", "cold"]);
        expect(manager.get(provider, "hot")?.quotaResetAt).toBeGreaterThan(
          Date.now(),
        );
        expect(manager.get(provider, "hot")?.lastSwitchReason).toBe(
          "quota-exhausted",
        );
        const hotPriority = manager.get(provider, "hot")?.priority;
        const midPriority = manager.get(provider, "mid")?.priority;
        const coldPriority = manager.get(provider, "cold")?.priority;
        expect(hotPriority).toBeLessThan(midPriority ?? 0);
        expect(hotPriority).toBeLessThan(coldPriority ?? 0);
        expect(manager.sticky(provider)).toBe("mid");
        expect(manager.selectAccount(provider, new Set())?.accountId).toBe("mid");

        const onDisk = await loadAccounts(storePath);
        expect(
          onDisk.accounts
            .filter((account) => account.provider === provider)
            .map((account) => account.accountId),
        ).toEqual(ids);
        expect(onDisk.sticky[provider]).toBe("mid");
        expect(
          onDisk.accounts.find(
            (account) =>
              account.provider === provider && account.accountId === "hot",
          )?.quotaResetAt,
        ).toBeGreaterThan(Date.now());
      });

      it("markEntitlementBlocked persists, updates canonical, and blocks selection", async () => {
        await writeStore(storePath, [makeAccount(provider, "a0")]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await manager.markEntitlementBlocked(provider, "a0");
        expect(manager.get(provider, "a0")?.entitlementBlocked).toBe(true);
        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts[0]?.entitlementBlocked).toBe(true);
        expect(manager.selectAccount(provider, new Set())).toBeNull();
      });

      it("markDeadCandidate sets subscriptionStatus=dead", async () => {
        await writeStore(storePath, [makeAccount(provider, "a0")]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await manager.markDeadCandidate(provider, "a0");
        expect(manager.get(provider, "a0")?.subscriptionStatus).toBe("dead");
        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts[0]?.subscriptionStatus).toBe("dead");
      });

      it("recordCooldown persists the reason and blocks selection", async () => {
        await writeStore(storePath, [makeAccount(provider, "a0")]);
        const manager = new AccountManager(storePath);
        await manager.load();

        const until = Date.now() + HOUR;
        await manager.recordCooldown(provider, "a0", "network-error", until);
        expect(manager.get(provider, "a0")?.coolingDownUntil).toBe(until);
        expect(manager.get(provider, "a0")?.cooldownReason).toBe("network-error");
        expect(manager.selectAccount(provider, new Set())).toBeNull();
        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts[0]?.cooldownReason).toBe("network-error");
      });

      it("touchLastUsed updates disk and canonical", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", { lastUsed: 0 }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await manager.touchLastUsed(provider, "a0");
        expect(manager.get(provider, "a0")?.lastUsed).toBeGreaterThan(0);
        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts[0]?.lastUsed).toBeGreaterThan(0);
      });
    });

    describe("management API", () => {
      it("switchTo stores the target as this provider's sticky account", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0"),
          makeAccount(provider, "a1"),
          makeAccount(provider, "a2"),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await manager.switchTo(provider, "a2");
        expect(manager.sticky(provider)).toBe("a2");
        const onDisk = await loadAccounts(storePath);
        expect(onDisk.sticky[provider]).toBe("a2");
      });

      it("switchTo throws on an unknown scoped id", async () => {
        await writeStore(storePath, [makeAccount(provider, "a0")]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await expect(manager.switchTo(provider, "nope")).rejects.toThrow(
          /unknown account/,
        );
      });

      it("setEnabled updates disk and canonical without clobbering tokens", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at",
            refreshToken: "rt-old",
            expiresAt: Date.now() + HOUR,
          }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at",
            refreshToken: "rt-rotated",
            expiresAt: Date.now() + HOUR,
          }),
        ]);
        await manager.setEnabled(provider, "a0", false);

        expect(manager.get(provider, "a0")?.enabled).toBe(false);
        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts[0]?.enabled).toBe(false);
        expect(onDisk.accounts[0]?.refreshToken).toBe("rt-rotated");
      });

      it("setLabel sets and clears the label", async () => {
        await writeStore(storePath, [makeAccount(provider, "a0")]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await manager.setLabel(provider, "a0", "work");
        expect(manager.get(provider, "a0")?.label).toBe("work");
        expect((await loadAccounts(storePath)).accounts[0]?.label).toBe("work");

        await manager.setLabel(provider, "a0", undefined);
        expect(manager.get(provider, "a0")?.label).toBeUndefined();
        expect(
          (await loadAccounts(storePath)).accounts[0]?.label,
        ).toBeUndefined();
      });

      it("setTags replaces the tag list wholesale", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", { tags: ["old"] }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await manager.setTags(provider, "a0", ["work", "primary"]);
        expect(manager.get(provider, "a0")?.tags).toEqual([
          "work",
          "primary",
        ]);
        expect((await loadAccounts(storePath)).accounts[0]?.tags).toEqual([
          "work",
          "primary",
        ]);

        await manager.setTags(provider, "a0", []);
        expect(manager.get(provider, "a0")?.tags).toEqual([]);
      });

      it("setNote sets and clears the note", async () => {
        await writeStore(storePath, [makeAccount(provider, "a0")]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await manager.setNote(provider, "a0", "spare account");
        expect(manager.get(provider, "a0")?.note).toBe("spare account");
        expect((await loadAccounts(storePath)).accounts[0]?.note).toBe(
          "spare account",
        );

        await manager.setNote(provider, "a0", undefined);
        expect(manager.get(provider, "a0")?.note).toBeUndefined();
      });
    });

    describe("prune API", () => {
      it("setFlaggedForRemoval updates disk and canonical without clobbering tokens", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at",
            refreshToken: "rt-old",
            expiresAt: Date.now() + HOUR,
          }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();
        await writeStore(storePath, [
          makeAccount(provider, "a0", {
            accessToken: "at",
            refreshToken: "rt-rotated",
            expiresAt: Date.now() + HOUR,
          }),
        ]);

        await manager.setFlaggedForRemoval(provider, "a0", true);
        expect(manager.get(provider, "a0")?.flaggedForRemoval).toBe(true);
        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts[0]?.flaggedForRemoval).toBe(true);
        expect(onDisk.accounts[0]?.refreshToken).toBe("rt-rotated");

        await manager.setFlaggedForRemoval(provider, "a0", false);
        expect(manager.get(provider, "a0")?.flaggedForRemoval).toBe(false);
      });

      it("returns dead and flagged accounts but excludes healthy and quota-exhausted", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "healthy"),
          makeAccount(provider, "dead", { subscriptionStatus: "dead" }),
          makeAccount(provider, "flagged", { flaggedForRemoval: true }),
          makeAccount(provider, "quota", { quotaResetAt: Date.now() + HOUR }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        const ids = manager
          .prunableAccounts(provider)
          .map((account) => account.accountId)
          .sort();
        expect(ids).toEqual(["dead", "flagged"]);
        expect(ids).not.toContain("quota");
        expect(ids).not.toContain("healthy");
      });

      it("removes only targets, clears removed sticky, and preserves rotated tokens", async () => {
        await writeStore(
          storePath,
          [
            makeAccount(provider, "a0", { subscriptionStatus: "dead" }),
            makeAccount(provider, "a1", {
              accessToken: "at",
              refreshToken: "rt-old",
              expiresAt: Date.now() + HOUR,
            }),
            makeAccount(provider, "a2", { flaggedForRemoval: true }),
          ],
          stickyFor(provider, "a2"),
        );
        const manager = new AccountManager(storePath);
        await manager.load();
        await writeStore(
          storePath,
          [
            makeAccount(provider, "a0", { subscriptionStatus: "dead" }),
            makeAccount(provider, "a1", {
              accessToken: "at",
              refreshToken: "rt-rotated",
              expiresAt: Date.now() + HOUR,
            }),
            makeAccount(provider, "a2", { flaggedForRemoval: true }),
          ],
          stickyFor(provider, "a2"),
        );

        const { removed } = await manager.pruneAccounts(provider, ["a0", "a2"]);
        expect(removed.sort()).toEqual(["a0", "a2"]);
        expect(manager.list(provider).map((account) => account.accountId)).toEqual([
          "a1",
        ]);
        expect(manager.sticky(provider)).toBeUndefined();

        const onDisk = await loadAccounts(storePath);
        expect(onDisk.accounts.map((account) => account.accountId)).toEqual([
          "a1",
        ]);
        expect(onDisk.sticky[provider]).toBeUndefined();
        expect(onDisk.accounts[0]?.refreshToken).toBe("rt-rotated");
      });

      it("takes exactly one backup for a bulk delete", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", { subscriptionStatus: "dead" }),
          makeAccount(provider, "a1", { flaggedForRemoval: true }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        await manager.pruneAccounts(provider, ["a0", "a1"]);

        const entries = await fs.readdir(path.dirname(storePath));
        const backupPrefix = `${path.basename(storePath)}.bak-`;
        expect(
          entries.filter((entry) => entry.startsWith(backupPrefix)),
        ).toHaveLength(1);
      });

      it("skips ids absent from the provider pool", async () => {
        await writeStore(storePath, [
          makeAccount(provider, "a0", { subscriptionStatus: "dead" }),
        ]);
        const manager = new AccountManager(storePath);
        await manager.load();

        const { removed } = await manager.pruneAccounts(provider, [
          "a0",
          "ghost",
        ]);
        expect(removed).toEqual(["a0"]);
        expect(manager.list(provider)).toEqual([]);
      });

      it("does not create a backup for an empty id list", async () => {
        await writeStore(storePath, [makeAccount(provider, "a0")]);
        const manager = new AccountManager(storePath);
        await manager.load();

        const { removed } = await manager.pruneAccounts(provider, []);
        expect(removed).toEqual([]);

        const entries = await fs.readdir(path.dirname(storePath));
        const backupPrefix = `${path.basename(storePath)}.bak-`;
        expect(
          entries.filter((entry) => entry.startsWith(backupPrefix)),
        ).toHaveLength(0);
      });
    });

    it("providerView binds provider on all account-facing operations", async () => {
      await writeStore(storePath, [
        makeAccount(provider, "a0"),
        makeAccount(provider, "a1"),
      ]);
      const manager = new AccountManager(storePath);
      await manager.load();
      const view = manager.providerView(provider);

      expect(view.list().map((account) => account.accountId)).toEqual([
        "a0",
        "a1",
      ]);
      await view.switchTo("a1");
      expect(view.sticky()).toBe("a1");
      await view.setEnabled("a1", false);
      expect(view.get("a1")?.enabled).toBe(false);
      expect(view.selectAccount(new Set())?.accountId).toBe("a0");
    });

    it("OAuth upsert rotates tokens while preserving provider-specific metadata", async () => {
      const original = makeAccount(provider, "a0");
      if (original.provider === "xai") {
        original.planTier = 3;
        original.planName = "SuperGrok";
        original.billingRemainingPercent = 42;
      } else {
        original.organizationId = "org-original";
        original.planType = "team";
        original.primaryUsedPercent = 25;
      }
      await writeStore(storePath, [original]);
      const manager = new AccountManager(storePath);
      await manager.load();

      const incoming = makeAccount(provider, "a0", {
        refreshToken: "rt-new",
        accessToken: "at-new",
        expiresAt: Date.now() + HOUR,
        email: "new@example.com",
      });
      const outcome = await manager.upsertFromOAuth(provider, incoming);

      expect(outcome).toBe("updated");
      const updated = manager.get(provider, "a0");
      expect(updated?.refreshToken).toBe("rt-new");
      expect(updated?.email).toBe("new@example.com");
      if (updated?.provider === "xai") {
        expect(updated.planTier).toBe(3);
        expect(updated.planName).toBe("SuperGrok");
        expect(updated.billingRemainingPercent).toBe(42);
      } else if (updated?.provider === "codex") {
        expect(updated.organizationId).toBe("org-original");
        expect(updated.planType).toBe("team");
        expect(updated.primaryUsedPercent).toBe(25);
      }
    });
  },
);

describe("getAccountManager singleton", () => {
  const paths: string[] = [];

  afterEach(async () => {
    resetAccountManager();
    await Promise.all(paths.splice(0).map((storePath) => cleanStore(storePath)));
  });

  it("returns the same instance and rejects a conflicting path", () => {
    const storePath = tmpStorePath("xai");
    paths.push(storePath);
    const first = getAccountManager(storePath);
    const second = getAccountManager(storePath);
    expect(first).toBe(second);
    expect(() => getAccountManager("/some/other/path.json")).toThrow(
      /different storagePath/,
    );
  });

  it("ships default refresh handlers so force-refresh works for plugins", async () => {
    const storePath = tmpStorePath("xai");
    paths.push(storePath);
    await writeStore(storePath, [
      makeAccount("xai", "a0", {
        accessToken: "at-old",
        refreshToken: "rt-old",
        expiresAt: Date.now() - 1_000,
      }),
    ]);

    // Spy provider OAuth without needing a live network refresh.
    const oauth = await import("../lib/providers/xai/auth/oauth.js");
    const spy = vi
      .spyOn(oauth, "refreshTokens")
      .mockResolvedValueOnce({
        accessToken: "at-new",
        refreshToken: "rt-rotated",
        expiresAt: Date.now() + HOUR,
      });

    try {
      const manager = getAccountManager(storePath);
      await manager.load();
      const tokens = await manager.ensureFreshToken("xai", "a0", true);
      expect(spy).toHaveBeenCalledWith("rt-old");
      expect(tokens.refreshToken).toBe("rt-rotated");
    } finally {
      spy.mockRestore();
    }
  });
});
