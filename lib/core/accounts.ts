import { logger } from "./logger.js";
import { migrateAccountsIfNeeded } from "../migrate.js";
import { defaultStoragePath } from "./paths.js";
import type {
  AccountMetadata,
  AccountOf,
  AccountSelectionStrategy,
  AccountStorage,
  CooldownReason,
  ProviderKind,
} from "./schemas.js";
import {
  backupAccounts,
  loadAccounts,
  withCrossProcessTransaction,
} from "./storage.js";

const MAX_ACCOUNTS_PER_PROVIDER = 20;
const TOKEN_REFRESH_SKEW_MS = 60_000;

type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

/** Legacy refresh signature (refresh token only). Normalized to a driver. */
export type RefreshFn = (refreshToken: string) => Promise<Tokens>;

/** Refresh driver: gets the full narrowed account (kiro needs more than the token). */
export interface RefreshDriver<P extends ProviderKind> {
  refresh(account: AccountOf<P>, ctx: { force: boolean }): Promise<Tokens>;
}

export type RefreshDrivers = {
  [P in ProviderKind]?: RefreshDriver<P>;
};

export type RefreshInput<P extends ProviderKind> = RefreshFn | RefreshDriver<P>;
export type RefreshInputs = {
  [P in ProviderKind]?: RefreshInput<P>;
};

function toRefreshDriver<P extends ProviderKind>(
  input: RefreshInput<P>,
): RefreshDriver<P> {
  if (typeof input === "function") {
    return { refresh: (account) => input(account.refreshToken) };
  }
  return input;
}

/** OAuth refresh map for plugins/tools/CLI/TUI (dynamic import avoids cycles). */
export function createDefaultRefreshHandlers(): RefreshDrivers {
  return {
    xai: {
      refresh: async (account) => {
        const { refreshTokens } = await import(
          "../providers/xai/auth/oauth.js"
        );
        return refreshTokens(account.refreshToken);
      },
    },
    codex: {
      refresh: async (account) => {
        const { refreshTokens } = await import(
          "../providers/codex/auth/oauth.js"
        );
        return refreshTokens(account.refreshToken);
      },
    },
    kiro: {
      refresh: async (account) => {
        const { refreshKiroAccount } = await import(
          "../providers/kiro/auth/refresh.js"
        );
        return refreshKiroAccount(account);
      },
    },
  };
}

type RateLimitSnapshot = {
  readonly limitRequests?: number;
  readonly remainingRequests?: number;
  readonly limitTokens?: number;
  readonly remainingTokens?: number;
  readonly costInUsdTicks?: number;
  readonly observedAt?: number;
};

type BillingQuotaSnapshot = {
  readonly monthlyUsedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAtMs?: number;
  readonly observedAt?: number;
};

type PlanSnapshot = {
  readonly planTier?: number;
  readonly planName: string;
  readonly planMonthlyLimit?: number;
  readonly planUsed?: number;
  readonly planPeriodStartMs?: number;
  readonly planPeriodEndMs?: number;
  readonly observedAt?: number;
};

type UsageSnapshot = {
  readonly planType?: string;
  readonly primaryUsedPercent?: number;
  readonly primaryWindowMinutes?: number;
  readonly primaryResetAt?: number;
  readonly secondaryUsedPercent?: number;
  readonly secondaryWindowMinutes?: number;
  readonly secondaryResetAt?: number;
  readonly activeLimit?: string;
  readonly observedAt?: number;
};

type KiroUsageSnapshot = {
  readonly usedCount?: number;
  readonly limitCount?: number;
  readonly email?: string;
  readonly observedAt?: number;
};

