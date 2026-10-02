import crypto from "node:crypto";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AccountManager,
  createDefaultRefreshHandlers,
} from "../lib/core/accounts.js";
import type {
  AccountMetadata,
  AccountStorage,
  OpenCodeGoAccountMetadata,
} from "../lib/core/schemas.js";
import { loadAccounts } from "../lib/core/storage.js";
import { writeActiveKeyToAuthJson } from "../lib/providers/opencode-go/auth/auth-file.js";
import { AUTH_JSON_KEY } from "../lib/providers/opencode-go/constants.js";

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-opencode-go-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

function makeAccount(
  id: string,
  apiKey = `key-${id}`,
  overrides: Partial<
    Omit<OpenCodeGoAccountMetadata, "provider" | "accountId">
  > = {},
): AccountMetadata {
  return {
    provider: "opencode-go",
    accountId: id,
    refreshToken: apiKey,
    accessToken: apiKey,
    tags: [],
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    ...overrides,
  };
}

async function writeStore(
  storePath: string,
  accounts: AccountMetadata[],
  sticky: AccountStorage["sticky"] = {},
): Promise<void> {
  const { saveAccounts } = await import("../lib/core/storage.js");
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

describe("writeActiveKeyToAuthJson (auth.json mirror)", () => {
  let dir: string;
  let authPath: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "multi-ai-auth-"));
    prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    authPath = path.join(dir, "opencode", "auth.json");
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes the key under the opencode-go entry with { type: api }", async () => {
    await writeActiveKeyToAuthJson("key-1");
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth[AUTH_JSON_KEY]).toEqual({ type: "api", key: "key-1" });
  });

  it("merges with existing auth.json entries and overwrites the opencode-go entry", async () => {
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify({
        "github-copilot": { type: "oauth", tokens: { access_token: "t" } },
        [AUTH_JSON_KEY]: { type: "api", key: "old-key" },
      }),
      "utf8",
    );

    await writeActiveKeyToAuthJson("new-key");

    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth["github-copilot"]).toEqual({
      type: "oauth",
      tokens: { access_token: "t" },
    });
    expect(auth[AUTH_JSON_KEY]).toEqual({ type: "api", key: "new-key" });
  });

  it("is atomic: no temp files left behind, 0600 mode", async () => {
    await writeActiveKeyToAuthJson("key-1");
    const entries = await fs.readdir(path.dirname(authPath));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it("replaces a corrupt auth.json with a fresh object", async () => {
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(authPath, "{not json", "utf8");

    await writeActiveKeyToAuthJson("key-1");

    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth[AUTH_JSON_KEY]).toEqual({ type: "api", key: "key-1" });
  });
});

