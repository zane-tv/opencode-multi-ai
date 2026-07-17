import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccountManager,
  type RefreshDriver,
  type RefreshFn,
} from "../lib/core/accounts.js";
import type { AccountMetadata } from "../lib/core/schemas.js";
import { saveAccounts } from "../lib/core/storage.js";

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-provider-isolation-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

function makeXaiAccount(id: string): AccountMetadata {
  return {
    provider: "xai",
    accountId: id,
    tags: [],
    refreshToken: `xai-rt-${id}`,
    enabled: true,
    priority: 0,
    addedAt: 1,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "unknown",
    flaggedForRemoval: false,
    entitlementBlocked: false,
  };
}

function makeCodexAccount(id: string): AccountMetadata {
  return {
    provider: "codex",
    accountId: id,
    tags: [],
    refreshToken: `codex-rt-${id}`,
    enabled: true,
    priority: 0,
    addedAt: 2,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "unknown",
    flaggedForRemoval: false,
    entitlementBlocked: false,
  };
}

function makeKiroAccount(id: string): AccountMetadata {
  return {
    provider: "kiro",
    accountId: id,
    tags: [],
    refreshToken: `ksk_${id}`,
    authMethod: "api-key",
    region: "us-east-1",
    enabled: true,
    priority: 0,
    addedAt: 3,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "unknown",
    flaggedForRemoval: false,
    entitlementBlocked: false,
  };
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

describe("provider-isolated account identity", () => {
  const paths: string[] = [];

  afterEach(async () => {
    await Promise.all(paths.splice(0).map((storePath) => cleanStore(storePath)));
  });

  it("keeps same-id lookup, mutation, removal, and sticky state provider-scoped", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    const manager = new AccountManager(storePath);

    await manager.add(makeXaiAccount("shared"));
    await manager.add(makeCodexAccount("shared"));
    await manager.switchTo("xai", "shared");
    await manager.switchTo("codex", "shared");
    await manager.setLabel("xai", "shared", "XAI account");

    expect(manager.get("xai", "shared")?.label).toBe("XAI account");
    expect(manager.get("codex", "shared")?.label).toBeUndefined();

    await manager.remove("xai", "shared");

    expect(manager.get("xai", "shared")).toBeUndefined();
    expect(manager.get("codex", "shared")?.refreshToken).toBe(
      "codex-rt-shared",
    );
    expect(manager.sticky("xai")).toBeUndefined();
    expect(manager.sticky("codex")).toBe("shared");
  });

  it("uses independent refresh single-flights for the same id", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    await saveAccounts(
      {
        version: 3,
        accounts: [makeXaiAccount("shared"), makeCodexAccount("shared")],
        sticky: {},
      },
      storePath,
    );
    const xaiRefresh = vi.fn<RefreshFn>().mockResolvedValue({
      accessToken: "xai-at-new",
      refreshToken: "xai-rt-new",
      expiresAt: Date.now() + 3_600_000,
    });
    const codexRefresh = vi.fn<RefreshFn>().mockResolvedValue({
      accessToken: "codex-at-new",
      refreshToken: "codex-rt-new",
      expiresAt: Date.now() + 3_600_000,
    });
    const manager = new AccountManager(storePath, {
      xai: xaiRefresh,
      codex: codexRefresh,
    });
    await manager.load();

    const [xaiTokens, codexTokens] = await Promise.all([
      manager.ensureFreshToken("xai", "shared"),
      manager.ensureFreshToken("codex", "shared"),
    ]);

    expect(xaiRefresh).toHaveBeenCalledTimes(1);
    expect(codexRefresh).toHaveBeenCalledTimes(1);
    expect(xaiTokens.accessToken).toBe("xai-at-new");
    expect(codexTokens.accessToken).toBe("codex-at-new");
  });

  it("enforces the account cap independently for each provider", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    const manager = new AccountManager(storePath);

    for (let index = 0; index < 20; index++) {
      await manager.add(makeXaiAccount(`xai-${index}`));
      await manager.add(makeCodexAccount(`codex-${index}`));
      await manager.add(makeKiroAccount(`kiro-${index}`));
    }

    await expect(manager.add(makeXaiAccount("xai-overflow"))).rejects.toThrow(
      /xai pool is at the maximum of 20 accounts/,
    );
    await expect(
      manager.add(makeCodexAccount("codex-overflow")),
    ).rejects.toThrow(/codex pool is at the maximum of 20 accounts/);
    await expect(manager.add(makeKiroAccount("kiro-overflow"))).rejects.toThrow(
      /kiro pool is at the maximum of 20 accounts/,
    );

    expect(manager.list("xai")).toHaveLength(20);
    expect(manager.list("codex")).toHaveLength(20);
    expect(manager.list("kiro")).toHaveLength(20);
  });

  it("selects sticky, round-robin, and lowest-usage accounts deterministically", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    const first = makeKiroAccount("first");
    const second = makeKiroAccount("second");
    const third = makeKiroAccount("third");
    if (
      first.provider !== "kiro" ||
      second.provider !== "kiro" ||
      third.provider !== "kiro"
    ) {
      throw new Error("expected Kiro accounts");
    }
    first.addedAt = 1;
    second.addedAt = 2;
    third.addedAt = 3;
    first.usedCount = 9;
    second.usedCount = 4;
    third.usedCount = 0;
    await saveAccounts(
      {
        version: 3,
        accounts: [first, second, third],
        sticky: { kiro: "first" },
      },
      storePath,
    );
    const manager = new AccountManager(storePath);
    await manager.load();

    expect(manager.selectAccount("kiro", new Set())?.accountId).toBe("first");
    expect(
      manager.selectAccount("kiro", new Set(), "round-robin")?.accountId,
    ).toBe("second");
    expect(
      manager.selectAccount("kiro", new Set(["second"]), "round-robin")
        ?.accountId,
    ).toBe("third");
    expect(
      manager.selectAccount("kiro", new Set(), "lowest-usage")?.accountId,
    ).toBe("third");
  });

  it("passes the narrowed account to typed refresh drivers", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    await saveAccounts(
      {
        version: 3,
        accounts: [makeKiroAccount("typed")],
        sticky: {},
      },
      storePath,
    );
    let received: {
      provider: string;
      authMethod: string;
      region: string;
      refreshToken: string;
    } | undefined;
    const refresh: RefreshDriver<"kiro"> = {
      refresh: vi.fn(async (account) => {
        received = {
          provider: account.provider,
          authMethod: account.authMethod,
          region: account.region,
          refreshToken: account.refreshToken,
        };
        return {
          accessToken: "kiro-at-new",
          refreshToken: "ksk_rotated",
          expiresAt: Date.now() + 3_600_000,
        };
      }),
    };
    const manager = new AccountManager(storePath, { kiro: refresh });
    await manager.load();

    await manager.ensureFreshToken("kiro", "typed", true);

    expect(received).toEqual({
      provider: "kiro",
      authMethod: "api-key",
      region: "us-east-1",
      refreshToken: "ksk_typed",
    });
    expect(refresh.refresh).toHaveBeenCalledWith(expect.any(Object), {
      force: true,
    });
  });
});
