/**
 * OpenCode only invokes plugin auth.loader when auth.json has an entry for the
 * provider id (same bootstrap pattern as opencode-kiro-auth).
 *
 * Account pool truth lives in multi-codex-accounts.json; this file only seeds a
 * placeholder so customFetch is wired. Never stores real tokens here.
 */

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

/**
 * Ensure auth.json has a codex-multi entry so OpenCode calls auth.loader
 * (which injects dummy apiKey + customFetch). Idempotent.
 */
export function bootstrapHostAuthIfNeeded(
  providerId: string = PROVIDER_ID,
): boolean {
  try {
    const authPath = openCodeAuthPath();
    const auth = readAuthFile(authPath);
    if (!auth) return false;
    if (auth[providerId] !== undefined) return false;

    auth[providerId] = {
      type: "api",
      key: DUMMY_API_KEY,
    };
    writeAuthFile(authPath, auth);
    logger.debug(
      `host-auth: wrote placeholder auth entry for "${providerId}"`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `host-auth bootstrap failed: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * After a successful OAuth login, mirror a non-secret host auth marker so
 * OpenCode keeps calling the loader (pool tokens stay in multi-codex-accounts).
 */
export function ensureHostAuthAfterLogin(
  providerId: string = PROVIDER_ID,
  accountId?: string,
): void {
  try {
    const authPath = openCodeAuthPath();
    const auth = readAuthFile(authPath);
    if (!auth) return;

    const prev = auth[providerId];
    const next: Record<string, unknown> = {
      type: "api",
      key: DUMMY_API_KEY,
    };
    if (accountId) next.accountId = accountId;
    // Preserve oauth shape if user logged via opencode auth login, but always
    // ensure type is present so loader runs.
    if (prev && typeof prev === "object" && !Array.isArray(prev)) {
      const p = prev as Record<string, unknown>;
      if (p.type === "oauth") {
        // Keep existing oauth tokens if host already has them; still fine.
        return;
      }
    }
    auth[providerId] = next;
    writeAuthFile(authPath, auth);
  } catch (err) {
    logger.debug(
      `host-auth after-login skipped: ${(err as Error).message}`,
    );
  }
}