export interface ProviderAccountView {
  readonly provider: ProviderKind;
  list(): AccountMetadata[];
  get(id: string): AccountMetadata | undefined;
  sticky(): string | undefined;
  selectAccount(
    attempted: Set<string>,
    policy?: AccountSelectionStrategy,
  ): AccountMetadata | null;
  add(account: AccountMetadata): Promise<void>;
  remove(id: string): Promise<void>;
  upsertFromOAuth(account: AccountMetadata): Promise<"added" | "updated">;
  ensureFreshToken(id: string, force?: boolean): Promise<Tokens>;
  markQuotaExhausted(id: string, resetAt: number): Promise<void>;
  markEntitlementBlocked(id: string): Promise<void>;
  markDeadCandidate(id: string): Promise<void>;
  recordCooldown(
    id: string,
    reason: CooldownReason,
    until: number,
  ): Promise<void>;
  touchLastUsed(id: string): Promise<void>;
  recordRateLimit(id: string, snap: RateLimitSnapshot): Promise<void>;
  recordBillingQuota(id: string, snap: BillingQuotaSnapshot): Promise<void>;
  recordPlan(id: string, snap: PlanSnapshot): Promise<void>;
  recordUsage(id: string, snap: UsageSnapshot): Promise<void>;
  recordKiroUsage(id: string, snap: KiroUsageSnapshot): Promise<void>;
  switchTo(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setLabel(id: string, label?: string): Promise<void>;
  setTags(id: string, tags: string[]): Promise<void>;
  setNote(id: string, note?: string): Promise<void>;
  setEmail(id: string, email: string): Promise<void>;
  setPriority(id: string, priority: number): Promise<void>;
  movePriority(id: string, direction: "up" | "down"): Promise<void>;
  moveToFront(id: string): Promise<void>;
  setFlaggedForRemoval(id: string, flagged: boolean): Promise<void>;
  prunableAccounts(): AccountMetadata[];
  deadAccounts(): AccountMetadata[];
  cleanDeadAccounts(): Promise<{ removed: string[] }>;
  pruneAccounts(ids: string[]): Promise<{ removed: string[] }>;
}

function identityKey(provider: ProviderKind, id: string): string {
  return `${provider}:${id}`;
}

function matchesIdentity(
  account: AccountMetadata,
  provider: ProviderKind,
  id: string,
): boolean {
  return account.provider === provider && account.accountId === id;
}

function validTokens(account: AccountMetadata, now: number): Tokens | null {
  if (!account.accessToken) return null;
  if (typeof account.expiresAt !== "number") return null;
  if (account.expiresAt <= now + TOKEN_REFRESH_SKEW_MS) return null;
  return {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
  };
}

export function isSelectable(account: AccountMetadata, now: number): boolean {
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

export function isRotationReady(
  account: AccountMetadata,
  now: number,
): boolean {
  if (!isSelectable(account, now)) return false;

  if (account.provider === "codex") {
    const primaryFull =
      typeof account.primaryUsedPercent === "number" &&
      account.primaryUsedPercent >= 100;
    if (primaryFull) {
      const secondaryOpen =
        typeof account.secondaryWindowMinutes === "number" &&
        account.secondaryWindowMinutes > 0 &&
        typeof account.secondaryUsedPercent === "number" &&
        account.secondaryUsedPercent < 100;
      if (!secondaryOpen) return false;
    }
  }

  if (account.provider === "xai") {
    const rem = account.billingRemainingPercent;
    if (typeof rem === "number" && rem <= 0) return false;
    if (
      typeof account.planUsed === "number" &&
      typeof account.planMonthlyLimit === "number" &&
      account.planMonthlyLimit > 0 &&
      account.planUsed >= account.planMonthlyLimit
    ) {
      return false;
    }
  }

  if (account.provider === "kiro") {
    if (
      typeof account.usedCount === "number" &&
      typeof account.limitCount === "number" &&
      account.limitCount > 0 &&
      account.usedCount >= account.limitCount
    ) {
      return false;
    }
  }

  return true;
}

export function resolveActiveAccount(
  storage: AccountStorage,
  provider: ProviderKind,
  now: number = Date.now(),
): AccountMetadata | undefined {
  const pool = storage.accounts.filter(
    (account) => account.provider === provider,
  );
  if (pool.length === 0) return undefined;

  const ready = pool.filter((account) => isRotationReady(account, now));
  const stickyId = storage.sticky[provider];
  if (stickyId) {
    const sticky = ready.find((account) => account.accountId === stickyId);
    if (sticky) return sticky;
  }

  if (ready.length > 0) {
    return ready.reduce((best, candidate) => {
      if (candidate.priority !== best.priority) {
        return candidate.priority > best.priority ? candidate : best;
      }
      if (candidate.lastUsed !== best.lastUsed) {
        return candidate.lastUsed > best.lastUsed ? candidate : best;
      }
      return candidate.addedAt < best.addedAt ? candidate : best;
    });
  }

  if (stickyId) {
    const sticky = pool.find((account) => account.accountId === stickyId);
    if (sticky && sticky.enabled && sticky.subscriptionStatus !== "dead") {
      return sticky;
    }
  }

  const alive = pool.filter(
    (account) =>
      account.enabled && account.subscriptionStatus !== "dead",
  );
  return alive[0] ?? pool[0];
}

/**
 * Lower rank = earlier in list. Ready/active first, then cooling/quota,
 * disabled/entitlement, dead last. Within a rank: priority DESC, addedAt ASC.
 */
export function accountHealthRank(
  account: AccountMetadata,
  now: number,
): number {
  if (account.subscriptionStatus === "dead") return 40;
  if (account.entitlementBlocked) return 30;
  if (!account.enabled) return 25;
  if (typeof account.quotaResetAt === "number" && account.quotaResetAt > now) {
    return 20;
  }
  if (
    typeof account.coolingDownUntil === "number" &&
    account.coolingDownUntil > now
  ) {
    return 10;
  }
  return 0;
}

function sortAccountsByPriority(
  storage: AccountStorage,
  now: number = Date.now(),
): void {
  storage.accounts.sort((left, right) => {
    const healthDelta =
      accountHealthRank(left, now) - accountHealthRank(right, now);
    if (healthDelta !== 0) return healthDelta;
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.addedAt - right.addedAt;
  });
}

function clearSticky(storage: AccountStorage, provider: ProviderKind): void {
  delete storage.sticky[provider];
}

function demoteAccountInProvider(
  storage: AccountStorage,
  provider: ProviderKind,
  account: AccountMetadata,
): void {
  const providerAccounts = storage.accounts.filter(
    (candidate) => candidate.provider === provider,
  );
  const minimumPriority = Math.min(
    ...providerAccounts.map((candidate) => candidate.priority),
  );
  account.priority = minimumPriority - 1;
  sortAccountsByPriority(storage);
}

function switchStickyIfUnselectable(
  storage: AccountStorage,
  provider: ProviderKind,
  id: string,
  now: number = Date.now(),
): void {
  if (storage.sticky[provider] !== id) return;
  const account = storage.accounts.find((candidate) =>
    matchesIdentity(candidate, provider, id),
  );
  if (account && isSelectable(account, now)) return;
  const replacement = storage.accounts.find(
    (candidate) =>
      candidate.provider === provider && isSelectable(candidate, now),
  );
  if (replacement) storage.sticky[provider] = replacement.accountId;
  else clearSticky(storage, provider);
}

function mergeOAuthAccount(
  current: AccountMetadata,
  incoming: AccountMetadata,
): void {
  current.refreshToken = incoming.refreshToken;
  current.accessToken = incoming.accessToken;
  current.expiresAt = incoming.expiresAt;
  if (incoming.email !== undefined) current.email = incoming.email;
  if (incoming.label !== undefined) current.label = incoming.label;
  if (incoming.oauthScope !== undefined) current.oauthScope = incoming.oauthScope;
  current.subscriptionStatus = "active";
  current.entitlementBlocked = false;
  current.enabled = true;

  if (current.provider === "xai" && incoming.provider === "xai") {
    if (incoming.planTier !== undefined) current.planTier = incoming.planTier;
    if (incoming.planName !== undefined) current.planName = incoming.planName;
    if (incoming.planMonthlyLimit !== undefined) {
      current.planMonthlyLimit = incoming.planMonthlyLimit;
    }
    if (incoming.planUsed !== undefined) current.planUsed = incoming.planUsed;
    if (incoming.planPeriodStartMs !== undefined) {
      current.planPeriodStartMs = incoming.planPeriodStartMs;
    }
    if (incoming.planPeriodEndMs !== undefined) {
      current.planPeriodEndMs = incoming.planPeriodEndMs;
    }
    if (incoming.planObservedAt !== undefined) {
      current.planObservedAt = incoming.planObservedAt;
    }
    return;
  }

  if (current.provider === "codex" && incoming.provider === "codex") {
    if (incoming.organizationId !== undefined) {
      current.organizationId = incoming.organizationId;
    }
    if (incoming.planType !== undefined) current.planType = incoming.planType;
    if (incoming.primaryUsedPercent !== undefined) {
      current.primaryUsedPercent = incoming.primaryUsedPercent;
    }
    if (incoming.primaryWindowMinutes !== undefined) {
      current.primaryWindowMinutes = incoming.primaryWindowMinutes;
    }
    if (incoming.primaryResetAt !== undefined) {
      current.primaryResetAt = incoming.primaryResetAt;
    }
    if (incoming.secondaryUsedPercent !== undefined) {
      current.secondaryUsedPercent = incoming.secondaryUsedPercent;
    }
    if (incoming.secondaryWindowMinutes !== undefined) {
      current.secondaryWindowMinutes = incoming.secondaryWindowMinutes;
    }
    if (incoming.secondaryResetAt !== undefined) {
      current.secondaryResetAt = incoming.secondaryResetAt;
    }
    if (incoming.activeLimit !== undefined) {
      current.activeLimit = incoming.activeLimit;
    }
    if (incoming.usageObservedAt !== undefined) {
      current.usageObservedAt = incoming.usageObservedAt;
    }
    return;
  }

  if (current.provider === "kiro" && incoming.provider === "kiro") {
    current.authMethod = incoming.authMethod;
    current.region = incoming.region;
    if (incoming.oidcRegion !== undefined) current.oidcRegion = incoming.oidcRegion;
    if (incoming.clientId !== undefined) current.clientId = incoming.clientId;
    if (incoming.clientSecret !== undefined) {
      current.clientSecret = incoming.clientSecret;
    }
    if (incoming.profileArn !== undefined) current.profileArn = incoming.profileArn;
    if (incoming.startUrl !== undefined) current.startUrl = incoming.startUrl;
    if (incoming.tokenEndpoint !== undefined) {
      current.tokenEndpoint = incoming.tokenEndpoint;
    }
    if (incoming.credentialSource !== undefined) {
      current.credentialSource = incoming.credentialSource;
    }
    if (incoming.externalSyncAt !== undefined) {
      current.externalSyncAt = incoming.externalSyncAt;
    }
    if (incoming.usedCount !== undefined) current.usedCount = incoming.usedCount;
    if (incoming.limitCount !== undefined) current.limitCount = incoming.limitCount;
    if (incoming.usageObservedAt !== undefined) {
      current.usageObservedAt = incoming.usageObservedAt;
    }
  }
}

// allow: SIZE_OK — this cohesive manager intentionally mirrors the full tested
// account-management surface in one module, matching the source managers.
export class AccountManager {
  private readonly storagePath: string | undefined;
  private readonly refreshByProvider: RefreshDrivers;
  private storage: AccountStorage | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly freshInFlight = new Map<string, Promise<Tokens>>();

  constructor(storagePath?: string, refresh: RefreshInputs = {}) {
    this.storagePath = storagePath;
    const drivers: RefreshDrivers = {};
    if (refresh.xai !== undefined) {
      drivers.xai = toRefreshDriver<"xai">(refresh.xai);
    }
    if (refresh.codex !== undefined) {
      drivers.codex = toRefreshDriver<"codex">(refresh.codex);
    }
    if (refresh.kiro !== undefined) {
      drivers.kiro = toRefreshDriver<"kiro">(refresh.kiro);
    }
    this.refreshByProvider = drivers;
  }

  async load(): Promise<void> {
    if (this.storage) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    const pending = (async () => {
      await migrateAccountsIfNeeded({ unifiedPath: this.storagePath });
      // Storage-version upgrades run under the cross-process lock before adoption.
      const storage = await loadAccounts(this.storagePath);
      sortAccountsByPriority(storage);
      this.adoptStorage(storage);
      logger.debug(
        `AccountManager loaded ${storage.accounts.length} account(s)`,
      );
    })();
    this.loadPromise = pending;
    try {
      await pending;
    } finally {
      if (this.loadPromise === pending) this.loadPromise = null;
    }
  }

  async reloadFromDisk(): Promise<void> {
    this.storage = null;
    this.loadPromise = null;
    await this.load();
  }

  list(provider: ProviderKind): AccountMetadata[] {
    return (
      this.storage?.accounts.filter(
        (account) => account.provider === provider,
      ) ?? []
    );
  }

  listAll(): AccountMetadata[] {
    return this.storage ? [...this.storage.accounts] : [];
  }

  get(provider: ProviderKind, id: string): AccountMetadata | undefined {
    return this.storage?.accounts.find((account) =>
      matchesIdentity(account, provider, id),
    );
  }

  sticky(provider: ProviderKind): string | undefined {
    return this.storage?.sticky[provider];
  }

  selectAccount(
    provider: ProviderKind,
    attempted: Set<string>,
    policy: AccountSelectionStrategy = "sticky",
  ): AccountMetadata | null {
    const storage = this.storage;
    if (!storage) return null;
    const now = Date.now();
    const eligible = (account: AccountMetadata): boolean =>
      account.provider === provider &&
      isRotationReady(account, now) &&
      !attempted.has(account.accountId);

    const stickyId = storage.sticky[provider];
    if (policy === "sticky" && stickyId !== undefined) {
      const current = storage.accounts.find(
        (account) =>
          matchesIdentity(account, provider, stickyId) && eligible(account),
      );
      if (current) return current;
    }

    const next = this.pickByPolicy(storage, provider, eligible, policy);
    if (!next) return null;
    storage.sticky[provider] = next.accountId;
    logger.debug(
      `selectAccount switched ${provider} sticky to ${next.accountId} (${policy})`,
    );
    return next;
  }

  private pickByPolicy(
    storage: AccountStorage,
    provider: ProviderKind,
    eligible: (account: AccountMetadata) => boolean,
    policy: AccountSelectionStrategy,
  ): AccountMetadata | null {
    const pool = storage.accounts.filter(eligible);
    if (pool.length === 0) return null;

    if (policy === "lowest-usage") {
      return pool.reduce((best, candidate) => {
        const bestUsed = best.provider === "kiro" ? best.usedCount ?? 0 : 0;
        const candUsed =
          candidate.provider === "kiro" ? candidate.usedCount ?? 0 : 0;
        if (candUsed !== bestUsed) return candUsed < bestUsed ? candidate : best;
        if (candidate.lastUsed !== best.lastUsed) {
          return candidate.lastUsed < best.lastUsed ? candidate : best;
        }
        return best;
      });
    }

    if (policy === "round-robin") {
      const stickyId = storage.sticky[provider];
      if (stickyId !== undefined) {
        const cursor = storage.accounts.findIndex((account) =>
          matchesIdentity(account, provider, stickyId),
        );
        if (cursor !== -1) {
          const ordered = [
            ...storage.accounts.slice(cursor + 1),
            ...storage.accounts.slice(0, cursor + 1),
          ];
          const rotated = ordered.find(eligible);
          if (rotated) return rotated;
        }
      }
      return pool[0] ?? null;
    }

    return pool[0] ?? null;
  }

  async add(account: AccountMetadata): Promise<void> {
    await this.mutateStorage((storage) => {
      if (
        storage.accounts.some((candidate) =>
          matchesIdentity(candidate, account.provider, account.accountId),
        )
      ) {
        throw new Error(
          `account ${identityKey(account.provider, account.accountId)} already exists`,
        );
      }
      if (
        storage.accounts.filter(
          (candidate) => candidate.provider === account.provider,
        ).length >= MAX_ACCOUNTS_PER_PROVIDER
      ) {
        throw new Error(
          `cannot add account: ${account.provider} pool is at the maximum of ${MAX_ACCOUNTS_PER_PROVIDER} accounts`,
        );
      }
      storage.accounts.push(account);
    });
  }

  async remove(provider: ProviderKind, id: string): Promise<void> {
    await this.ensureLoaded();
    await backupAccounts(this.storagePath);
    await this.mutateStorage((storage) => {
      const index = storage.accounts.findIndex((account) =>
        matchesIdentity(account, provider, id),
      );
      if (index === -1) return;
      storage.accounts.splice(index, 1);
      if (storage.sticky[provider] === id) clearSticky(storage, provider);
    });
  }

  async upsertFromOAuth(
    provider: ProviderKind,
    account: AccountMetadata,
  ): Promise<"added" | "updated"> {
    if (account.provider !== provider) {
      throw new Error(
        `cannot upsert ${account.provider} account through ${provider} provider`,
      );
    }

    let outcome: "added" | "updated" = "added";
    await this.mutateStorage((storage) => {
      const current = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, account.accountId),
      );
      if (current) {
        outcome = "updated";
        mergeOAuthAccount(current, account);
        return;
      }
      if (
        storage.accounts.filter((candidate) => candidate.provider === provider)
          .length >= MAX_ACCOUNTS_PER_PROVIDER
      ) {
        throw new Error(
          `cannot add account: ${provider} pool is at the maximum of ${MAX_ACCOUNTS_PER_PROVIDER} accounts`,
        );
      }
      storage.accounts.push(account);
    });
    return outcome;
  }

