import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@opencode-ai/plugin";

const { xaiRefreshMock, codexRefreshMock } = vi.hoisted(() => ({
  xaiRefreshMock: vi.fn(),
  codexRefreshMock: vi.fn(),
}));

vi.mock("../lib/providers/xai/auth/oauth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/providers/xai/auth/oauth.js")>();
  return { ...actual, refreshTokens: xaiRefreshMock };
});

vi.mock("../lib/providers/codex/auth/oauth.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../lib/providers/codex/auth/oauth.js")
    >();
  return { ...actual, refreshTokens: codexRefreshMock };
});

import { AccountManager } from "../lib/core/accounts.js";
import type {
  AccountMetadata,
  AccountStorage,
  ProviderKind,
} from "../lib/core/schemas.js";
import { saveAccounts } from "../lib/core/storage.js";
import {
  buildCodexTools,
  buildKiroTools,
  buildTools,
  buildXaiTools,
} from "../lib/tools/registry.js";
import { resolveAccount } from "../lib/tools/resolve.js";

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-tools-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

function makeAccount(
  provider: ProviderKind,
  id: string,
  overrides: Partial<Omit<AccountMetadata, "provider" | "accountId">> = {},
): AccountMetadata {
  const common = {
    accountId: id,
    tags: [] as string[],
    refreshToken: `rt-${id}`,
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial" as const,
    subscriptionStatus: "active" as const,
    flaggedForRemoval: false,
    entitlementBlocked: false,
    ...overrides,
  };
  return provider === "xai"
    ? { provider: "xai", ...common }
    : { provider: "codex", ...common };
}

async function writeStore(
  storePath: string,
  accounts: AccountMetadata[],
  sticky: AccountStorage["sticky"] = {},
): Promise<void> {
  await saveAccounts({ version: 3, accounts, sticky }, storePath);
}

