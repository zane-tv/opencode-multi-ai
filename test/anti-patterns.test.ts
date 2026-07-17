/**
 * Executable AGENTS anti-pattern contracts for opencode-multi-ai.
 *
 * These lock the merge invariants from the xAI and Codex source packages:
 * dead-only-via-invalid_grant, prune ≠ quota, OAuth constants, export hygiene,
 * provider isolation, sticky-not-activeIndex, no-rotate-on-param-4xx, etc.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import {
  AccountManager,
  getAccountManager,
  isSelectable,
  resetAccountManager,
} from "../lib/core/accounts.js";
import {
  AccountStorageSchema,
  type AccountMetadata,
  type ProviderKind,
} from "../lib/core/schemas.js";
import { saveAccounts } from "../lib/core/storage.js";
import {
  createRotationFetch,
  type RotationManager,
} from "../lib/core/rotation-fetch.js";
import type { Classification, ProviderAdapter } from "../lib/core/adapter.js";
import * as xaiConstants from "../lib/providers/xai/constants.js";
import * as codexConstants from "../lib/providers/codex/constants.js";
import * as kiroConstants from "../lib/providers/kiro/constants.js";

const HOUR = 3_600_000;
const LIB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../lib",
);

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-anti-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
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
    subscriptionStatus: "unknown" as const,
    flaggedForRemoval: false,
    entitlementBlocked: false,
    ...overrides,
  };
  return provider === "xai"
    ? { provider: "xai", ...common }
    : { provider: "codex", ...common };
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("anti-patterns: dead only via markDeadCandidate / invalid_grant", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = tmpStorePath();
    resetAccountManager();
  });

  afterEach(async () => {
    resetAccountManager();
    await fs.promises.rm(storePath, { force: true }).catch(() => undefined);
    await fs.promises.rm(`${storePath}.lock`, { force: true }).catch(() => undefined);
  });

  it("markDeadCandidate is the only management path that sets subscriptionStatus=dead", async () => {
    await saveAccounts(
      {
        version: 3,
        accounts: [makeAccount("xai", "a0"), makeAccount("codex", "c0")],
        sticky: {},
      },
      storePath,
    );
    const manager = new AccountManager(storePath);
    await manager.load();

    await manager.markQuotaExhausted("xai", "a0", Date.now() + HOUR);
    await manager.markEntitlementBlocked("codex", "c0");
    await manager.recordCooldown("xai", "a0", "auth-failure", Date.now() + HOUR);

    expect(manager.get("xai", "a0")?.subscriptionStatus).not.toBe("dead");
    expect(manager.get("codex", "c0")?.subscriptionStatus).not.toBe("dead");

    await manager.markDeadCandidate("xai", "a0");
    expect(manager.get("xai", "a0")?.subscriptionStatus).toBe("dead");
    // Sibling provider identity is untouched.
    expect(manager.get("codex", "c0")?.subscriptionStatus).not.toBe("dead");
  });
});

describe("anti-patterns: prune never includes quota-exhausted only", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = tmpStorePath();
    resetAccountManager();
  });

  afterEach(async () => {
    resetAccountManager();
    await fs.promises.rm(storePath, { force: true }).catch(() => undefined);
  });

  it("prunableAccounts returns only dead or flagged — not quota-exhausted alone", async () => {
    await saveAccounts(
      {
        version: 3,
        accounts: [
          makeAccount("xai", "healthy"),
          makeAccount("xai", "dead", { subscriptionStatus: "dead" }),
          makeAccount("xai", "flagged", { flaggedForRemoval: true }),
          makeAccount("xai", "quota", { quotaResetAt: Date.now() + HOUR }),
          makeAccount("codex", "quota-codex", {
            quotaResetAt: Date.now() + HOUR,
          }),
        ],
        sticky: {},
      },
      storePath,
    );
    const manager = new AccountManager(storePath);
    await manager.load();

    const xaiIds = manager
      .prunableAccounts("xai")
      .map((a) => a.accountId)
      .sort();
    expect(xaiIds).toEqual(["dead", "flagged"]);
    expect(xaiIds).not.toContain("quota");
    expect(xaiIds).not.toContain("healthy");

    const codexIds = manager.prunableAccounts("codex").map((a) => a.accountId);
    expect(codexIds).toEqual([]);
  });
});

describe("anti-patterns: OAuth constants unchanged", () => {
  it("xAI CLIENT_ID / REDIRECT_URI / CALLBACK_PORT match SuperGrok public client", () => {
    expect(xaiConstants.CLIENT_ID).toBe(
      "b1a00492-073a-47ea-816f-4c329264a828",
    );
    expect(xaiConstants.REDIRECT_URI).toBe("http://127.0.0.1:56121/callback");
    expect(xaiConstants.CALLBACK_PORT).toBe(56121);
    expect(xaiConstants.OAUTH_EXTRA_PARAMS).toEqual({ plan: "generic" });
  });

  it("Codex CLIENT_ID / REDIRECT_URI / CALLBACK_PORT match Codex CLI public client", () => {
    expect(codexConstants.CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(codexConstants.REDIRECT_URI).toBe(
      "http://localhost:1455/auth/callback",
    );
    expect(codexConstants.CALLBACK_PORT).toBe(1455);
    expect(codexConstants.OAUTH_EXTRA_PARAMS.codex_cli_simplified_flow).toBe(
      "true",
    );
  });
});

describe("anti-patterns: no as any / @ts-ignore in lib/", () => {
  it("lib/**/*.ts contains no as any, @ts-ignore, or @ts-expect-error", () => {
    const files = walkTsFiles(LIB_ROOT);
    expect(files.length).toBeGreaterThan(20);

    const hits: string[] = [];
    const pattern = /\bas any\b|@ts-ignore|@ts-expect-error/;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      if (pattern.test(text)) {
        hits.push(path.relative(LIB_ROOT, file));
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("anti-patterns: plugin modules export only default", () => {
  it("lib/plugin/xai.ts exports only default PluginModule", async () => {
    const mod = await import("../lib/plugin/xai.js");
    expect(Object.keys(mod).sort()).toEqual(["default"]);
    expect(mod.default).toEqual(
      expect.objectContaining({
        id: "xai-multi",
        server: expect.any(Function),
      }),
    );
  });

  it("lib/plugin/codex.ts exports only default PluginModule", async () => {
    const mod = await import("../lib/plugin/codex.js");
    expect(Object.keys(mod).sort()).toEqual(["default"]);
    expect(mod.default).toEqual(
      expect.objectContaining({
        id: "codex-multi",
        server: expect.any(Function),
      }),
    );
  });

  it("lib/plugin/kiro.ts exports only default PluginModule", async () => {
    const mod = await import("../lib/plugin/kiro.js");
    expect(Object.keys(mod).sort()).toEqual(["default"]);
    expect(mod.default).toEqual(
      expect.objectContaining({
        id: "kiro-multi",
        server: expect.any(Function),
      }),
    );
  });

  it("package root re-exports all PluginModules as named exports (no default)", async () => {
    const mod = await import("../index.js");
    expect(Object.keys(mod).sort()).toEqual(["codex", "kiro", "xai"]);
    expect(mod.xai).toEqual(
      expect.objectContaining({
        id: "xai-multi",
        server: expect.any(Function),
      }),
    );
    expect(mod.codex).toEqual(
      expect.objectContaining({
        id: "codex-multi",
        server: expect.any(Function),
      }),
    );
    expect(mod.kiro).toEqual(
      expect.objectContaining({
        id: "kiro-multi",
        server: expect.any(Function),
      }),
    );
    expect((mod as { default?: unknown }).default).toBeUndefined();
  });
});

describe("anti-patterns: providers never register built-in ids", () => {
  it("custom provider ids are xai-multi / codex-multi / kiro-multi, never built-ins", () => {
    expect(xaiConstants.PROVIDER_ID).toBe("xai-multi");
    expect(xaiConstants.PROVIDER_ID).not.toBe("xai");
    expect(codexConstants.PROVIDER_ID).toBe("codex-multi");
    expect(codexConstants.PROVIDER_ID).not.toBe("openai");
    expect(kiroConstants.PROVIDER_ID).toBe("kiro-multi");
    expect(kiroConstants.PROVIDER_ID).not.toBe("kiro");
  });

  it("plugin config hooks do not overwrite built-in xai or openai keys", async () => {
    const storePath = tmpStorePath();
    resetAccountManager();
    getAccountManager(storePath);

    const xaiMod = await import("../lib/plugin/xai.js");
    const codexMod = await import("../lib/plugin/codex.js");
    const kiroMod = await import("../lib/plugin/kiro.js");
    const input = {
      client: {} as never,
      project: {} as never,
      directory: process.cwd(),
      worktree: process.cwd(),
      experimental_workspace: { register() {} },
      serverUrl: new URL("http://127.0.0.1:0"),
      $: {} as never,
    };

    const xaiHooks = await xaiMod.default.server(input);
    const codexHooks = await codexMod.default.server(input);
    const kiroHooks = await kiroMod.default.server(input);

    expect(xaiHooks.auth?.provider).toBe("xai-multi");
    expect(codexHooks.auth?.provider).toBe("codex-multi");
    expect(kiroHooks.auth?.provider).toBe("kiro-multi");

    const cfg: { provider?: Record<string, unknown> } = {
      provider: {
        xai: { keep: true },
        openai: { keep: true },
      },
    };
    await xaiHooks.config?.(cfg as never);
    await codexHooks.config?.(cfg as never);
    await kiroHooks.config?.(cfg as never);

    expect(cfg.provider?.xai).toEqual({ keep: true });
    expect(cfg.provider?.openai).toEqual({ keep: true });
    expect(cfg.provider?.["xai-multi"]).toBeDefined();
    expect(cfg.provider?.["codex-multi"]).toBeDefined();
    expect(cfg.provider?.["kiro-multi"]).toBeDefined();

    resetAccountManager();
    await fs.promises.rm(storePath, { force: true }).catch(() => undefined);
  });
});

describe("anti-patterns: isSelectable rejects dead/entitlement/quota/cooling", () => {
  const now = 1_700_000_000_000;
  const base = makeAccount("xai", "a0");

  it("rejects disabled, dead, entitlementBlocked, future quota, and cooling", () => {
    expect(isSelectable({ ...base, enabled: false }, now)).toBe(false);
    expect(
      isSelectable({ ...base, subscriptionStatus: "dead" }, now),
    ).toBe(false);
    expect(
      isSelectable({ ...base, entitlementBlocked: true }, now),
    ).toBe(false);
    expect(
      isSelectable({ ...base, quotaResetAt: now + 1 }, now),
    ).toBe(false);
    expect(
      isSelectable({ ...base, coolingDownUntil: now + 1 }, now),
    ).toBe(false);
  });

  it("accepts a healthy enabled account", () => {
    expect(isSelectable(base, now)).toBe(true);
    expect(
      isSelectable({ ...base, quotaResetAt: now - 1 }, now),
    ).toBe(true);
    expect(
      isSelectable({ ...base, coolingDownUntil: now - 1 }, now),
    ).toBe(true);
  });
});

describe("anti-patterns: selectAccount never crosses provider", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = tmpStorePath();
    resetAccountManager();
  });

  afterEach(async () => {
    resetAccountManager();
    await fs.promises.rm(storePath, { force: true }).catch(() => undefined);
  });

  it("colliding accountIds stay provider-scoped on select", async () => {
    await saveAccounts(
      {
        version: 3,
        accounts: [
          makeAccount("xai", "shared", { priority: 10 }),
          makeAccount("codex", "shared", { priority: 99 }),
          makeAccount("xai", "xai-only", { priority: 1 }),
        ],
        sticky: {},
      },
      storePath,
    );
    const manager = new AccountManager(storePath);
    await manager.load();

    const xaiPick = manager.selectAccount("xai", new Set());
    const codexPick = manager.selectAccount("codex", new Set());

    expect(xaiPick?.provider).toBe("xai");
    expect(xaiPick?.accountId).toBe("shared");
    expect(codexPick?.provider).toBe("codex");
    expect(codexPick?.accountId).toBe("shared");

    // Exhausting xai sticky must not yield the codex twin.
    const nextXai = manager.selectAccount("xai", new Set(["shared"]));
    expect(nextXai?.provider).toBe("xai");
    expect(nextXai?.accountId).toBe("xai-only");
  });
});

