/**
 * Import ChatGPT/Codex OAuth sessions from JSON (9router bulk-import + Codex CLI auth.json).
 *
 * Accepted shapes (single object, array, or `{ accounts: [...] }`):
 * - 9router: `{ accessToken, refreshToken, idToken?, email?, expiresAt?, expiresIn? }`
 * - snake_case: `{ access_token, refresh_token, id_token? }`
 * - Codex CLI `~/.codex/auth.json`: `{ tokens: { access_token, refresh_token, id_token? } }`
 * - This package pool: `{ version: 1|2, accounts: [AccountMetadata...] }` (refreshToken required)
 *
 * refresh token is REQUIRED (pool cannot rotate without it). Access-token-only
 * imports (9router access_token authType) are rejected.
 */

import { readFile } from "node:fs/promises";

import type {
  AccountManager,
  ProviderAccountView,
} from "../../../core/accounts.js";
import type { CodexAccountMetadata } from "../../../core/schemas.js";
import { OAUTH_SCOPE, PROVIDER_ID } from "../constants.js";
import { logger } from "../../../core/logger.js";
import { identityFromTokens, type Tokens } from "./oauth.js";
import {
  finalizeLoginToPool,
  type CodexLoginManager,
  type LoginResult,
} from "./login.js";
import { ensureHostAuthAfterLogin } from "./host-auth.js";

export type ImportJsonItemResult =
  | {
      index: number;
      ok: true;
      accountId: string;
      email?: string;
      outcome: LoginResult["outcome"];
    }
  | { index: number; ok: false; error: string };

export type ImportJsonResult = {
  success: number;
  failed: number;
  results: ImportJsonItemResult[];
};

type ImportManager = CodexLoginManager;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickStr(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function pickNum(
  obj: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function normalizeList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) {
    throw new Error("JSON root must be an object or array");
  }
  if (Array.isArray(raw.accounts)) return raw.accounts;
  return [raw];
}

