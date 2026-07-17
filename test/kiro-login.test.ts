import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AccountManager,
  createDefaultRefreshHandlers,
} from "../lib/core/accounts.js";
import {
  buildDeviceUrl,
  importAccountManagerExport,
  loginWithApiKey,
  normalizeStartUrl,
  validateAwsRegionInput,
} from "../lib/providers/kiro/auth/login.js";
import { normalizeCredentialCandidate } from "../lib/providers/kiro/auth/credentials-import.js";

describe("kiro login helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizeStartUrl forces /start path", () => {
    expect(normalizeStartUrl("https://acme.awsapps.com/start/#/")).toBe(
      "https://acme.awsapps.com/start",
    );
    expect(normalizeStartUrl("https://acme.awsapps.com/portal")).toBe(
      "https://acme.awsapps.com/portal/start",
    );
    expect(normalizeStartUrl("")).toBeUndefined();
    expect(normalizeStartUrl(undefined)).toBeUndefined();
  });

  it("buildDeviceUrl embeds user code hash route", () => {
    const url = buildDeviceUrl("https://acme.awsapps.com/start", "ABCD-EFGH");
    expect(url).toContain("https://acme.awsapps.com/start/");
    expect(url).toContain("#/device?user_code=ABCD-EFGH");
  });

  it("validateAwsRegionInput rejects unknown regions", () => {
    expect(validateAwsRegionInput("")).toBeUndefined();
    expect(validateAwsRegionInput("us-east-1")).toBeUndefined();
    expect(validateAwsRegionInput("not-a-region")).toMatch(/valid AWS region/i);
  });

  it("loginWithApiKey builds api-key candidate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    const key = `ksk_${"a".repeat(24)}`;
    const account = await loginWithApiKey(key, "eu-central-1");
    expect(account.provider).toBe("kiro");
    expect(account.authMethod).toBe("api-key");
    expect(account.region).toBe("eu-central-1");
    expect(account.refreshToken).toBe(key);
    expect(account.accessToken).toBe(key);
  });

  it("rejects social auth methods on credentials import", async () => {
    await expect(
      normalizeCredentialCandidate({
        refreshToken: "rt",
        authMethod: "google",
      }),
    ).rejects.toThrow(/social login/i);
  });

  it("flattens nested credentials and maps builder-id → idc", async () => {
    const candidate = await normalizeCredentialCandidate(
      {
        credentials: {
          refreshToken: "rt-token",
          clientId: "cid",
          clientSecret: "csec",
          authMethod: "builder-id",
        },
        region: "us-west-2",
        email: "user@example.com",
      },
      { validateRefresh: false },
    );
    expect(candidate.authMethod).toBe("idc");
    expect(candidate.refreshToken).toBe("rt-token");
    expect(candidate.clientId).toBe("cid");
    expect(candidate.clientSecret).toBe("csec");
    expect(candidate.email).toBe("user@example.com");
    expect(candidate.region).toBe("us-west-2");
  });

  it("importAccountManagerExport reads accounts[].credentials", async () => {
    const accounts = await importAccountManagerExport(
      JSON.stringify({
        accounts: [
          {
            email: "a@example.com",
            credentials: {
              refreshToken: "rt1",
              clientId: "c1",
              clientSecret: "s1",
              authMethod: "idc",
              region: "us-east-1",
            },
          },
          {
            credentials: {
              refreshToken: `ksk_${"b".repeat(24)}`,
              authMethod: "api-key",
              region: "eu-central-1",
            },
          },
        ],
      }),
      { validateRefresh: false },
    );
    expect(accounts).toHaveLength(2);
    expect(accounts[0]!.authMethod).toBe("idc");
    expect(accounts[0]!.email).toBe("a@example.com");
    expect(accounts[1]!.authMethod).toBe("api-key");
    expect(accounts[1]!.region).toBe("eu-central-1");
  });
});

describe("kiro plugin auth methods", () => {
  let dir: string;
  let store: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "kiro-auth-"));
    store = path.join(dir, "accounts.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("registers five OpenCode auth methods matching source kiro-auth", async () => {
    const {
      getAccountManager,
      resetAccountManager,
    } = await import("../lib/core/accounts.js");
    resetAccountManager();
    const singleton = getAccountManager(store);
    await singleton.load();
    try {
      const mod = await import("../lib/plugin/kiro.js");
      const hooks = await mod.default.server({
        client: {} as never,
        project: {} as never,
        directory: process.cwd(),
        worktree: process.cwd(),
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://127.0.0.1:0"),
        $: {} as never,
      });
      expect(hooks.auth?.provider).toBe("kiro-multi");
      const methods = hooks.auth?.methods ?? [];
      expect(methods).toHaveLength(5);
      const labels = methods.map((m) => m.label);
      expect(labels).toEqual([
        "Kiro API Key",
        "AWS Builder ID / IAM Identity Center",
        "IAM Identity Center with Profile ARN",
        "Import account from credentials JSON",
        "Import accounts from Kiro Account Manager export",
      ]);
      expect(methods.filter((m) => m.type === "api")).toHaveLength(3);
      expect(methods.filter((m) => m.type === "oauth")).toHaveLength(2);

      const api = methods.find((m) => m.label === "Kiro API Key");
      expect(api?.type).toBe("api");
      if (api?.type === "api") {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            new Response(
              JSON.stringify({
                usageBreakdownList: [{ currentUsage: 1, usageLimit: 100 }],
                userInfo: { email: "plugin-api@example.com" },
                subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
              }),
              { status: 200 },
            ),
          ),
        );
        const key = `ksk_${"c".repeat(24)}`;
        const result = await api.authorize?.({
          api_key: key,
          region: "us-east-1",
        });
        expect(result).toEqual(
          expect.objectContaining({
            type: "success",
            provider: "kiro-multi",
          }),
        );
        const kiroAccounts = singleton.list("kiro");
        expect(kiroAccounts.length).toBeGreaterThanOrEqual(1);
        const first = kiroAccounts[0]!;
        expect(first.provider).toBe("kiro");
        if (first.provider === "kiro") {
          expect(first.authMethod).toBe("api-key");
          expect(first.email).toBe("plugin-api@example.com");
          expect(first.usedCount).toBe(1);
          expect(first.limitCount).toBe(100);
        }
      }
    } finally {
      resetAccountManager();
    }
  });
});