describe("opencode-go pool (AccountManager)", () => {
  let storePath: string;
  let manager: AccountManager;

  beforeEach(async () => {
    storePath = tmpStorePath();
    manager = new AccountManager(storePath, createDefaultRefreshHandlers());
    await manager.load();
  });

  afterEach(async () => {
    await cleanStore(storePath);
  });

  it("add / list roundtrip and persists to disk", async () => {
    await manager.add(makeAccount("acc-1", "key-one", { label: "work" }));
    await manager.add(makeAccount("acc-2", "key-two"));

    const listed = manager.list("opencode-go");
    expect(listed).toHaveLength(2);
    expect(listed.map((a) => a.accountId).sort()).toEqual(["acc-1", "acc-2"]);
    expect(listed[0]?.provider).toBe("opencode-go");

    const onDisk = await loadAccounts(storePath);
    const go = onDisk.accounts.filter(
      (a) => a.provider === "opencode-go",
    );
    expect(go).toHaveLength(2);
    // Keys are stored in BOTH accessToken and refreshToken at the boundary.
    expect(go[0]?.refreshToken).toBe("key-one");
  });

  it("switchTo updates the sticky account (camelCase opencodeGo on disk)", async () => {
    await manager.add(makeAccount("acc-1"));
    await manager.add(makeAccount("acc-2"));

    await manager.switchTo("opencode-go", "acc-2");
    expect(manager.sticky("opencode-go")).toBe("acc-2");

    const onDisk = await loadAccounts(storePath);
    expect(onDisk.sticky.opencodeGo).toBe("acc-2");
    // The kebab-case key must NOT be used in v3 storage.
    expect(Object.keys(onDisk.sticky)).not.toContain("opencode-go");
  });

  it("remove clears the sticky pointer", async () => {
    await manager.add(makeAccount("acc-1"));
    await manager.switchTo("opencode-go", "acc-1");

    await manager.remove("opencode-go", "acc-1");

    expect(manager.list("opencode-go")).toEqual([]);
    expect(manager.sticky("opencode-go")).toBeUndefined();
  });

  it("ensureFreshToken is a passthrough: returns the stored key unchanged", async () => {
    await manager.add(
      makeAccount("acc-1", "static-key", { expiresAt: Date.now() - 1_000 }),
    );

    const tokens = await manager.ensureFreshToken("opencode-go", "acc-1", true);

    expect(tokens.accessToken).toBe("static-key");
    expect(tokens.refreshToken).toBe("static-key");
    expect(tokens.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    // No disk rewrite of the key.
    expect(manager.get("opencode-go", "acc-1")?.accessToken).toBe("static-key");
  });

  it("ensureFreshToken fast path returns the valid stored key without refresh", async () => {
    await manager.add(
      makeAccount("acc-1", "fast-key", { expiresAt: Date.now() + 3_600_000 }),
    );

    const tokens = await manager.ensureFreshToken("opencode-go", "acc-1");

    expect(tokens.accessToken).toBe("fast-key");
  });

  it("upsertFromOAuth rejects opencode-go accounts (merge via OAuth forbidden)", async () => {
    await manager.add(makeAccount("acc-1", "key-one"));

    await expect(
      manager.upsertFromOAuth("opencode-go", makeAccount("acc-1", "key-two")),
    ).rejects.toThrow(/cannot be merged via OAuth/);
    // Original key must survive the rejected upsert.
    expect(manager.get("opencode-go", "acc-1")?.accessToken).toBe("key-one");
  });

  it("flaggedForRemoval accounts are skipped by selection", async () => {
    await manager.add(makeAccount("acc-1"));
    await manager.add(
      makeAccount("acc-2", "key-two", { flaggedForRemoval: true }),
    );

    const picked = manager.selectAccount("opencode-go", new Set());
    expect(picked?.accountId).toBe("acc-1");
  });

  it("add persists per-account dashboard cred and survives reload", async () => {
    await manager.add(
      makeAccount("acc-1", "key-one", {
        openCodeGoWorkspaceId: "wrk_abc",
        openCodeGoAuthCookie: "auth=cookie-1",
      }),
    );

    const acc = manager.get("opencode-go", "acc-1");
    const go = acc?.provider === "opencode-go" ? acc : undefined;
    expect(go?.openCodeGoWorkspaceId).toBe("wrk_abc");
    expect(go?.openCodeGoAuthCookie).toBe("auth=cookie-1");

    // Durable persist: a fresh manager on the same path retains the cred.
    const reloaded = new AccountManager(
      storePath,
      createDefaultRefreshHandlers(),
    );
    await reloaded.load();
    const onDisk = reloaded.get("opencode-go", "acc-1");
    const goDisk = onDisk?.provider === "opencode-go" ? onDisk : undefined;
    expect(goDisk?.openCodeGoWorkspaceId).toBe("wrk_abc");
    expect(goDisk?.openCodeGoAuthCookie).toBe("auth=cookie-1");
  });

  it("add without dashboard cred keeps the fields absent (env fallback path)", async () => {
    await manager.add(makeAccount("acc-1", "key-one"));

    const acc = manager.get("opencode-go", "acc-1");
    const go = acc?.provider === "opencode-go" ? acc : undefined;
    expect(go?.openCodeGoWorkspaceId).toBeUndefined();
    expect(go?.openCodeGoAuthCookie).toBeUndefined();

    const onDisk = await loadAccounts(storePath);
    const goDisk = onDisk.accounts.find(
      (a) => a.provider === "opencode-go",
    );
    expect(goDisk?.openCodeGoWorkspaceId).toBeUndefined();
    expect(goDisk?.openCodeGoAuthCookie).toBeUndefined();
  });

  it("setOpenCodeGoQuota writes the 6 workspace fields, persists, and survives reload", async () => {
    await manager.add(makeAccount("acc-1", "key-one"));

    await manager.setOpenCodeGoQuota("acc-1", {
      rolling: { usagePercent: 50, resetAt: 1_800_000_000_000 + 3_600_000 },
      weekly: { usagePercent: 30, resetAt: 1_800_000_000_000 + 604_800_000 },
      monthly: { usagePercent: 20, resetAt: 1_800_000_000_000 + 2_592_000_000 },
    });

    const acc = manager.get("opencode-go", "acc-1");
    const go = acc?.provider === "opencode-go" ? acc : undefined;
    expect(go?.openCodeGoFiveHourUsage).toBe(50);
    expect(go?.openCodeGoFiveHourReset).toBe(1_800_000_000_000 + 3_600_000);
    expect(go?.openCodeGoWeeklyUsage).toBe(30);
    expect(go?.openCodeGoWeeklyReset).toBe(1_800_000_000_000 + 604_800_000);
    expect(go?.openCodeGoMonthlyUsage).toBe(20);
    expect(go?.openCodeGoMonthlyReset).toBe(1_800_000_000_000 + 2_592_000_000);

    // Durable persist: a fresh manager on the same path retains the fields.
    const reloaded = new AccountManager(
      storePath,
      createDefaultRefreshHandlers(),
    );
    await reloaded.load();
    const onDisk = reloaded.get("opencode-go", "acc-1");
    const goDisk = onDisk?.provider === "opencode-go" ? onDisk : undefined;
    expect(goDisk?.openCodeGoFiveHourUsage).toBe(50);
    expect(goDisk?.openCodeGoWeeklyUsage).toBe(30);
    expect(goDisk?.openCodeGoMonthlyUsage).toBe(20);
    expect(goDisk?.openCodeGoMonthlyReset).toBe(
      1_800_000_000_000 + 2_592_000_000,
    );
  });

  it("setOpenCodeGoQuota clears windows missing from the snapshot and skips unknown ids", async () => {
    await manager.add(makeAccount("acc-1", "key-one"));
    await manager.setOpenCodeGoQuota("acc-1", {
      rolling: { usagePercent: 64, resetAt: 1_800_000_000_000 + 900_000 },
      weekly: { usagePercent: 12, resetAt: 1_800_000_000_000 + 43_200_000 },
    });

    const acc = manager.get("opencode-go", "acc-1");
    const go = acc?.provider === "opencode-go" ? acc : undefined;
    expect(go?.openCodeGoFiveHourUsage).toBe(64);
    expect(go?.openCodeGoWeeklyUsage).toBe(12);
    // Missing monthly window is cleared, not stale.
    expect(go?.openCodeGoMonthlyUsage).toBeUndefined();
    expect(go?.openCodeGoMonthlyReset).toBeUndefined();

    // Unknown id is a no-op (no throw).
    await expect(
      manager.setOpenCodeGoQuota("nope", {
        rolling: { usagePercent: 1, resetAt: 2 },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("setOpenCodeGoCred (per-account dashboard cred update)", () => {
  let storePath: string;
  let manager: AccountManager;

  beforeEach(async () => {
    storePath = tmpStorePath();
    manager = new AccountManager(storePath);
    await manager.load();
  });

  afterEach(async () => {
    try {
      await fs.unlink(storePath);
    } catch {}
  });

  it("updates both workspace + cookie, persists, and survives reload", async () => {
    await manager.add(makeAccount("acc-1", "key-1"));

    const updated = await manager
      .providerView("opencode-go")
      .setOpenCodeGoCred("acc-1", {
        workspaceId: "wrk_NEW",
        authCookie: "auth=NEWCOOKIE",
      });
    expect(updated?.openCodeGoWorkspaceId).toBe("wrk_NEW");
    expect(updated?.openCodeGoAuthCookie).toBe("NEWCOOKIE");

    // Reload from disk
    const fresh = new AccountManager(storePath);
    await fresh.load();
    const reloaded = fresh.get("opencode-go", "acc-1");
    const reloadedGo =
      reloaded?.provider === "opencode-go" ? reloaded : undefined;
    expect(reloadedGo?.openCodeGoWorkspaceId).toBe("wrk_NEW");
    expect(reloadedGo?.openCodeGoAuthCookie).toBe("NEWCOOKIE");
  });

  it("strips auth= prefix on cookie", async () => {
    await manager.add(makeAccount("acc-1", "key-1"));
    const updated = await manager
      .providerView("opencode-go")
      .setOpenCodeGoCred("acc-1", {
        workspaceId: "wrk_X",
        authCookie: "auth=raw-value",
      });
    expect(updated?.openCodeGoAuthCookie).toBe("raw-value");
  });

  it("clears both fields when both are provided blank", async () => {
    await manager.add(makeAccount("acc-1", "key-1"));
    await manager.providerView("opencode-go").setOpenCodeGoCred("acc-1", {
      workspaceId: "wrk_KEEP",
      authCookie: "keep-cookie",
    });
    const updated = await manager
      .providerView("opencode-go")
      .setOpenCodeGoCred("acc-1", {
        workspaceId: "",
        authCookie: "",
      });
    expect(updated?.openCodeGoWorkspaceId).toBeUndefined();
    expect(updated?.openCodeGoAuthCookie).toBeUndefined();
  });

  it("rejects mismatched partial: workspaceId provided, cookie missing", async () => {
    await manager.add(makeAccount("acc-1", "key-1"));
    await expect(
      manager.providerView("opencode-go").setOpenCodeGoCred("acc-1", {
        workspaceId: "wrk_LONELY",
      }),
    ).rejects.toThrow(/must provide both/);
    // The account's cred fields are untouched.
    const acc = manager.get("opencode-go", "acc-1");
    const go = acc?.provider === "opencode-go" ? acc : undefined;
    expect(go?.openCodeGoWorkspaceId).toBeUndefined();
    expect(go?.openCodeGoAuthCookie).toBeUndefined();
  });

  it("returns undefined for unknown account id", async () => {
    await expect(
      manager
        .providerView("opencode-go")
        .setOpenCodeGoCred("nope", {
          workspaceId: "wrk_X",
          authCookie: "cook",
        }),
    ).resolves.toBeUndefined();
  });
});

describe("opencode-go-switch tool (auth.json mirror)", () => {
  let storePath: string;
  let manager: AccountManager;
  let dir: string;
  let authPath: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    storePath = tmpStorePath();
    manager = new AccountManager(storePath, createDefaultRefreshHandlers());
    await manager.load();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "multi-ai-switch-"));
    prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    authPath = path.join(dir, "opencode", "auth.json");
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    await fs.rm(dir, { recursive: true, force: true });
    await cleanStore(storePath);
  });

  it("mirrors the switched key into auth.json", async () => {
    await manager.add(makeAccount("acc-1", "key-alpha"));
    await manager.add(makeAccount("acc-2", "key-beta"));

    const { buildOpenCodeGoTools } = await import(
      "../lib/tools/registry.js"
    );
    const tools = buildOpenCodeGoTools(manager);
    const switchTool = tools["opencode-go-switch"];
    expect(switchTool).toBeDefined();

    const ctx = {
      sessionID: "test",
      messageID: "test",
      agent: "test",
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    };

    // Switch to account 2 by index.
    const result = await switchTool!.execute({ index: 1 }, ctx);
    expect(result).toContain("Mirrored API key to auth.json");

    // Verify auth.json was written with the correct key.
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth[AUTH_JSON_KEY]).toEqual({ type: "api", key: "key-beta" });

    // Verify sticky was updated.
    expect(manager.sticky("opencode-go")).toBe("acc-2");
  });

  it("switch back to first account updates auth.json with original key", async () => {
    await manager.add(makeAccount("acc-1", "key-alpha"));
    await manager.add(makeAccount("acc-2", "key-beta"));
    await manager.switchTo("opencode-go", "acc-2");

    const { buildOpenCodeGoTools } = await import(
      "../lib/tools/registry.js"
    );
    const tools = buildOpenCodeGoTools(manager);
    const switchTool = tools["opencode-go-switch"];

    const ctx = {
      sessionID: "test",
      messageID: "test",
      agent: "test",
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    };

    // Use id-based selection (switchTo promotes acc-2, reordering indexes).
    await switchTool!.execute({ id: "acc-1" }, ctx);

    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth[AUTH_JSON_KEY]).toEqual({ type: "api", key: "key-alpha" });
    expect(manager.sticky("opencode-go")).toBe("acc-1");
  });
});

describe("opencode-go-rotate tool (auth.json mirror)", () => {
  let storePath: string;
  let manager: AccountManager;
  let dir: string;
  let authPath: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    storePath = tmpStorePath();
    manager = new AccountManager(storePath, createDefaultRefreshHandlers());
    await manager.load();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "multi-ai-rotate-"));
    prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    authPath = path.join(dir, "opencode", "auth.json");
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    await fs.rm(dir, { recursive: true, force: true });
    await cleanStore(storePath);
  });

  it("rotates to the next account and mirrors key into auth.json", async () => {
    await manager.add(makeAccount("acc-1", "key-alpha"));
    await manager.add(makeAccount("acc-2", "key-beta"));
    await manager.switchTo("opencode-go", "acc-1");

    const { buildOpenCodeGoTools } = await import(
      "../lib/tools/registry.js"
    );
    const tools = buildOpenCodeGoTools(manager);
    const rotateTool = tools["opencode-go-rotate"];
    expect(rotateTool).toBeDefined();

    const ctx = {
      sessionID: "test",
      messageID: "test",
      agent: "test",
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    };

    const result = await rotateTool!.execute({}, ctx);
    expect(result).toContain("Rotated to account");

    // Should have rotated to acc-2 (the non-sticky one).
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth[AUTH_JSON_KEY]).toEqual({ type: "api", key: "key-beta" });
    expect(manager.sticky("opencode-go")).toBe("acc-2");
  });

  it("cycles through all accounts with 3+ accounts (no 2-cycle collapse)", async () => {
    // Regression: rotate used switchTo (which promotes to the front), so with
    // 3+ accounts it only ever alternated the top two. Rotation must walk the
    // stable priority order forward and visit every account.
    await manager.add(makeAccount("acc-1", "key-alpha"));
    await manager.add(makeAccount("acc-2", "key-beta"));
    await manager.add(makeAccount("acc-3", "key-gamma"));
    await manager.switchTo("opencode-go", "acc-1");

    const { buildOpenCodeGoTools } = await import(
      "../lib/tools/registry.js"
    );
    const rotateTool = buildOpenCodeGoTools(manager)["opencode-go-rotate"];
    expect(rotateTool).toBeDefined();

    const ctx = {
      sessionID: "test",
      messageID: "test",
      agent: "test",
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    };

    const stickies: Array<string | undefined> = [];
    for (let i = 0; i < 4; i++) {
      await rotateTool!.execute({}, ctx);
      stickies.push(manager.sticky("opencode-go"));
    }

    // Three consecutive rotates must reach all three accounts; the fourth
    // returns to a full forward cycle (acc-2 → acc-3 → acc-1 → acc-2),
    // never a 2-cycle.
    expect(new Set(stickies)).toEqual(new Set(["acc-1", "acc-2", "acc-3"]));
    expect(stickies[0]).toBe("acc-2");
    expect(stickies[1]).toBe("acc-3");
    expect(stickies[2]).toBe("acc-1");
    expect(stickies[3]).toBe("acc-2");

    // Each rotate mirrored its key into auth.json; the 4th rotate landed on
    // acc-2, so auth.json carries acc-2's key.
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth[AUTH_JSON_KEY]).toEqual({ type: "api", key: "key-beta" });
  });
});
