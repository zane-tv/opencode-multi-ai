import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DUMMY_API_KEY, PROVIDER_ID } from "../constants.js";
import { logger } from "../../../core/logger.js";

export function openCodeAuthPath(): string {
  const dataRoot =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataRoot, "opencode", "auth.json");
}

function readAuthFile(authPath: string): Record<string, unknown> | null {
  if (!existsSync(authPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn("host-auth: auth.json is not an object; skip bootstrap");
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      `host-auth: invalid auth.json; skip bootstrap: ${(err as Error).message}`,
    );
    return null;
  }
}

function writeAuthFile(
  authPath: string,
  auth: Record<string, unknown>,
): void {
  mkdirSync(dirname(authPath), { recursive: true });
  const mode = existsSync(authPath) ? statSync(authPath).mode & 0o777 : 0o600;
  const tempPath = `${authPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: "utf8",
    mode,
  });
  try {
    chmodSync(tempPath, mode);
  } catch {
    /* ignore */
  }
  renameSync(tempPath, authPath);
}

function placeholderEntry(
  dummyKey: string,
  accountId?: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    type: "api",
    key: dummyKey,
  };
  if (accountId) next.accountId = accountId;
  return next;
}

function needsRewrite(
  existing: unknown,
  dummyKey: string,
): existing is Record<string, unknown> {
  if (existing === undefined || existing === null) return false;
  if (typeof existing !== "object" || Array.isArray(existing)) return true;
  const entry = existing as Record<string, unknown>;
  if (entry.type !== "api") return true;
  if (entry.key !== dummyKey) return true;
  return false;
}

/**
 * Ensure auth.json has a provider entry so OpenCode calls auth.loader
 * (which injects dummy apiKey + customFetch).
 *
 * Always rewrites oauth / wrong-type entries to a non-secret api placeholder.
 * Pool tokens stay in multi-ai-accounts.json — never in auth.json.
 */
export function bootstrapHostAuthIfNeeded(
  providerId: string = PROVIDER_ID,
  dummyKey: string = DUMMY_API_KEY,
): boolean {
  try {
    const authPath = openCodeAuthPath();
    const auth = readAuthFile(authPath);
    if (!auth) return false;

    const existing = auth[providerId];
    if (existing !== undefined && !needsRewrite(existing, dummyKey)) {
      return false;
    }

    let accountId: string | undefined;
    if (
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      const prev = existing as Record<string, unknown>;
      if (typeof prev.accountId === "string") accountId = prev.accountId;
    }

    auth[providerId] = placeholderEntry(dummyKey, accountId);
    writeAuthFile(authPath, auth);
    logger.debug(
      `host-auth: wrote api placeholder for "${providerId}"` +
        (existing !== undefined ? " (rewrote prior entry)" : ""),
    );
    return true;
  } catch (err) {
    logger.warn(`host-auth bootstrap failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * After a successful OAuth login, force a non-secret host auth marker so
 * OpenCode keeps calling the loader (pool tokens stay in multi-ai-accounts).
 * Never leaves type=oauth in auth.json — expired host oauth sends dummy keys.
 */
export function ensureHostAuthAfterLogin(
  providerId: string = PROVIDER_ID,
  accountId?: string,
  dummyKey: string = DUMMY_API_KEY,
): void {
  try {
    const authPath = openCodeAuthPath();
    const auth = readAuthFile(authPath);
    if (!auth) return;

    let resolvedAccountId = accountId;
    const prev = auth[providerId];
    if (
      !resolvedAccountId &&
      prev !== null &&
      typeof prev === "object" &&
      !Array.isArray(prev)
    ) {
      const p = prev as Record<string, unknown>;
      if (typeof p.accountId === "string") resolvedAccountId = p.accountId;
    }

    auth[providerId] = placeholderEntry(dummyKey, resolvedAccountId);
    writeAuthFile(authPath, auth);
  } catch (err) {
    logger.debug(
      `host-auth after-login skipped: ${(err as Error).message}`,
    );
  }
}