function ctx(): ToolContext {
  return {
    sessionID: "s",
    messageID: "m",
    agent: "a",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function asText(result: unknown): string {
  if (typeof result === "string") return result;
  if (
    result &&
    typeof result === "object" &&
    "output" in result &&
    typeof (result as { output: unknown }).output === "string"
  ) {
    return (result as { output: string }).output;
  }
  return String(result);
}

describe("account management tools (provider-scoped)", () => {
  let storePath: string;
  let manager: AccountManager;

  beforeEach(async () => {
    storePath = tmpStorePath();
    xaiRefreshMock.mockReset();
    codexRefreshMock.mockReset();
    // Colliding account ids across providers — tools must not mix them.
    await writeStore(
      storePath,
      [
        makeAccount("xai", "shared-id", {
          email: "a@x.ai",
          label: "XaiAlpha",
          tags: ["work"],
        }),
        makeAccount("xai", "xai-only", {
          email: "b@x.ai",
          label: "XaiBeta",
          tags: ["personal"],
        }),
        makeAccount("codex", "shared-id", {
          email: "a@openai.com",
          label: "CodexAlpha",
          tags: ["work"],
        }),
        makeAccount("codex", "codex-only", {
          email: "b@openai.com",
          label: "CodexBeta",
        }),
      ],
      { xai: "shared-id", codex: "shared-id" },
    );
    manager = new AccountManager(storePath, {
      xai: xaiRefreshMock,
      codex: codexRefreshMock,
    });
    await manager.load();
  });

  afterEach(async () => {
    await fs.unlink(storePath).catch(() => {});
  });

  it("xai-list only sees xai accounts (colliding ids)", async () => {
    const tools = buildXaiTools(manager);
    const out = asText(await tools["xai-list"]!.execute({}, ctx()));
    expect(out).toContain("XaiAlpha");
    expect(out).toContain("XaiBeta");
    expect(out).not.toContain("CodexAlpha");
    expect(out).not.toContain("CodexBeta");
    expect(out).toMatch(/xAI accounts \(2\//);
  });

  it("codex-list only sees codex accounts (colliding ids)", async () => {
    const tools = buildCodexTools(manager);
    const out = asText(await tools["codex-list"]!.execute({}, ctx()));
    expect(out).toContain("CodexAlpha");
    expect(out).toContain("CodexBeta");
    expect(out).not.toContain("XaiAlpha");
    expect(out).not.toContain("XaiBeta");
  });

  it("xai-list can filter by tag", async () => {
    const tools = buildXaiTools(manager);
    const out = asText(await tools["xai-list"]!.execute({ tag: "work" }, ctx()));
    expect(out).toContain("XaiAlpha");
    expect(out).not.toContain("XaiBeta");
  });

  it("xai-remove requires confirm=true and only removes xai", async () => {
    const tools = buildXaiTools(manager);
    const denied = asText(
      await tools["xai-remove"]!.execute({ index: 0 }, ctx()),
    );
    expect(denied).toContain("confirm=true");
    expect(manager.list("xai")).toHaveLength(2);
    expect(manager.list("codex")).toHaveLength(2);

    const ok = asText(
      await tools["xai-remove"]!.execute({ index: 0, confirm: true }, ctx()),
    );
    expect(ok).toContain("Removed");
    expect(manager.list("xai")).toHaveLength(1);
    // Colliding codex account must survive
    expect(manager.list("codex").some((a) => a.accountId === "shared-id")).toBe(
      true,
    );
  });

  it("xai-switch sticky does not affect codex sticky", async () => {
    const tools = buildXaiTools(manager);
    await tools["xai-switch"]!.execute({ index: 1 }, ctx());
    expect(manager.sticky("xai")).toBe("xai-only");
    expect(manager.sticky("codex")).toBe("shared-id");
  });

  it("xai-add explains OAuth login flow", async () => {
    const tools = buildXaiTools(manager);
    const out = asText(await tools["xai-add"]!.execute({}, ctx()));
    expect(out).toContain("opencode auth login");
    expect(out).toContain("xai-multi");
  });

  it("codex/kiro tools include import; xai tools do not", () => {
    const xai = buildXaiTools(manager);
    const codex = buildCodexTools(manager);
    const kiro = buildKiroTools(manager);
    expect(xai["codex-import"]).toBeUndefined();
    expect(xai["xai-import"]).toBeUndefined();
    expect(codex["codex-import"]).toBeDefined();
    expect(kiro["kiro-import"]).toBeDefined();
  });

  it("buildTools returns three maps with prefixed names", () => {
    const { xai, codex, kiro, all } = buildTools(manager);
    expect(Object.keys(xai).every((k) => k.startsWith("xai-"))).toBe(true);
    expect(Object.keys(codex).every((k) => k.startsWith("codex-"))).toBe(true);
    expect(Object.keys(kiro).every((k) => k.startsWith("kiro-"))).toBe(true);
    expect(all["xai-list"]).toBeDefined();
    expect(all["codex-list"]).toBeDefined();
    expect(all["kiro-list"]).toBeDefined();
  });

  it("resolveAccount is pure over a provider list", () => {
    const list = manager.list("xai");
    expect(resolveAccount(list, { index: 0 }).accountId).toBe("shared-id");
    expect(resolveAccount(list, { id: "xai-o" }).accountId).toBe("xai-only");
    expect(() => resolveAccount(list, {})).toThrow(/index|id/);
  });

  it("xai-limits shows remaining or unknown without probe data", async () => {
    const tools = buildXaiTools(manager);
    const out = asText(await tools["xai-limits"]!.execute({}, ctx()));
    expect(out).toContain("XaiAlpha");
    expect(out).toMatch(/credits:|unknown/);
  });

  it("codex-status uses codex prefix", async () => {
    const tools = buildCodexTools(manager);
    const out = asText(await tools["codex-status"]!.execute({}, ctx()));
    expect(out.startsWith("codex:")).toBe(true);
    expect(out).toContain("CodexAlpha");
  });
});
