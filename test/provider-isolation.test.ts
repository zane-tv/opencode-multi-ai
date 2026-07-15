import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccountManager,
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
        version: 2,
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
});
