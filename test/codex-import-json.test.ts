import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountManager } from "../lib/core/accounts.js";
import {
  importAccountsFromJsonFile,
  importAccountsFromJsonText,
  tokensFromImportObject,
} from "../lib/providers/codex/auth/import-json.js";
import { saveAccounts } from "../lib/core/storage.js";
import type { AccountStorage } from "../lib/core/schemas.js";

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-codex-import-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

/** Build a minimal unsigned JWT with the given payload (for unit tests only). */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function chatgptAccessToken(accountId: string, email?: string): string {
  return fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
    "https://api.openai.com/profile": email ? { email } : undefined,
  });
}

describe("tokensFromImportObject", () => {
  it("accepts 9router camelCase", () => {
    const t = tokensFromImportObject({
      accessToken: "at",
      refreshToken: "rt",
      idToken: "id",
      expiresIn: 60,
    });
    expect(t.accessToken).toBe("at");
    expect(t.refreshToken).toBe("rt");
    expect(t.idToken).toBe("id");
    expect(t.expiresAt).toBeGreaterThan(Date.now());
  });

  it("accepts snake_case and Codex CLI tokens wrapper", () => {
    const t = tokensFromImportObject({
      tokens: {
        access_token: "at2",
        refresh_token: "rt2",
        id_token: "id2",
      },
    });
    expect(t.accessToken).toBe("at2");
    expect(t.refreshToken).toBe("rt2");
    expect(t.idToken).toBe("id2");
  });

  it("rejects access-token-only (no refresh)", () => {
    expect(() =>
      tokensFromImportObject({ accessToken: "only-access" }),
    ).toThrow(/refreshToken/);
  });
});

describe("importAccountsFromJsonText", () => {
  let storePath: string;
  let manager: AccountManager;

  beforeEach(async () => {
    storePath = tmpStorePath();
    const empty: AccountStorage = { version: 3, accounts: [], sticky: {} };
    await saveAccounts(empty, storePath);
    manager = new AccountManager(storePath);
    await manager.load();
  });

  afterEach(async () => {
    await fs.unlink(storePath).catch(() => {});
  });

  it("imports a 9router-style array and upserts by account id", async () => {
    const access = chatgptAccessToken("acct-1", "one@example.com");
    const text = JSON.stringify([
      {
        accessToken: access,
        refreshToken: "rt-1",
        email: "one@example.com",
        label: "Primary",
      },
    ]);
    const result = await importAccountsFromJsonText(manager, text);
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
    expect(manager.list("codex")).toHaveLength(1);
    const a = manager.list("codex")[0]!;
    expect(a.provider).toBe("codex");
    expect(a.accountId).toBe("acct-1");
    expect(a.email).toBe("one@example.com");
    expect(a.label).toBe("Primary");
    expect(a.refreshToken).toBe("rt-1");

    // Re-import updates tokens
    const access2 = chatgptAccessToken("acct-1", "one@example.com");
    const again = await importAccountsFromJsonText(
      manager,
      JSON.stringify({
        accessToken: access2,
        refreshToken: "rt-1-rotated",
      }),
    );
    expect(again.success).toBe(1);
    expect(again.results[0]).toMatchObject({ ok: true, outcome: "updated" });
    expect(manager.list("codex")).toHaveLength(1);
    expect(manager.list("codex")[0]!.refreshToken).toBe("rt-1-rotated");
  });

  it("imports Codex CLI auth.json shape from a file", async () => {
    const access = chatgptAccessToken("acct-cli", "cli@example.com");
    const authPath = path.join(
      os.tmpdir(),
      `codex-auth-${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`,
    );
    await fs.writeFile(
      authPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: access,
          refresh_token: "rt-cli",
          id_token: access,
        },
        last_refresh: new Date().toISOString(),
      }),
      "utf8",
    );
    try {
      const result = await importAccountsFromJsonFile(manager, authPath);
      expect(result.success).toBe(1);
      expect(manager.list("codex")[0]!.accountId).toBe("acct-cli");
      expect(manager.list("codex")[0]!.refreshToken).toBe("rt-cli");
    } finally {
      await fs.unlink(authPath).catch(() => {});
    }
  });

  it("reports per-item failures without aborting the batch", async () => {
    const access = chatgptAccessToken("acct-ok", "ok@example.com");
    const result = await importAccountsFromJsonText(
      manager,
      JSON.stringify({
        accounts: [
          { accessToken: access, refreshToken: "rt-ok" },
          { accessToken: "no-refresh-here" },
        ],
      }),
    );
    expect(result.success).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[1]).toMatchObject({ ok: false });
    expect(manager.list("codex")).toHaveLength(1);
  });
});