describe("anti-patterns: rotation-fetch does not rotate on unknown-client-error", () => {
  type FetchFn = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>;

  let fetchSpy: MockInstance<FetchFn>;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    fetchSpy = vi.fn() as MockInstance<FetchFn>;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns the 4xx response after a single attempt with no rotation marks", async () => {
    const adapter: ProviderAdapter = {
      id: "xai-multi",
      provider: "xai",
      displayName: "Grok Multi-Account",
      npmPackage: "@ai-sdk/xai",
      baseURL: "https://api.example.com/v1",
      dummyApiKey: "dummy",
      resolveUrl(input) {
        const u = typeof input === "string" ? new URL(input) : input;
        return u.toString();
      },
      buildHeaders(ctx) {
        const h = new Headers(ctx.initHeaders);
        h.set("Authorization", `Bearer ${ctx.accessToken}`);
        return h;
      },
      transformBody(init) {
        return init;
      },
      async classifyResponse(res): Promise<Classification> {
        if (res.status >= 400 && res.status < 500) {
          return { kind: "unknown-client-error", status: res.status };
        }
        return { kind: "ok" };
      },
      classifyThrownError(): Classification {
        return { kind: "network" };
      },
      async recordSuccess() {},
      async resolveModels() {
        return {};
      },
      providerDefaultOptions() {
        return {};
      },
      listSubtitle() {
        return "";
      },
      detailLines() {
        return [];
      },
    };

    const marks = {
      quota: [] as string[],
      entitlement: [] as string[],
      cooldown: [] as string[],
      dead: [] as string[],
      touched: [] as string[],
    };
    const manager: RotationManager = {
      selectAccount(_p, attempted) {
        if (!attempted.has("a0")) return { accountId: "a0" };
        if (!attempted.has("a1")) return { accountId: "a1" };
        return null;
      },
      async ensureFreshToken(_p, id) {
        return { accessToken: `tok-${id}` };
      },
      async markQuotaExhausted(_p, id) {
        marks.quota.push(id);
      },
      async markEntitlementBlocked(_p, id) {
        marks.entitlement.push(id);
      },
      async recordCooldown(_p, id) {
        marks.cooldown.push(id);
      },
      async markDeadCandidate(_p, id) {
        marks.dead.push(id);
      },
      async touchLastUsed(_p, id) {
        marks.touched.push(id);
      },
      list() {
        return [{ accountId: "a0" }, { accountId: "a1" }];
      },
      get(_p, id) {
        return { accountId: id };
      },
    };

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "max_tokens is invalid" }), {
        status: 400,
      }),
    );

    const custom = createRotationFetch(adapter, manager);
    const res = await custom("https://api.example.com/v1/chat", {
      method: "POST",
    });

    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(marks.quota).toEqual([]);
    expect(marks.entitlement).toEqual([]);
    expect(marks.cooldown).toEqual([]);
    expect(marks.dead).toEqual([]);
    expect(marks.touched).toEqual([]);
  });
});

describe("anti-patterns: no activeIndex in AccountStorageSchema (sticky only)", () => {
  it("v3 schema has sticky map and strips/ignores activeIndex", () => {
    const parsed = AccountStorageSchema.parse({
      version: 3,
      accounts: [],
      sticky: { xai: "a0" },
      activeIndex: 3,
    });
    expect(parsed.version).toBe(3);
    expect(parsed.sticky).toEqual({ xai: "a0" });
    expect("activeIndex" in parsed).toBe(false);
    expect(
      (AccountStorageSchema.shape as { activeIndex?: unknown }).activeIndex,
    ).toBeUndefined();
  });

  it("shape keys are version / accounts / sticky only", () => {
    expect(Object.keys(AccountStorageSchema.shape).sort()).toEqual([
      "accounts",
      "sticky",
      "version",
    ]);
  });
});