  async ensureFreshToken(
    provider: ProviderKind,
    id: string,
    force = false,
  ): Promise<Tokens> {
    await this.ensureLoaded();
    const account = this.get(provider, id);
    if (!account) {
      throw new Error(
        `ensureFreshToken: unknown account ${identityKey(provider, id)}`,
      );
    }

    const staleAccessToken = force ? account.accessToken : undefined;
    if (!force) {
      const current = validTokens(account, Date.now());
      if (current) return current;
    }

    const key = identityKey(provider, id);
    const existing = this.freshInFlight.get(key);
    if (existing) {
      logger.debug(`ensureFreshToken joining in-flight refresh for ${key}`);
      return existing;
    }

    const pending = this.refreshUnderLock(
      provider,
      id,
      force,
      staleAccessToken,
    );
    this.freshInFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.freshInFlight.get(key) === pending) {
        this.freshInFlight.delete(key);
      }
    }
  }

  async markQuotaExhausted(
    provider: ProviderKind,
    id: string,
    resetAt: number,
  ): Promise<void> {
    await this.mutateStorage((storage) => {
      const account = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) {
        logger.warn(
          `markQuotaExhausted: account ${identityKey(provider, id)} not found; skipping`,
        );
        return;
      }

      account.quotaResetAt = resetAt;
      account.lastSwitchReason = "quota-exhausted";
      demoteAccountInProvider(storage, provider, account);
      switchStickyIfUnselectable(storage, provider, id);
    });
  }

  async markEntitlementBlocked(
    provider: ProviderKind,
    id: string,
  ): Promise<void> {
    await this.mutateStorage((storage) => {
      const account = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) {
        logger.warn(
          `markEntitlementBlocked: account ${identityKey(provider, id)} not found; skipping`,
        );
        return;
      }
      account.entitlementBlocked = true;
      demoteAccountInProvider(storage, provider, account);
      switchStickyIfUnselectable(storage, provider, id);
    });
  }

  async markDeadCandidate(
    provider: ProviderKind,
    id: string,
  ): Promise<void> {
    const now = Date.now();
    await this.mutateStorage((storage) => {
      const account = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) {
        logger.warn(
          `markDeadCandidate: account ${identityKey(provider, id)} not found; skipping`,
        );
        return;
      }
      account.subscriptionStatus = "dead";
      account.subscriptionCheckedAt = now;
      demoteAccountInProvider(storage, provider, account);
      switchStickyIfUnselectable(storage, provider, id, now);
    });
  }

  async recordCooldown(
    provider: ProviderKind,
    id: string,
    reason: CooldownReason,
    until: number,
  ): Promise<void> {
    await this.mutateStorage((storage) => {
      const account = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) {
        logger.warn(
          `recordCooldown: account ${identityKey(provider, id)} not found; skipping`,
        );
        return;
      }
      account.coolingDownUntil = until;
      account.cooldownReason = reason;
      demoteAccountInProvider(storage, provider, account);
      switchStickyIfUnselectable(storage, provider, id);
    });
  }

  async touchLastUsed(provider: ProviderKind, id: string): Promise<void> {
    const now = Date.now();
    await this.mutateStorage((storage) => {
      const account = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) return;
      account.lastUsed = now;
      storage.sticky[provider] = id;
    });
  }

  async recordRateLimit(
    provider: ProviderKind,
    id: string,
    snap: RateLimitSnapshot,
  ): Promise<void> {
    const observedAt = snap.observedAt ?? Date.now();
    await this.mutateNonToken(provider, id, (account) => {
      if (snap.limitRequests !== undefined) {
        account.rateLimitLimitRequests = snap.limitRequests;
      }
      if (snap.remainingRequests !== undefined) {
        account.rateLimitRemainingRequests = snap.remainingRequests;
      }
      if (snap.limitTokens !== undefined) {
        account.rateLimitLimitTokens = snap.limitTokens;
      }
      if (snap.remainingTokens !== undefined) {
        account.rateLimitRemainingTokens = snap.remainingTokens;
      }
      if (account.provider === "xai" && snap.costInUsdTicks !== undefined) {
        account.lastCostInUsdTicks = snap.costInUsdTicks;
      }
      account.rateLimitObservedAt = observedAt;
      account.lastUsed = observedAt;
    });
  }

  async recordBillingQuota(
    provider: ProviderKind,
    id: string,
    snap: BillingQuotaSnapshot,
  ): Promise<void> {
    if (provider !== "xai") return;
    const observedAt = snap.observedAt ?? Date.now();
    await this.mutateNonToken(provider, id, (account) => {
      if (account.provider !== "xai") return;
      account.billingMonthlyUsedPercent = snap.monthlyUsedPercent;
      account.billingRemainingPercent = snap.remainingPercent;
      if (snap.resetsAtMs !== undefined) {
        account.billingResetsAt = snap.resetsAtMs;
      }
      account.billingObservedAt = observedAt;
    });
  }

  async recordPlan(
    provider: ProviderKind,
    id: string,
    snap: PlanSnapshot,
  ): Promise<void> {
    if (provider !== "xai") return;
    const observedAt = snap.observedAt ?? Date.now();
    await this.mutateNonToken(provider, id, (account) => {
      if (account.provider !== "xai") return;
      if (snap.planTier !== undefined) account.planTier = snap.planTier;
      account.planName = snap.planName;
      if (snap.planMonthlyLimit !== undefined) {
        account.planMonthlyLimit = snap.planMonthlyLimit;
      }
      if (snap.planUsed !== undefined) account.planUsed = snap.planUsed;
      if (snap.planPeriodStartMs !== undefined) {
        account.planPeriodStartMs = snap.planPeriodStartMs;
      }
      if (snap.planPeriodEndMs !== undefined) {
        account.planPeriodEndMs = snap.planPeriodEndMs;
      }
      account.planObservedAt = observedAt;
    });
  }

  async recordUsage(
    provider: ProviderKind,
    id: string,
    snap: UsageSnapshot,
  ): Promise<void> {
    if (provider !== "codex") return;
    const observedAt = snap.observedAt ?? Date.now();
    await this.mutateNonToken(provider, id, (account) => {
      if (account.provider !== "codex") return;
      if (snap.planType !== undefined) account.planType = snap.planType;
      if (snap.primaryUsedPercent !== undefined) {
        account.primaryUsedPercent = snap.primaryUsedPercent;
      }
      if (snap.primaryWindowMinutes !== undefined) {
        account.primaryWindowMinutes = snap.primaryWindowMinutes;
      }
      if (snap.primaryResetAt !== undefined) {
        account.primaryResetAt = snap.primaryResetAt;
      }
      if (snap.secondaryUsedPercent !== undefined) {
        account.secondaryUsedPercent = snap.secondaryUsedPercent;
      }
      if (snap.secondaryWindowMinutes !== undefined) {
        account.secondaryWindowMinutes = snap.secondaryWindowMinutes;
      }
      if (snap.secondaryResetAt !== undefined) {
        account.secondaryResetAt = snap.secondaryResetAt;
      }
      if (snap.activeLimit !== undefined) account.activeLimit = snap.activeLimit;
      account.usageObservedAt = observedAt;
    });
  }

  async recordKiroUsage(
    provider: ProviderKind,
    id: string,
    snap: KiroUsageSnapshot,
  ): Promise<void> {
    if (provider !== "kiro") return;
    const observedAt = snap.observedAt ?? Date.now();
    await this.mutateNonToken(provider, id, (account) => {
      if (account.provider !== "kiro") return;
      if (snap.usedCount !== undefined) account.usedCount = snap.usedCount;
      if (snap.limitCount !== undefined) account.limitCount = snap.limitCount;
      if (snap.email !== undefined) account.email = snap.email;
      account.usageObservedAt = observedAt;
    });
  }

  async switchTo(provider: ProviderKind, id: string): Promise<void> {
    await this.mutateStorage((storage) => {
      const account = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) {
        throw new Error(
          `cannot switch: unknown account ${identityKey(provider, id)}`,
        );
      }
      account.enabled = true;
      if (account.subscriptionStatus !== "dead") {
        account.subscriptionStatus = "active";
      }
      account.entitlementBlocked = false;
      account.coolingDownUntil = undefined;
      account.cooldownReason = undefined;
      account.quotaResetAt = undefined;
      account.lastSwitchReason = "manual";
      storage.sticky[provider] = id;
    });
  }

  async setEnabled(
    provider: ProviderKind,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    await this.mutateNonToken(provider, id, (account) => {
      account.enabled = enabled;
    });
  }

  async setLabel(
    provider: ProviderKind,
    id: string,
    label?: string,
  ): Promise<void> {
    await this.mutateNonToken(provider, id, (account) => {
      account.label = label;
    });
  }

  async setTags(
    provider: ProviderKind,
    id: string,
    tags: string[],
  ): Promise<void> {
    await this.mutateNonToken(provider, id, (account) => {
      account.tags = [...tags];
    });
  }

  async setNote(
    provider: ProviderKind,
    id: string,
    note?: string,
  ): Promise<void> {
    await this.mutateNonToken(provider, id, (account) => {
      account.note = note;
    });
  }

  async setEmail(
    provider: ProviderKind,
    id: string,
    email: string,
  ): Promise<void> {
    const trimmed = email.trim();
    if (!trimmed) return;
    await this.mutateNonToken(provider, id, (account) => {
      account.email = trimmed;
    });
  }

  async setPriority(
    provider: ProviderKind,
    id: string,
    priority: number,
  ): Promise<void> {
    await this.mutateStorage((storage) => {
      const account = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) {
        throw new Error(
          `cannot set priority: unknown account ${identityKey(provider, id)}`,
        );
      }
      account.priority = Math.trunc(priority);
    });
  }

  async movePriority(
    provider: ProviderKind,
    id: string,
    direction: "up" | "down",
  ): Promise<void> {
    await this.mutateStorage((storage) => {
      sortAccountsByPriority(storage);
      const providerAccounts = storage.accounts.filter(
        (account) => account.provider === provider,
      );
      const index = providerAccounts.findIndex(
        (account) => account.accountId === id,
      );
      if (index === -1) {
        throw new Error(
          `cannot move: unknown account ${identityKey(provider, id)}`,
        );
      }

      const neighborIndex = direction === "up" ? index - 1 : index + 1;
      const account = providerAccounts[index];
      const neighbor = providerAccounts[neighborIndex];
      if (!account || !neighbor) return;

      const accountPriority = account.priority;
      const neighborPriority = neighbor.priority;
      if (accountPriority === neighborPriority) {
        account.priority =
          direction === "up" ? neighborPriority + 1 : neighborPriority - 1;
      } else {
        account.priority = neighborPriority;
        neighbor.priority = accountPriority;
      }
    });
  }

  async moveToFront(provider: ProviderKind, id: string): Promise<void> {
    await this.mutateStorage((storage) => {
      const providerAccounts = storage.accounts.filter(
        (account) => account.provider === provider,
      );
      const account = providerAccounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) {
        throw new Error(
          `cannot move: unknown account ${identityKey(provider, id)}`,
        );
      }
      const maximumPriority = Math.max(
        ...providerAccounts.map((candidate) => candidate.priority),
      );
      account.priority = maximumPriority + 1;
    });
  }

  async setFlaggedForRemoval(
    provider: ProviderKind,
    id: string,
    flagged: boolean,
  ): Promise<void> {
    await this.mutateNonToken(provider, id, (account) => {
      account.flaggedForRemoval = flagged;
    });
  }

  prunableAccounts(provider: ProviderKind): AccountMetadata[] {
    return this.list(provider).filter(
      (account) =>
        account.subscriptionStatus === "dead" || account.flaggedForRemoval,
    );
  }

  deadAccounts(provider: ProviderKind): AccountMetadata[] {
    return this.list(provider).filter(
      (account) => account.subscriptionStatus === "dead",
    );
  }

  async cleanDeadAccounts(
    provider: ProviderKind,
  ): Promise<{ removed: string[] }> {
    const ids = this.deadAccounts(provider).map((account) => account.accountId);
    return this.pruneAccounts(provider, ids);
  }

  async pruneAccounts(
    provider: ProviderKind,
    ids: string[],
  ): Promise<{ removed: string[] }> {
    await this.ensureLoaded();
    const wanted = new Set(ids);
    if (wanted.size === 0) return { removed: [] };

    await backupAccounts(this.storagePath);
    const removed: string[] = [];
    await this.mutateStorage((storage) => {
      const survivors: AccountMetadata[] = [];
      for (const account of storage.accounts) {
        if (
          account.provider === provider &&
          wanted.has(account.accountId)
        ) {
          removed.push(account.accountId);
        } else {
          survivors.push(account);
        }
      }
      storage.accounts = survivors;
      const stickyId = storage.sticky[provider];
      if (stickyId !== undefined && removed.includes(stickyId)) {
        clearSticky(storage, provider);
      }
    });
    return { removed };
  }

  providerView(provider: ProviderKind): ProviderAccountView {
    return {
      provider,
      list: () => this.list(provider),
      get: (id) => this.get(provider, id),
      sticky: () => this.sticky(provider),
      selectAccount: (attempted, policy) =>
        this.selectAccount(provider, attempted, policy),
      add: async (account) => {
        if (account.provider !== provider) {
          throw new Error(
            `cannot add ${account.provider} account through ${provider} view`,
          );
        }
        await this.add(account);
      },
      remove: (id) => this.remove(provider, id),
      upsertFromOAuth: (account) => this.upsertFromOAuth(provider, account),
      ensureFreshToken: (id, force) =>
        this.ensureFreshToken(provider, id, force),
      markQuotaExhausted: (id, resetAt) =>
        this.markQuotaExhausted(provider, id, resetAt),
      markEntitlementBlocked: (id) =>
        this.markEntitlementBlocked(provider, id),
      markDeadCandidate: (id) => this.markDeadCandidate(provider, id),
      recordCooldown: (id, reason, until) =>
        this.recordCooldown(provider, id, reason, until),
      touchLastUsed: (id) => this.touchLastUsed(provider, id),
      recordRateLimit: (id, snap) =>
        this.recordRateLimit(provider, id, snap),
      recordBillingQuota: (id, snap) =>
        this.recordBillingQuota(provider, id, snap),
      recordPlan: (id, snap) => this.recordPlan(provider, id, snap),
      recordUsage: (id, snap) => this.recordUsage(provider, id, snap),
      recordKiroUsage: (id, snap) => this.recordKiroUsage(provider, id, snap),
      switchTo: (id) => this.switchTo(provider, id),
      setEnabled: (id, enabled) => this.setEnabled(provider, id, enabled),
      setLabel: (id, label) => this.setLabel(provider, id, label),
      setTags: (id, tags) => this.setTags(provider, id, tags),
      setNote: (id, note) => this.setNote(provider, id, note),
      setEmail: (id, email) => this.setEmail(provider, id, email),
      setPriority: (id, priority) =>
        this.setPriority(provider, id, priority),
      movePriority: (id, direction) =>
        this.movePriority(provider, id, direction),
      moveToFront: (id) => this.moveToFront(provider, id),
      setFlaggedForRemoval: (id, flagged) =>
        this.setFlaggedForRemoval(provider, id, flagged),
      prunableAccounts: () => this.prunableAccounts(provider),
      deadAccounts: () => this.deadAccounts(provider),
      cleanDeadAccounts: () => this.cleanDeadAccounts(provider),
      pruneAccounts: (ids) => this.pruneAccounts(provider, ids),
    };
  }

  private async ensureLoaded(): Promise<AccountStorage> {
    if (!this.storage) await this.load();
    const storage = this.storage;
    if (!storage) throw new Error("AccountManager failed to load storage");
    return storage;
  }

  private async mutateStorage(
    mutate: (storage: AccountStorage) => void | Promise<void>,
  ): Promise<void> {
    await this.ensureLoaded();
    const next = await withCrossProcessTransaction<AccountStorage>(
      async (storage) => {
        await mutate(storage);
        sortAccountsByPriority(storage);
        return storage;
      },
      this.storagePath,
    );
    this.adoptStorage(next);
  }

  private async mutateNonToken(
    provider: ProviderKind,
    id: string,
    patch: (account: AccountMetadata) => void,
  ): Promise<void> {
    await this.mutateStorage((storage) => {
      const account = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) {
        logger.warn(
          `mutateNonToken: account ${identityKey(provider, id)} not found; skipping`,
        );
        return;
      }
      patch(account);
    });
  }

  private async refreshUnderLock(
    provider: ProviderKind,
    id: string,
    force: boolean,
    staleAccessToken: string | undefined,
  ): Promise<Tokens> {
    const result = await withCrossProcessTransaction<{
      storage: AccountStorage;
      tokens: Tokens;
    }>(async (storage) => {
      const account = storage.accounts.find((candidate) =>
        matchesIdentity(candidate, provider, id),
      );
      if (!account) {
        throw new Error(
          `ensureFreshToken: account ${identityKey(provider, id)} vanished from storage`,
        );
      }

      const diskTokens = validTokens(account, Date.now());
      const diskHasNewToken =
        !force || account.accessToken !== staleAccessToken;
      if (diskTokens && diskHasNewToken) {
        sortAccountsByPriority(storage);
        logger.debug(
          `ensureFreshToken: disk token for ${identityKey(provider, id)} already fresh; skipping refresh`,
        );
        return { storage, tokens: diskTokens };
      }

      let refreshed: Tokens;
      if (provider === "xai" && account.provider === "xai") {
        const driver = this.refreshByProvider.xai;
        if (!driver) {
          throw new Error(
            "ensureFreshToken: no refresh handler configured for provider xai",
          );
        }
        refreshed = await driver.refresh(account, { force });
      } else if (provider === "codex" && account.provider === "codex") {
        const driver = this.refreshByProvider.codex;
        if (!driver) {
          throw new Error(
            "ensureFreshToken: no refresh handler configured for provider codex",
          );
        }
        refreshed = await driver.refresh(account, { force });
      } else if (provider === "kiro" && account.provider === "kiro") {
        const driver = this.refreshByProvider.kiro;
        if (!driver) {
          throw new Error(
            "ensureFreshToken: no refresh handler configured for provider kiro",
          );
        }
        refreshed = await driver.refresh(account, { force });
      } else {
        throw new Error(
          `ensureFreshToken: no refresh handler configured for provider ${provider}`,
        );
      }
      const tokens: Tokens = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      account.accessToken = tokens.accessToken;
      account.refreshToken = tokens.refreshToken;
      account.expiresAt = tokens.expiresAt;
      sortAccountsByPriority(storage);
      return { storage, tokens };
    }, this.storagePath);

    this.adoptStorage(result.storage);
    return result.tokens;
  }

  private adoptStorage(storage: AccountStorage): void {
    sortAccountsByPriority(storage);
    this.storage = storage;
  }
}

let singleton: AccountManager | null = null;
let singletonPath: string | undefined;

export function getAccountManager(storagePath?: string): AccountManager {
  if (!singleton) {
    singleton = new AccountManager(
      storagePath,
      createDefaultRefreshHandlers(),
    );
    singletonPath = storagePath ?? defaultStoragePath();
    return singleton;
  }

  if (storagePath !== undefined && storagePath !== singletonPath) {
    throw new Error(
      "getAccountManager called with a different storagePath than the existing singleton",
    );
  }
  return singleton;
}

export function resetAccountManager(): void {
  singleton = null;
  singletonPath = undefined;
}
