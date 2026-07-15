import { TOKEN_REFRESH_SKEW_MS } from "../constants.js";
import { logger } from "../../../core/logger.js";
import type { AccountMetadata } from "../../../core/schemas.js";
import { refreshTokens, type Tokens } from "./oauth.js";

/**
 * Single-flight token refresh, keyed by accountId.
 *
 * Concurrent requests for the same account share one in-flight refresh so we
 * never fire multiple refresh grants (which would each rotate the refresh
 * token and brick all but the last).
 *
 * CRITICAL ordering: the rotated tokens are persisted (atomic write) via the
 * caller-supplied `persist` callback BEFORE this function resolves. If the
 * process crashes mid-refresh, the newly rotated refresh token is already on
 * disk, so the account is never bricked.
 */

/**
 * Per-account in-flight refresh promises. This is a LOWER-LEVEL, in-process
 * backstop only. The authoritative cross-process single-flight now lives in
 * AccountManager.ensureFreshToken, which layers withCrossProcessTransaction
 * (an on-disk advisory lock + reload-under-lock) around this winner path so a
 * refresh is exclusive ACROSS processes, not just within one.
 */
const inFlight = new Map<string, Promise<Tokens>>();

/** Attempts to persist rotated tokens before giving up. */
const PERSIST_MAX_ATTEMPTS = 3;
/** Base backoff (ms) between persist retries. */
const PERSIST_RETRY_BACKOFF_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Persist rotated tokens with a few retries. If the server rotated the refresh
 * token but we fail to persist it, the new token is lost and the account is
 * bricked — so retry, and on final failure log LOUDLY (without ever logging the
 * token value) and rethrow so the caller does not treat the refresh as durable.
 */
async function persistWithRetry(
  accountId: string,
  tokens: Tokens,
  persist: (tokens: Tokens) => Promise<void>,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt++) {
    try {
      await persist(tokens);
      return;
    } catch (err) {
      lastErr = err;
      logger.warn(
        `persisting rotated tokens for ${accountId} failed (attempt ${attempt}/${PERSIST_MAX_ATTEMPTS}): ${(err as Error).message}`,
      );
      if (attempt < PERSIST_MAX_ATTEMPTS) {
        await delay(PERSIST_RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  logger.error(
    `CRITICAL: failed to persist a freshly rotated refresh token for ${accountId} after ${PERSIST_MAX_ATTEMPTS} attempts; the live refresh token is at risk of being lost and the account may be bricked (token value NOT logged)`,
  );
  throw lastErr;
}

/** True if the account's access token is still valid past the refresh skew. */
function accessTokenValid(account: AccountMetadata, now: number): boolean {
  if (!account.accessToken) return false;
  if (typeof account.expiresAt !== "number") return false;
  return account.expiresAt > now + TOKEN_REFRESH_SKEW_MS;
}

/**
 * Return fresh tokens for an account.
 *
 * - If the current access token is still valid (beyond the skew window), it is
 *   returned as-is without a network call.
 * - Otherwise a refresh is performed. Concurrent callers for the same account
 *   dedupe onto a single in-flight refresh.
 * - The `persist` callback is awaited (atomic write, with retry) BEFORE
 *   resolving, so the rotated refresh token is durable before it is ever used.
 * - On success the passed `account` object is ALSO mutated in place with the
 *   new accessToken / refreshToken / expiresAt.
 *
 * HARD CONTRACT: xAI rotates the refresh token on every grant, so there is
 * exactly one live refresh token at a time. Callers MUST treat the returned
 * Tokens (and the mutated `account`) as canonical and MUST NOT hold or reuse a
 * stale copy of the refresh token — sending an already-rotated-away refresh
 * token yields invalid_grant and would wrongly mark the account dead. The
 * Phase 3 pool must pass (and update) the single canonical account entry, never
 * a detached snapshot.
 *
 * @param account the account whose tokens to freshen; mutated in place on a
 *   successful refresh.
 * @param persist atomic persistence of the new tokens; must resolve only after
 *   the tokens are durably written.
 */
export async function getFreshTokens(
  account: AccountMetadata,
  persist: (tokens: Tokens) => Promise<void>,
): Promise<Tokens> {
  const now = Date.now();

  if (accessTokenValid(account, now)) {
    return {
      accessToken: account.accessToken as string,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt as number,
    };
  }

  const existing = inFlight.get(account.accountId);
  if (existing) {
    logger.debug(`joining in-flight refresh for ${account.accountId}`);
    return existing;
  }

  const run = (async (): Promise<Tokens> => {
    logger.debug(`refreshing tokens for ${account.accountId}`);
    const tokens = await refreshTokens(account.refreshToken);
    // The server has already rotated the refresh token: `tokens` now holds the
    // only live one. Persist (atomically) with retry BEFORE returning — if we
    // fail to durably store it, the rotated token is lost and the account is
    // bricked, so we try a few times before giving up loudly.
    await persistWithRetry(account.accountId, tokens, persist);
    // Mutate the passed account in place so a reused in-memory object stays
    // canonical (correct accessTokenValid checks + next refresh uses the new
    // refresh token, never the rotated-away one).
    account.accessToken = tokens.accessToken;
    account.refreshToken = tokens.refreshToken;
    account.expiresAt = tokens.expiresAt;
    return tokens;
  })();

  inFlight.set(account.accountId, run);
  try {
    return await run;
  } finally {
    inFlight.delete(account.accountId);
  }
}

/** Clear all in-flight refreshes (test helper). */
export function resetRefreshState(): void {
  inFlight.clear();
}
