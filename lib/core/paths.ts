import os from "node:os";
import path from "node:path";

/**
 * Shared filesystem paths + timeouts for the unified multi-ai pool.
 *
 * Account store is ONE file for both providers. Model caches stay per-provider
 * (added when models-sync lands). Settings path is reserved for later.
 */

/**
 * Timeout for OAuth/token HTTP requests. Node's fetch has no default timeout;
 * without this a hung request could wedge the single-flight refresh promise.
 *
 * Storage uses this to keep STALE_LOCK_MS strictly above the live-refresh
 * window so a mid-grant lock is never reclaimed.
 */
export const AUTH_FETCH_TIMEOUT_MS = 30_000;

/** Default global account storage path: ~/.config/opencode/multi-ai-accounts.json */
export function defaultStoragePath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-ai-accounts.json",
  );
}
