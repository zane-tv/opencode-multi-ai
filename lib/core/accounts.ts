import { logger } from "./logger.js";
import { migrateAccountsIfNeeded } from "../migrate.js";
import { defaultStoragePath } from "./paths.js";
import type {
  AccountMetadata,
  AccountStorage,
  CooldownReason,
  ProviderKind,
} from "./schemas.js";
import {
  backupAccounts,
  loadAccounts,
  withCrossProcessTransaction,
} from "./storage.js";

const MAX_ACCOUNTS = 20;
const TOKEN_REFRESH_SKEW_MS = 60_000;

type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type RefreshFn = (refreshToken: string) => Promise<Tokens>;

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

export interface ProviderAccountView {
  readonly provider: ProviderKind;
  list(): AccountMetadata[];
  get(id: string): AccountMetadata | undefined;
  sticky(): string | undefined;
  selectAccount(attempted: Set<string>): AccountMetadata | null;
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

function sortAccountsByPriority(storage: AccountStorage): void {
  storage.accounts.sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.addedAt - right.addedAt;
  });
}

function clearSticky(storage: AccountStorage, provider: ProviderKind): void {
  delete storage.sticky[provider];
}

function mergeOAuthAccount(
  current: AccountMetadata,
  incoming: AccountMetadata,
): void {
  current.refreshToken = incoming.refreshToken;
  current.accessToken = incoming.accessToken;
  current.expiresAt = incoming.expiresAt;
  if (incoming.email !== undefined) current.email = incoming.email;
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
  }
}

// allow: SIZE_OK — this cohesive manager intentionally mirrors the full tested
// account-management surface in one module, matching the source managers.
export class AccountManager {
  private readonly storagePath: string | undefined;
  private readonly refreshByProvider: Partial<Record<ProviderKind, RefreshFn>>;
  private storage: AccountStorage | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly freshInFlight = new Map<string, Promise<Tokens>>();

  constructor(
    storagePath?: string,
    refreshByProvider: Partial<Record<ProviderKind, RefreshFn>> = {},
  ) {
    this.storagePath = storagePath;
    this.refreshByProvider = refreshByProvider;
  }

  async load(): Promise<void> {
    if (this.storage) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    const pending = (async () => {
      await migrateAccountsIfNeeded({ unifiedPath: this.storagePath });
      const storage = await loadAccounts(this.storagePath);
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
    return this.storage?.accounts.filter(
      (account) => account.provider === provider,
    ) ?? [];
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
  ): AccountMetadata | null {
    const storage = this.storage;
    if (!storage) return null;
    const now = Date.now();
    const eligible = (account: AccountMetadata): boolean =>
      account.provider === provider &&
      isSelectable(account, now) &&
      !attempted.has(account.accountId);

    const stickyId = storage.sticky[provider];
    if (stickyId !== undefined) {
      const current = storage.accounts.find(
        (account) =>
          matchesIdentity(account, provider, stickyId) && eligible(account),
      );
      if (current) return current;
    }

    const next = storage.accounts.find(eligible);
    if (!next) return null;
    storage.sticky[provider] = next.accountId;
    logger.debug(
      `selectAccount switched ${provider} sticky to ${next.accountId}`,
    );
    return next;
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
      if (storage.accounts.length >= MAX_ACCOUNTS) {
        throw new Error(
          `cannot add account: pool is at the maximum of ${MAX_ACCOUNTS} accounts`,
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
      if (storage.accounts.length >= MAX_ACCOUNTS) {
        throw new Error(
          `cannot add account: pool is at the maximum of ${MAX_ACCOUNTS} accounts`,
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
      const providerAccounts = storage.accounts.filter(
        (candidate) => candidate.provider === provider,
      );
      const minimumPriority = Math.min(
        ...providerAccounts.map((candidate) => candidate.priority),
      );
      account.priority = minimumPriority - 1;
      sortAccountsByPriority(storage);

      if (
        storage.sticky[provider] === id &&
        !isSelectable(account, Date.now())
      ) {
        const replacement = storage.accounts.find(
          (candidate) =>
            candidate.provider === provider &&
            isSelectable(candidate, Date.now()),
        );
        if (replacement) storage.sticky[provider] = replacement.accountId;
        else clearSticky(storage, provider);
      }
    });
  }

  async markEntitlementBlocked(
    provider: ProviderKind,
    id: string,
  ): Promise<void> {
    await this.mutateNonToken(provider, id, (account) => {
      account.entitlementBlocked = true;
    });
  }

  async markDeadCandidate(
    provider: ProviderKind,
    id: string,
  ): Promise<void> {
    const now = Date.now();
    await this.mutateNonToken(provider, id, (account) => {
      account.subscriptionStatus = "dead";
      account.subscriptionCheckedAt = now;
    });
  }

  async recordCooldown(
    provider: ProviderKind,
    id: string,
    reason: CooldownReason,
    until: number,
  ): Promise<void> {
    await this.mutateNonToken(provider, id, (account) => {
      account.coolingDownUntil = until;
      account.cooldownReason = reason;
    });
  }

  async touchLastUsed(provider: ProviderKind, id: string): Promise<void> {
    const now = Date.now();
    await this.mutateNonToken(provider, id, (account) => {
      account.lastUsed = now;
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

  async switchTo(provider: ProviderKind, id: string): Promise<void> {
    await this.mutateStorage((storage) => {
      const exists = storage.accounts.some((account) =>
        matchesIdentity(account, provider, id),
      );
      if (!exists) {
        throw new Error(
          `cannot switch: unknown account ${identityKey(provider, id)}`,
        );
      }
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
      selectAccount: (attempted) => this.selectAccount(provider, attempted),
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

      const refresh = this.refreshByProvider[provider];
      if (!refresh) {
        throw new Error(
          `ensureFreshToken: no refresh handler configured for provider ${provider}`,
        );
      }
      const refreshed = await refresh(account.refreshToken);
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
    singleton = new AccountManager(storagePath);
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
