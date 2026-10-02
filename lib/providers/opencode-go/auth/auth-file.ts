import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { logger } from "../../../core/logger.js";
import { openCodeAuthPath } from "../../codex/auth/host-auth.js";
import { AUTH_JSON_KEY } from "../constants.js";

/**
 * Mirror the active opencode-go API key into OpenCode's auth.json under the
 * `opencode-go` entry (shape `{ type: "api", key }`), preserving every other
 * entry. Atomic: temp file + rename, 0600 mode (matching host-auth.ts).
 *
 * This is the manual config-file rotation path for opencode-go — the ONLY
 * provider that mirrors a pool key into auth.json by design; the built-in
 * `opencode-go` provider reads it directly on the next reload.
 */
export async function writeActiveKeyToAuthJson(key: string): Promise<void> {
  const authPath = openCodeAuthPath();
  let auth: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        auth = parsed as Record<string, unknown>;
      } else {
        logger.warn(
          "opencode-go: auth.json is not an object; replacing it with a fresh one",
        );
      }
    } catch (err) {
      logger.warn(
        `opencode-go: unreadable auth.json; replacing it: ${(err as Error).message}`,
      );
    }
  }
  auth[AUTH_JSON_KEY] = { type: "api", key };

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
