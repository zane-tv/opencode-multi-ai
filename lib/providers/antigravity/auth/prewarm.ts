import type { AccountManager } from "../../../core/accounts.js";
import { logger } from "../../../core/logger.js";

const PREWARM_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const PREWARM_INTERVAL_MS = 10 * 60 * 1000; // Run check every 10 minutes

let prewarmTimer: ReturnType<typeof setInterval> | null = null;
let isPrewarming = false;

/**
 * Proactively checks all Antigravity accounts in the pool.
 * If an account's access token is expired or within 5 minutes of expiring,
 * refreshes it in the background so that user chat requests never experience
 * synchronous OAuth refresh latency.
 */
export async function prewarmAntigravityAccounts(manager: AccountManager): Promise<void> {
  if (isPrewarming) return;
  isPrewarming = true;

  try {
    const accounts = manager.list("antigravity");
    const now = Date.now();

    for (const acc of accounts) {
      if (!acc.enabled || acc.subscriptionStatus === "dead" || !acc.refreshToken) {
        continue;
      }

      const hasExpiry = typeof acc.expiresAt === "number";
      const isNearExpiry = !hasExpiry || acc.expiresAt! <= now + PREWARM_EXPIRY_BUFFER_MS;

      if (isNearExpiry) {
        try {
          logger.debug(`[antigravity-prewarm] Pre-refreshing token for ${acc.email || acc.accountId.slice(0, 8)}...`);
          await manager.ensureFreshToken("antigravity", acc.accountId);
          logger.debug(`[antigravity-prewarm] Token fresh for ${acc.email || acc.accountId.slice(0, 8)}`);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes("invalid_grant")) {
            await manager.markDeadCandidate("antigravity", acc.accountId);
            logger.warn(`[antigravity-prewarm] Account ${acc.email || acc.accountId} marked dead (invalid_grant)`);
          } else {
            logger.debug(`[antigravity-prewarm] Background refresh error for ${acc.accountId}: ${msg}`);
          }
        }
        // Small 100ms pause between accounts to avoid spiking system/network resources
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } catch (err) {
    logger.debug(`[antigravity-prewarm] Error during prewarm run: ${(err as Error).message}`);
  } finally {
    isPrewarming = false;
  }
}

/**
 * Starts the background prewarm worker for Antigravity accounts.
 * Executes an initial prewarm pass after a short delay (500ms) and
 * schedules periodic checks every 10 minutes.
 * The timer is unref'd so it does not block the Node/Bun process from exiting.
 */
export function startAntigravityBackgroundPrewarm(manager: AccountManager): void {
  // Run initial pass shortly after startup (fire-and-forget, non-blocking)
  setTimeout(() => {
    void prewarmAntigravityAccounts(manager);
  }, 500).unref?.();

  // Schedule periodic background heartbeat
  if (!prewarmTimer) {
    prewarmTimer = setInterval(() => {
      void prewarmAntigravityAccounts(manager);
    }, PREWARM_INTERVAL_MS);
    prewarmTimer.unref?.();
  }
}

export function stopAntigravityBackgroundPrewarm(): void {
  if (prewarmTimer) {
    clearInterval(prewarmTimer);
    prewarmTimer = null;
  }
}
