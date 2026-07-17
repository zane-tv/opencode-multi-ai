/**
 * Pure status-line renderer for an account pool (provider-agnostic).
 *
 * WHY THIS IS A STANDALONE PURE FUNCTION:
 * The installed `@opencode-ai/plugin` Hooks interface exposes NO statusline
 * hook to a SERVER plugin. We build the status content as a pure,
 * side-effect-free function over read-only pool state; rendered on demand by
 * status tools and ready for a real status-line slot if one lands.
 *
 * INVARIANTS:
 *   - PURE: no I/O, no logging, no Date.now() (the caller passes `now`).
 *   - NEVER emits a token value (only ids/labels/emails/counts).
 *   - Does NOT depend on AccountManager (todo 8) — eligibility is inlined.
 */

/** Minimal account shape for status rendering (shared fields only). */
export interface StatusAccount {
  accountId: string;
  email?: string;
  label?: string;
  enabled: boolean;
  subscriptionStatus: "active" | "dead" | "unknown";
  flaggedForRemoval: boolean;
  entitlementBlocked: boolean;
  quotaResetAt?: number;
  coolingDownUntil?: number;
}

/** A structured summary of pool state (also useful for tests / future slots). */
export interface PoolStatusSummary {
  /** Total accounts in the pool. */
  total: number;
  /** Accounts currently selectable (enabled, not dead/blocked/quota/cooling). */
  ready: number;
  /** Accounts with a future quotaResetAt. */
  quotaExhausted: number;
  /** Accounts with a future coolingDownUntil. */
  cooling: number;
  /** Accounts hit by a permanent entitlement / allowlist gate. */
  entitlementBlocked: number;
  /** Accounts whose subscription is terminally dead. */
  dead: number;
  /** Accounts explicitly flagged for removal. */
  flagged: number;
  /** Accounts disabled by the user. */
  disabled: number;
}

export interface RenderStatusOptions {
  /**
   * Prefix for the line (`xai`, `codex`, `ai`, …).
   * Default: `ai`.
   */
  prefix?: string;
  /**
   * Prune command name shown in the warning badge.
   * Default: `${prefix}-prune`.
   */
  pruneCommand?: string;
}

/**
 * Selection eligibility (mirrors AccountManager.isSelectable once todo 8
 * lands). Pure: pass epoch ms as `now`.
 */
export function isSelectableAccount(
  account: StatusAccount,
  now: number,
): boolean {
  if (!account.enabled) return false;
  if (account.subscriptionStatus === "dead") return false;
  if (account.entitlementBlocked) return false;
  if (typeof account.quotaResetAt === "number" && account.quotaResetAt > now) {
    return false;
  }
  if (
    typeof account.coolingDownUntil === "number" &&
    account.coolingDownUntil > now
  ) {
    return false;
  }
  return true;
}

/** A short, log-safe rendering of an account id (never a token). */
export function shortAccountId(accountId: string): string {
  return accountId.length > 12 ? `${accountId.slice(0, 12)}…` : accountId;
}

/** Display name: label, else email, else short id (never a token). */
export function accountDisplayName(a: {
  label?: string;
  email?: string;
  accountId: string;
}): string {
  const label = a.label?.trim();
  if (label) return label;
  const email = a.email?.trim();
  if (email) return email;
  return shortAccountId(a.accountId);
}

/**
 * Compute a structured status summary over a pool snapshot. Pure: pass the
 * current epoch ms as `now`.
 */
export function summarizePool(
  accounts: StatusAccount[],
  now: number,
): PoolStatusSummary {
  const summary: PoolStatusSummary = {
    total: accounts.length,
    ready: 0,
    quotaExhausted: 0,
    cooling: 0,
    entitlementBlocked: 0,
    dead: 0,
    flagged: 0,
    disabled: 0,
  };

  for (const a of accounts) {
    if (isSelectableAccount(a, now)) summary.ready++;
    if (typeof a.quotaResetAt === "number" && a.quotaResetAt > now) {
      summary.quotaExhausted++;
    }
    if (typeof a.coolingDownUntil === "number" && a.coolingDownUntil > now) {
      summary.cooling++;
    }
    if (a.entitlementBlocked) summary.entitlementBlocked++;
    if (a.subscriptionStatus === "dead") summary.dead++;
    if (a.flaggedForRemoval) summary.flagged++;
    if (!a.enabled) summary.disabled++;
  }

  return summary;
}

/**
 * Render a compact one-line status string for the account pool.
 *
 * Shape (empty pool):        `<prefix>: no accounts`
 * Shape (normal):            `<prefix>: <active> · 3 ready · 1 quota · 1 cooling`
 * Shape (with warning):      `<prefix>: <active> · 2 ready · ⚠ 1 dead, 1 flagged`
 *
 * `activeIndex` selects the active account label; an out-of-range index (e.g.
 * the pool changed) degrades gracefully to no active-name segment.
 */
export function renderStatusLine(
  accounts: StatusAccount[],
  activeIndex: number,
  now: number,
  options: RenderStatusOptions = {},
): string {
  const prefix = options.prefix ?? "ai";
  const pruneCommand = options.pruneCommand ?? `${prefix}-prune`;

  if (accounts.length === 0) return `${prefix}: no accounts`;

  const summary = summarizePool(accounts, now);
  const segments: string[] = [];

  const active = accounts[activeIndex];
  if (active) segments.push(`★ ACTIVE ${accountDisplayName(active)}`);

  segments.push(`${summary.ready} ready`);
  if (summary.quotaExhausted > 0) {
    segments.push(`${summary.quotaExhausted} quota`);
  }
  if (summary.cooling > 0) segments.push(`${summary.cooling} cooling`);
  if (summary.entitlementBlocked > 0) {
    segments.push(`${summary.entitlementBlocked} blocked`);
  }
  if (summary.disabled > 0) segments.push(`${summary.disabled} disabled`);

  // Warning badge ties to the prune feature: dead subscriptions or manual flags
  // are the two prune criteria, so surface them prominently.
  const warnParts: string[] = [];
  if (summary.dead > 0) warnParts.push(`${summary.dead} dead`);
  if (summary.flagged > 0) warnParts.push(`${summary.flagged} flagged`);
  if (warnParts.length > 0) {
    segments.push(`⚠ ${warnParts.join(", ")} (run ${pruneCommand})`);
  }

  return `${prefix}: ${segments.join(" · ")}`;
}