function expiresAtFromItem(item: Record<string, unknown>): number {
  const expiresAt = pickNum(item, ["expiresAt", "expires_at"]);
  if (expiresAt !== undefined) {
    return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  }
  const expiresIn = pickNum(item, ["expiresIn", "expires_in"]);
  if (expiresIn !== undefined && expiresIn > 0) {
    return Date.now() + expiresIn * 1000;
  }
  const access =
    pickStr(item, ["accessToken", "access_token"]) ??
    (isRecord(item.tokens)
      ? pickStr(item.tokens, ["access_token", "accessToken"])
      : undefined);
  if (access) {
    try {
      const parts = access.split(".");
      if (parts.length >= 2) {
        const payload = parts[1]!
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        const padded = payload.padEnd(
          payload.length + ((4 - (payload.length % 4)) % 4),
          "=",
        );
        const json = Buffer.from(padded, "base64").toString("utf8");
        const data = JSON.parse(json) as { exp?: number };
        if (typeof data.exp === "number" && data.exp > 0) {
          return data.exp * 1000;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return Date.now() - 1;
}

export function tokensFromImportObject(raw: unknown): Tokens {
  if (!isRecord(raw)) {
    throw new Error("item is not an object");
  }

  const nested = isRecord(raw.tokens) ? raw.tokens : undefined;
  const src = nested ?? raw;

  const accessToken = pickStr(src, [
    "accessToken",
    "access_token",
    "access",
  ]);
  const refreshToken = pickStr(src, [
    "refreshToken",
    "refresh_token",
    "refresh",
  ]);
  const idToken = pickStr(src, ["idToken", "id_token"]);
  const scope = pickStr(src, ["scope", "oauthScope", "oauth_scope"]);

  if (!refreshToken) {
    throw new Error(
      "missing refreshToken/refresh_token (access-token-only import is not supported)",
    );
  }
  if (!accessToken) {
    throw new Error("missing accessToken/access_token");
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAtFromItem(nested ? { ...nested, ...raw } : raw),
    idToken,
    scope: scope ?? OAUTH_SCOPE,
  };
}

function metaFromImportObject(raw: unknown): {
  label?: string;
  email?: string;
  tags?: string[];
  note?: string;
} {
  if (!isRecord(raw)) return {};
  const label = pickStr(raw, ["label", "name"]);
  const email = pickStr(raw, ["email"]);
  const note = pickStr(raw, ["note"]);
  let tags: string[] | undefined;
  if (Array.isArray(raw.tags)) {
    tags = raw.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean);
  } else {
    const tagsStr = pickStr(raw, ["tags"]);
    if (tagsStr) {
      tags = tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  return { label, email, tags, note };
}

function isProviderView(manager: ImportManager): manager is ProviderAccountView {
  return "provider" in manager && manager.provider === "codex";
}

async function upsertCodexAccount(
  manager: ImportManager,
  account: CodexAccountMetadata,
): Promise<"added" | "updated"> {
  if (isProviderView(manager)) {
    return manager.upsertFromOAuth(account);
  }
  return (manager as AccountManager).upsertFromOAuth("codex", account);
}

async function setLabel(
  manager: ImportManager,
  accountId: string,
  label: string,
): Promise<void> {
  if (isProviderView(manager)) {
    await manager.setLabel(accountId, label);
    return;
  }
  await (manager as AccountManager).setLabel("codex", accountId, label);
}

async function setTags(
  manager: ImportManager,
  accountId: string,
  tags: string[],
): Promise<void> {
  if (isProviderView(manager)) {
    await manager.setTags(accountId, tags);
    return;
  }
  await (manager as AccountManager).setTags("codex", accountId, tags);
}

async function setNote(
  manager: ImportManager,
  accountId: string,
  note: string,
): Promise<void> {
  if (isProviderView(manager)) {
    await manager.setNote(accountId, note);
    return;
  }
  await (manager as AccountManager).setNote("codex", accountId, note);
}

async function setEmail(
  manager: ImportManager,
  accountId: string,
  email: string,
): Promise<void> {
  if (isProviderView(manager)) {
    await manager.setEmail(accountId, email);
    return;
  }
  await (manager as AccountManager).setEmail("codex", accountId, email);
}

export async function importOneJsonAccount(
  manager: ImportManager,
  raw: unknown,
): Promise<LoginResult & { label?: string }> {
  if (
    isRecord(raw) &&
    typeof raw.accountId === "string" &&
    typeof raw.refreshToken === "string" &&
    raw.refreshToken.length > 0 &&
    (typeof raw.accessToken === "string" || raw.accessToken === undefined)
  ) {
    const now = Date.now();
    const account: CodexAccountMetadata = {
      provider: "codex",
      accountId: raw.accountId,
      email: typeof raw.email === "string" ? raw.email : undefined,
      label: typeof raw.label === "string" ? raw.label : undefined,
      tags: Array.isArray(raw.tags)
        ? raw.tags.filter((t): t is string => typeof t === "string")
        : [],
      note: typeof raw.note === "string" ? raw.note : undefined,
      refreshToken: raw.refreshToken,
      accessToken:
        typeof raw.accessToken === "string" ? raw.accessToken : undefined,
      expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
      oauthScope:
        typeof raw.oauthScope === "string" ? raw.oauthScope : OAUTH_SCOPE,
      organizationId:
        typeof raw.organizationId === "string" ? raw.organizationId : undefined,
      enabled: raw.enabled !== false,
      priority: typeof raw.priority === "number" ? raw.priority : 0,
      addedAt: typeof raw.addedAt === "number" ? raw.addedAt : now,
      lastUsed: typeof raw.lastUsed === "number" ? raw.lastUsed : 0,
      lastSwitchReason: "initial",
      subscriptionStatus: "active",
      flaggedForRemoval: false,
      entitlementBlocked: false,
    };
    if (account.accessToken) {
      try {
        const id = identityFromTokens({
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiresAt: account.expiresAt ?? now,
        });
        account.accountId = id.accountId;
        account.email = id.email ?? account.email;
        account.organizationId = id.organizationId ?? account.organizationId;
      } catch {
        /* keep provided accountId */
      }
    }
    const outcome = await upsertCodexAccount(manager, account);
    return {
      accountId: account.accountId,
      email: account.email,
      outcome,
      label: account.label,
    };
  }

  const tokens = tokensFromImportObject(raw);
  const result = await finalizeLoginToPool(manager, tokens);
  const meta = metaFromImportObject(raw);
  if (meta.label) await setLabel(manager, result.accountId, meta.label);
  if (meta.tags) await setTags(manager, result.accountId, meta.tags);
  if (meta.note) await setNote(manager, result.accountId, meta.note);
  if (meta.email && !result.email) {
    await setEmail(manager, result.accountId, meta.email);
  }
  return { ...result, label: meta.label };
}

export async function importAccountsFromJsonText(
  manager: ImportManager,
  text: string,
): Promise<ImportJsonResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }

  const items = normalizeList(parsed);
  if (items.length === 0) {
    throw new Error("No accounts provided");
  }

  const results: ImportJsonItemResult[] = [];
  let success = 0;
  let failed = 0;
  let lastOkId: string | undefined;

  for (let i = 0; i < items.length; i++) {
    try {
      const result = await importOneJsonAccount(manager, items[i]);
      results.push({
        index: i,
        ok: true,
        accountId: result.accountId,
        email: result.email,
        outcome: result.outcome,
      });
      success++;
      lastOkId = result.accountId;
      logger.debug(
        `import-json ${result.outcome} account ${result.accountId}`,
      );
    } catch (err) {
      results.push({
        index: i,
        ok: false,
        error: (err as Error).message || "Unknown error",
      });
      failed++;
    }
  }

  if (success > 0) {
    ensureHostAuthAfterLogin(PROVIDER_ID, lastOkId);
  }

  return { success, failed, results };
}

export async function importAccountsFromJsonFile(
  manager: ImportManager,
  filePath: string,
): Promise<ImportJsonResult> {
  const text = await readFile(filePath, "utf8");
  return importAccountsFromJsonText(manager, text);
}
