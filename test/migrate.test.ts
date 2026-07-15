import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccountManager,
  resetAccountManager,
} from "../lib/core/accounts.js";
import { loadAccounts, saveAccounts } from "../lib/core/storage.js";
import {
  __resetMigrateInFlightForTest,
  migrateAccountsIfNeeded,
} from "../lib/migrate.js";

const NOW = 1_700_000_000_000;

type FixtureDir = {
  dir: string;
  xaiPath: string;
  codexPath: string;
  unifiedPath: string;
};

async function makeFixture(): Promise<FixtureDir> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), `multi-ai-migrate-${process.pid}-`),
  );
  return {
    dir,
    xaiPath: path.join(dir, "multi-xai-accounts.json"),
    codexPath: path.join(dir, "multi-codex-accounts.json"),
    unifiedPath: path.join(dir, "multi-ai-accounts.json"),
  };
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function legacyXaiDoc(
  accounts: Array<Record<string, unknown>>,
  activeIndex = 0,
): Record<string, unknown> {
  return {
    version: 1,
    accounts: accounts.map((a) => ({
      accountId: "xai-1",
      refreshToken: "rt-xai-1",
      addedAt: NOW,
      planTier: 1,
      planName: "SuperGrok",
      ...a,
    })),
    activeIndex,
  };
}

function legacyCodexDoc(
  accounts: Array<Record<string, unknown>>,
  activeIndex = 0,
): Record<string, unknown> {
  return {
    version: 1,
    accounts: accounts.map((a) => ({
      accountId: "codex-1",
      refreshToken: "rt-codex-1",
      addedAt: NOW,
      planType: "plus",
      primaryUsedPercent: 10,
      ...a,
    })),
    activeIndex,
  };
}

