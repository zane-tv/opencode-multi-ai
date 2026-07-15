import type { AccountMetadata } from "../core/schemas.js";
import {
  accountDisplayName,
  shortAccountId,
} from "../core/tui-status.js";

/**
 * Resolve an `index` OR `id` argument to a single account from a pool snapshot.
 *
 * Rules (in priority order):
 *   - If `index` is provided, it is a 0-based position into `accounts`;
 *     out-of-bounds throws a clear error.
 *   - Else if `id` is provided, match by EXACT accountId first; if none match
 *     exactly, fall back to a unique prefix match (convenience for long ids).
 *     An ambiguous prefix (>1 match) throws rather than picking arbitrarily.
 *   - If neither is provided, throw (the caller must supply one).
 *
 * Pure and synchronous: callers pass `view.list()` (provider-scoped) and act
 * on the returned account's id.
 */
export function resolveAccount(
  accounts: AccountMetadata[],
  args: { index?: number; id?: string },
): AccountMetadata {
  const { index, id } = args;

  if (typeof index === "number") {
    if (!Number.isInteger(index) || index < 0 || index >= accounts.length) {
      throw new Error(
        `index ${index} is out of range (pool has ${accounts.length} account(s), valid 0..${accounts.length - 1})`,
      );
    }
    return accounts[index]!;
  }

  if (typeof id === "string" && id.length > 0) {
    const exact = accounts.find((a) => a.accountId === id);
    if (exact) return exact;

    const matches = accounts.filter((a) => a.accountId.startsWith(id));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new Error(`no account matches id or prefix "${id}"`);
    }
    throw new Error(
      `id prefix "${id}" is ambiguous (${matches.length} matches: ${matches
        .map((a) => shortId(a.accountId))
        .join(", ")}); provide more characters or use --index`,
    );
  }

  throw new Error("provide either an `index` or an `id` to select an account");
}

/** A short, log-safe rendering of an account id (never a token). */
export function shortId(accountId: string): string {
  return shortAccountId(accountId);
}

export { accountDisplayName };
