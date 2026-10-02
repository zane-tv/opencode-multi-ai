import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AccountOf } from "../../../core/schemas.js";
import { getAccountManager, type AccountManager } from "../../../core/accounts.js";
import { logger } from "../../../core/logger.js";

export interface N9RouterConnection {
  id: string;
  provider: string;
  name?: string;
  email?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: string | number;
  projectId?: string;
  priority?: number;
  isActive?: boolean;
  createdAt?: string | number;
  lastUsedAt?: string | number;
  accountType?: string;
}

export interface ImportResult {
  totalIn9Router: number;
  imported: number;
  skipped: number;
  errors: string[];
  accounts: AccountOf<"antigravity">[];
}

export async function importAntigravityFrom9Router(
  options: {
    dbPath?: string;
    manager?: AccountManager;
  } = {},
): Promise<ImportResult> {
  const dbPath = options.dbPath || path.join(os.homedir(), ".n9router", "db.json");
  const manager = options.manager || getAccountManager();
  await manager.load();

  let rawContent: string;
  try {
    rawContent = await readFile(dbPath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read 9Router db at ${dbPath}: ${(err as Error).message}`);
  }

  let db: { providerConnections?: N9RouterConnection[] };
  try {
    db = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`Invalid JSON in 9Router db at ${dbPath}: ${(err as Error).message}`);
  }

  const connections = Array.isArray(db.providerConnections)
    ? db.providerConnections
    : [];

  const agConnections = connections.filter(
    (c) => c.provider === "antigravity" && typeof c.refreshToken === "string" && c.refreshToken.length > 0,
  );

  const result: ImportResult = {
    totalIn9Router: agConnections.length,
    imported: 0,
    skipped: 0,
    errors: [],
    accounts: [],
  };

  const existingAccounts = manager.list("antigravity");
  const existingByRefresh = new Set(existingAccounts.map((a) => a.refreshToken));
  const existingById = new Set(existingAccounts.map((a) => a.accountId));
  const existingByEmail = new Set(
    existingAccounts.map((a) => a.email).filter(Boolean) as string[],
  );

  const now = Date.now();

  for (const conn of agConnections) {
    try {
      if (existingByRefresh.has(conn.refreshToken!)) {
        result.skipped++;
        continue;
      }

      if (conn.email && existingByEmail.has(conn.email)) {
        result.skipped++;
        continue;
      }

      const accountId = conn.id && !existingById.has(conn.id)
        ? conn.id
        : `ag-${conn.email?.replace(/[^a-zA-Z0-9]/g, "_") || Math.random().toString(36).slice(2, 9)}`;

      let expiresAt: number | undefined;
      if (typeof conn.expiresAt === "number") {
        expiresAt = conn.expiresAt;
      } else if (typeof conn.expiresAt === "string") {
        const parsed = new Date(conn.expiresAt).getTime();
        if (!isNaN(parsed)) expiresAt = parsed;
      }

      let addedAt = now;
      if (typeof conn.createdAt === "number") {
        addedAt = conn.createdAt;
      } else if (typeof conn.createdAt === "string") {
        const parsed = new Date(conn.createdAt).getTime();
        if (!isNaN(parsed)) addedAt = parsed;
      }

      let lastUsed = 0;
      if (typeof conn.lastUsedAt === "number") {
        lastUsed = conn.lastUsedAt;
      } else if (typeof conn.lastUsedAt === "string") {
        const parsed = new Date(conn.lastUsedAt).getTime();
        if (!isNaN(parsed)) lastUsed = parsed;
      }

      const projectId =
        conn.projectId || `useful-fuze-${accountId.slice(0, 5)}`;

      const newAccount: AccountOf<"antigravity"> = {
        provider: "antigravity",
        accountId,
        email: conn.email,
        label: conn.name || conn.email || `Antigravity ${accountId.slice(0, 6)}`,
        tags: ["imported-9router"],
        refreshToken: conn.refreshToken!,
        accessToken: conn.accessToken,
        expiresAt,
        projectId,
        accountType: conn.accountType || "free",
        enabled: conn.isActive !== false,
        priority: typeof conn.priority === "number" ? conn.priority : 0,
        addedAt,
        lastUsed,
        lastSwitchReason: "initial",
        subscriptionStatus: "active",
        flaggedForRemoval: false,
        entitlementBlocked: false,
      };

      await manager.upsertFromOAuth("antigravity", newAccount);
      existingById.add(accountId);
      existingByRefresh.add(conn.refreshToken!);
      if (conn.email) existingByEmail.add(conn.email);

      result.imported++;
      result.accounts.push(newAccount);
    } catch (err) {
      const msg = `Failed to import connection ${conn.id || conn.email}: ${(err as Error).message}`;
      logger.error(msg);
      result.errors.push(msg);
    }
  }

  return result;
}