async function writeJson(file: string, doc: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function migrate(fx: FixtureDir) {
  return migrateAccountsIfNeeded({
    unifiedPath: fx.unifiedPath,
    xaiPath: fx.xaiPath,
    codexPath: fx.codexPath,
  });
}

describe("migrateAccountsIfNeeded (truth table)", () => {
  let fx: FixtureDir;

  beforeEach(async () => {
    fx = await makeFixture();
    __resetMigrateInFlightForTest();
    resetAccountManager();
  });

  afterEach(async () => {
    __resetMigrateInFlightForTest();
    resetAccountManager();
    await rmrf(fx.dir);
  });

  it("1. both legacy, no v2 → imports both, creates v2 + .bak", async () => {
    await writeJson(
      fx.xaiPath,
      legacyXaiDoc([{ accountId: "xai-a" }], 0),
    );
    await writeJson(
      fx.codexPath,
      legacyCodexDoc([{ accountId: "codex-b" }], 0),
    );

    const result = await migrate(fx);
    expect(result.ran).toBe(true);
    expect(result.reason).toBe("migrated");
    expect(result.xaiImported).toBe(1);
    expect(result.codexImported).toBe(1);
    expect(result.warnings).toEqual([]);

    const v2 = await loadAccounts(fx.unifiedPath);
    expect(v2.version).toBe(2);
    expect(v2.accounts).toHaveLength(2);
    expect(v2.accounts.map((a) => a.provider).sort()).toEqual([
      "codex",
      "xai",
    ]);
    expect(v2.sticky).toEqual({ xai: "xai-a", codex: "codex-b" });

    await expect(fs.access(`${fx.xaiPath}.bak`)).resolves.toBeUndefined();
    await expect(fs.access(`${fx.codexPath}.bak`)).resolves.toBeUndefined();
    // originals left in place
    await expect(fs.access(fx.xaiPath)).resolves.toBeUndefined();
    await expect(fs.access(fx.codexPath)).resolves.toBeUndefined();

    const mode = (await fs.stat(fx.unifiedPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("2. only xai → imports xai only", async () => {
    await writeJson(fx.xaiPath, legacyXaiDoc([{ accountId: "xai-only" }]));

    const result = await migrate(fx);
    expect(result.ran).toBe(true);
    expect(result.xaiImported).toBe(1);
    expect(result.codexImported).toBe(0);

    const v2 = await loadAccounts(fx.unifiedPath);
    expect(v2.accounts).toHaveLength(1);
    expect(v2.accounts[0]?.provider).toBe("xai");
    expect(v2.sticky.xai).toBe("xai-only");
    expect(v2.sticky.codex).toBeUndefined();
  });

  it("3. only codex → imports codex only", async () => {
    await writeJson(
      fx.codexPath,
      legacyCodexDoc([{ accountId: "codex-only" }]),
    );

    const result = await migrate(fx);
    expect(result.ran).toBe(true);
    expect(result.xaiImported).toBe(0);
    expect(result.codexImported).toBe(1);

    const v2 = await loadAccounts(fx.unifiedPath);
    expect(v2.accounts).toHaveLength(1);
    expect(v2.accounts[0]?.provider).toBe("codex");
    expect(v2.sticky.codex).toBe("codex-only");
  });

  it("4. neither → no-op ran=false", async () => {
    const result = await migrate(fx);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("no-legacy");
    expect(result.xaiImported).toBe(0);
    expect(result.codexImported).toBe(0);

    await expect(fs.access(fx.unifiedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("5. malformed codex + valid xai → xai imported, warning", async () => {
    await writeJson(fx.xaiPath, legacyXaiDoc([{ accountId: "xai-ok" }]));
    await writeJson(fx.codexPath, { not: "a valid legacy store" });

    const result = await migrate(fx);
    expect(result.ran).toBe(true);
    expect(result.xaiImported).toBe(1);
    expect(result.codexImported).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => /codex/i.test(w))).toBe(true);

    const v2 = await loadAccounts(fx.unifiedPath);
    expect(v2.accounts).toHaveLength(1);
    expect(v2.accounts[0]?.provider).toBe("xai");

    // malformed original left untouched
    const raw = await fs.readFile(fx.codexPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ not: "a valid legacy store" });
    await expect(fs.access(`${fx.codexPath}.bak`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("6. v2 already exists → skip, no clobber of v2 accounts", async () => {
    await saveAccounts(
      {
        version: 2,
        accounts: [
          {
            provider: "xai",
            accountId: "existing-xai",
            refreshToken: "rt-existing",
            tags: [],
            enabled: true,
            priority: 0,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
          },
        ],
        sticky: { xai: "existing-xai" },
      },
      fx.unifiedPath,
    );
    await writeJson(
      fx.xaiPath,
      legacyXaiDoc([{ accountId: "should-not-import", refreshToken: "rt-new" }]),
    );
    await writeJson(
      fx.codexPath,
      legacyCodexDoc([{ accountId: "codex-new" }]),
    );

    const result = await migrate(fx);
    // xai already present → skip xai; codex missing → import codex only
    // Plan says: v2 exists but a provider never imported → import missing only
    expect(result.ran).toBe(true);
    expect(result.xaiImported).toBe(0);
    expect(result.codexImported).toBe(1);

    const v2 = await loadAccounts(fx.unifiedPath);
    const xaiIds = v2.accounts
      .filter((a) => a.provider === "xai")
      .map((a) => a.accountId);
    expect(xaiIds).toEqual(["existing-xai"]);
    expect(v2.sticky.xai).toBe("existing-xai");
    expect(v2.accounts.some((a) => a.accountId === "codex-new")).toBe(true);
  });

  it("6b. v2 has both providers → full skip, no clobber", async () => {
    await saveAccounts(
      {
        version: 2,
        accounts: [
          {
            provider: "xai",
            accountId: "keep-xai",
            refreshToken: "rt-x",
            tags: [],
            enabled: true,
            priority: 0,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
          },
          {
            provider: "codex",
            accountId: "keep-codex",
            refreshToken: "rt-c",
            tags: [],
            enabled: true,
            priority: 0,
            addedAt: NOW,
            lastUsed: 0,
            lastSwitchReason: "initial",
            subscriptionStatus: "active",
            flaggedForRemoval: false,
            entitlementBlocked: false,
          },
        ],
        sticky: { xai: "keep-xai", codex: "keep-codex" },
      },
      fx.unifiedPath,
    );
    await writeJson(fx.xaiPath, legacyXaiDoc([{ accountId: "evil-xai" }]));
    await writeJson(fx.codexPath, legacyCodexDoc([{ accountId: "evil-codex" }]));

    const before = await fs.readFile(fx.unifiedPath, "utf8");
    const result = await migrate(fx);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("v2-exists");
    const after = await fs.readFile(fx.unifiedPath, "utf8");
    expect(after).toBe(before);
  });

  it("7. run twice → second no-op", async () => {
    await writeJson(fx.xaiPath, legacyXaiDoc([{ accountId: "xai-1" }]));
    await writeJson(fx.codexPath, legacyCodexDoc([{ accountId: "codex-1" }]));

    const first = await migrate(fx);
    expect(first.ran).toBe(true);
    expect(first.xaiImported + first.codexImported).toBe(2);

    const second = await migrate(fx);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("v2-exists");
    expect(second.xaiImported).toBe(0);
    expect(second.codexImported).toBe(0);

    const v2 = await loadAccounts(fx.unifiedPath);
    expect(v2.accounts).toHaveLength(2);
  });

  it("8. colliding accountIds across providers both present in v2", async () => {
    await writeJson(
      fx.xaiPath,
      legacyXaiDoc([{ accountId: "same-id", refreshToken: "rt-x" }]),
    );
    await writeJson(
      fx.codexPath,
      legacyCodexDoc([{ accountId: "same-id", refreshToken: "rt-c" }]),
    );

    const result = await migrate(fx);
    expect(result.ran).toBe(true);

    const v2 = await loadAccounts(fx.unifiedPath);
    expect(v2.accounts).toHaveLength(2);
    const ids = v2.accounts.map((a) => `${a.provider}:${a.accountId}`).sort();
    expect(ids).toEqual(["codex:same-id", "xai:same-id"]);
    expect(v2.sticky).toEqual({ xai: "same-id", codex: "same-id" });
  });

  it("9. sticky from activeIndex mapped", async () => {
    await writeJson(
      fx.xaiPath,
      legacyXaiDoc(
        [
          { accountId: "xai-0", refreshToken: "rt-0" },
          { accountId: "xai-1", refreshToken: "rt-1" },
        ],
        1,
      ),
    );
    await writeJson(
      fx.codexPath,
      legacyCodexDoc(
        [
          { accountId: "codex-0", refreshToken: "rt-c0" },
          { accountId: "codex-1", refreshToken: "rt-c1" },
          { accountId: "codex-2", refreshToken: "rt-c2" },
        ],
        2,
      ),
    );

    await migrate(fx);
    const v2 = await loadAccounts(fx.unifiedPath);
    expect(v2.sticky.xai).toBe("xai-1");
    expect(v2.sticky.codex).toBe("codex-2");
  });

  it("10. .bak not overwritten if exists", async () => {
    await writeJson(fx.xaiPath, legacyXaiDoc([{ accountId: "xai-1" }]));
    const existingBak = "EXISTING_BAK_CONTENT_DO_NOT_TOUCH";
    await fs.writeFile(`${fx.xaiPath}.bak`, existingBak, { mode: 0o600 });

    const result = await migrate(fx);
    expect(result.ran).toBe(true);
    expect(result.xaiImported).toBe(1);

    const bakAfter = await fs.readFile(`${fx.xaiPath}.bak`, "utf8");
    expect(bakAfter).toBe(existingBak);
  });

  it("concurrent migrateAccountsIfNeeded single-flights to one run", async () => {
    await writeJson(
      fx.xaiPath,
      legacyXaiDoc([{ accountId: "via-manager" }]),
    );

    const doCall = () =>
      migrateAccountsIfNeeded({
        unifiedPath: fx.unifiedPath,
        xaiPath: fx.xaiPath,
        codexPath: fx.codexPath,
      });

    const [a, b, c] = await Promise.all([doCall(), doCall(), doCall()]);
    expect(a.ran).toBe(true);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a.xaiImported).toBe(1);

    const manager = new AccountManager(fx.unifiedPath);
    await Promise.all([manager.load(), manager.load(), manager.load()]);
    expect(manager.list("xai")).toHaveLength(1);
    expect(manager.list("xai")[0]?.accountId).toBe("via-manager");
  });

  it("AccountManager.load() invokes migrate once under concurrent load()", async () => {
    const migrateMod = await import("../lib/migrate.js");
    const spy = vi
      .spyOn(migrateMod, "migrateAccountsIfNeeded")
      .mockResolvedValue({
        ran: false,
        reason: "mocked",
        xaiImported: 0,
        codexImported: 0,
        warnings: [],
      });

    try {
      await saveAccounts(
        {
          version: 2,
          accounts: [
            {
              provider: "xai",
              accountId: "preseed",
              refreshToken: "rt-preseed",
              tags: [],
              enabled: true,
              priority: 0,
              addedAt: NOW,
              lastUsed: 0,
              lastSwitchReason: "initial",
              subscriptionStatus: "unknown",
              flaggedForRemoval: false,
              entitlementBlocked: false,
            },
          ],
          sticky: { xai: "preseed" },
        },
        fx.unifiedPath,
      );

      const manager = new AccountManager(fx.unifiedPath);
      await Promise.all([manager.load(), manager.load(), manager.load()]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ unifiedPath: fx.unifiedPath });
      expect(manager.list("xai")[0]?.accountId).toBe("preseed");
    } finally {
      spy.mockRestore();
    }
  });

  it("AccountManager.load() sees migrated v2 after migrateAccountsIfNeeded", async () => {
    await writeJson(fx.xaiPath, legacyXaiDoc([{ accountId: "loaded" }]));
    await writeJson(fx.codexPath, legacyCodexDoc([{ accountId: "loaded-c" }]));
    await migrate(fx);

    const manager = new AccountManager(fx.unifiedPath);
    await manager.load();
    expect(manager.listAll()).toHaveLength(2);
    expect(manager.sticky("xai")).toBe("loaded");
    expect(manager.sticky("codex")).toBe("loaded-c");
  });
});
