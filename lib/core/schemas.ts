import * as z from "zod";

/**
 * Zod schemas for the unified multi-provider account pool.
 * These schemas are the validation boundary for persisted account storage.
 *
 * v3: discriminated by `provider: "xai" | "codex" | "kiro"`, sticky is
 * per-provider accountId (not a shared activeIndex). Legacy v1 and v2 decoders
 * are kept for migration only.
 *
 * YAGNI-trimmed: do NOT add healthScore, tokenBucket, activeIndexByModel,
 * or activeIndexByFamily here.
 */

/** Provider identity for accounts and sticky pointers. */
export const PROVIDER_KINDS = ["xai", "codex", "kiro"] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const AccountSelectionStrategySchema = z.enum([
  "sticky",
  "round-robin",
  "lowest-usage",
]);
export type AccountSelectionStrategy = z.infer<
  typeof AccountSelectionStrategySchema
>;

/** Reason the account was (last) switched to / away from. */
export const LastSwitchReasonSchema = z.enum([
  "initial",
  "rotation",
  "quota-exhausted",
  "manual",
]);
export type LastSwitchReason = z.infer<typeof LastSwitchReasonSchema>;

/** Reason an account is in cooldown. */
export const CooldownReasonSchema = z.enum([
  "auth-failure",
  "network-error",
  "rate-limit",
]);
export type CooldownReason = z.infer<typeof CooldownReasonSchema>;

/**
 * Subscription lifecycle status.
 *
 * IMPORTANT: only set "dead" when the refresh grant returns invalid_grant.
 * Do NOT set "dead" based on inference-time credit/quota strings — those are
 * recoverable quota-exhausted signals, not terminal subscription death.
 */
export const SubscriptionStatusSchema = z.enum(["active", "dead", "unknown"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

/** Shared fields present on every account regardless of provider. */
const AccountBaseFields = {
  accountId: z.string(),
  email: z.string().optional(),
  label: z.string().optional(),
  tags: z.array(z.string()).default([]),
  note: z.string().optional(),

  /** REQUIRED. Refresh tokens must be non-empty at the persisted boundary. */
  refreshToken: z.string().min(1),
  accessToken: z.string().optional(),
  /** Epoch ms at which the access token expires. */
  expiresAt: z.number().optional(),
  oauthScope: z.string().optional(),

  enabled: z.boolean().default(true),
  /**
   * Rotation / list priority. Higher = preferred earlier.
   * List is kept sorted by priority DESC (then addedAt ASC).
   * Default 0; move-up/down adjusts these and re-sorts.
   */
  priority: z.number().int().default(0),
  addedAt: z.number(),
  lastUsed: z.number().default(0),
  lastSwitchReason: LastSwitchReasonSchema.default("initial"),

  /** Epoch ms when a quota-exhausted account may recover. */
  quotaResetAt: z.number().optional(),
  coolingDownUntil: z.number().optional(),
  cooldownReason: CooldownReasonSchema.optional(),

  subscriptionStatus: SubscriptionStatusSchema.default("unknown"),
  subscriptionCheckedAt: z.number().optional(),
  flaggedForRemoval: z.boolean().default(false),

  /**
   * True when the account hit a permanent entitlement / allowlist gate.
   * DISTINCT from `flaggedForRemoval` (prune semantics): selection skips it.
   * Optional-with-default so older pools still validate.
   */
  entitlementBlocked: z.boolean().default(false),

  /** Last observed API rate-limit remaining (from rate-limit headers, if any). */
  rateLimitLimitRequests: z.number().optional(),
  rateLimitRemainingRequests: z.number().optional(),
  rateLimitLimitTokens: z.number().optional(),
  rateLimitRemainingTokens: z.number().optional(),
  /** Epoch ms when rate-limit headers were last observed. */
  rateLimitObservedAt: z.number().optional(),
} as const;

/**
 * xAI-only quota / plan / billing fields.
 * Kept off the codex branch so a codex record carrying planTier fails parse.
 */
const XaiSpecificFields = {
  /** Last request cost in xAI ticks (1 USD = 1e10 ticks), if body was readable. */
  lastCostInUsdTicks: z.number().optional(),

  /** SuperGrok/Grok Build monthly credits % used (grok.com GetGrokCreditsConfig). */
  billingMonthlyUsedPercent: z.number().optional(),
  billingRemainingPercent: z.number().optional(),
  /** Epoch ms when monthly credits reset. */
  billingResetsAt: z.number().optional(),
  /** Epoch ms when billing snapshot was fetched. */
  billingObservedAt: z.number().optional(),

  /**
   * Subscription plan (best-effort).
   * - planTier: numeric claim from access JWT (`tier`)
   * - planName: human label (mapped or from billing)
   * - planMonthlyLimit / planUsed: absolute units from cli-chat-proxy /v1/billing
   * - planPeriodStartMs / planPeriodEndMs: billing window
   */
  planTier: z.number().optional(),
  planName: z.string().optional(),
  planMonthlyLimit: z.number().optional(),
  planUsed: z.number().optional(),
  planPeriodStartMs: z.number().optional(),
  planPeriodEndMs: z.number().optional(),
  planObservedAt: z.number().optional(),
} as const;

/**
 * Codex / ChatGPT usage-window fields.
 * Absolute billing/plan-tick fields from other providers are intentionally not
 * stored here.
 */
const CodexSpecificFields = {
  /**
   * Optional OpenAI organization id for the `openai-organization` request
   * header (set when known from JWT / workspace selection).
   */
  organizationId: z.string().optional(),

  /** Plan label from usage probe (e.g. plus, team, pro, free). */
  planType: z.string().optional(),
  /** Primary window usage 0–100 (or higher if overage reported). */
  primaryUsedPercent: z.number().optional(),
  primaryWindowMinutes: z.number().optional(),
  /** Epoch ms when the primary window resets. */
  primaryResetAt: z.number().optional(),
  /** Secondary window usage 0–100. */
  secondaryUsedPercent: z.number().optional(),
  secondaryWindowMinutes: z.number().optional(),
  /** Epoch ms when the secondary window resets. */
  secondaryResetAt: z.number().optional(),
  /** Which limit is currently binding (e.g. primary | secondary | none). */
  activeLimit: z.string().optional(),
  /** Epoch ms when usage snapshot was last observed. */
  usageObservedAt: z.number().optional(),
} as const;

const KiroSpecificFields = {
  authMethod: z.enum(["api-key", "desktop", "idc", "external-idp"]),
  region: z.string(),
  oidcRegion: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  profileArn: z.string().optional(),
  startUrl: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  usedCount: z.number().int().nonnegative().optional(),
  limitCount: z.number().int().nonnegative().optional(),
  usageObservedAt: z.number().optional(),
  credentialSource: z
    .enum(["login", "api-key", "import", "kiro-cli", "legacy-db"])
    .optional(),
  externalSyncAt: z.number().optional(),
} as const;

/**
 * `.strict()` so cross-provider keys (e.g. planTier on a codex row) fail
 * rather than being silently stripped by Zod's default object behavior.
 */
export const XaiAccountMetadataSchema = z
  .object({
    provider: z.literal("xai"),
    ...AccountBaseFields,
    ...XaiSpecificFields,
  })
  .strict();

export const CodexAccountMetadataSchema = z
  .object({
    provider: z.literal("codex"),
    ...AccountBaseFields,
    ...CodexSpecificFields,
  })
  .strict();

const KiroAccountMetadataObjectSchema = z
  .object({
    provider: z.literal("kiro"),
    ...AccountBaseFields,
    ...KiroSpecificFields,
  })
  .strict();

type KiroAccountMetadataObject = z.infer<
  typeof KiroAccountMetadataObjectSchema
>;

const UrlSchema = z.string().url();

function validateKiroAccount(
  account: KiroAccountMetadataObject,
  ctx: z.RefinementCtx,
): void {
  if (account.authMethod === "idc") {
    if (!account.clientId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientId"],
        message: "clientId is required for idc authentication",
      });
    }
    if (!account.clientSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientSecret"],
        message: "clientSecret is required for idc authentication",
      });
    }
  }

  if (account.authMethod === "external-idp") {
    if (!account.clientId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientId"],
        message: "clientId is required for external-idp authentication",
      });
    }
    if (!account.tokenEndpoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tokenEndpoint"],
        message: "tokenEndpoint is required for external-idp authentication",
      });
    } else if (!UrlSchema.safeParse(account.tokenEndpoint).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tokenEndpoint"],
        message: "tokenEndpoint must be a valid URL",
      });
    }
  }

  if (
    account.authMethod === "api-key" &&
    !account.refreshToken.startsWith("ksk_")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["refreshToken"],
      message: "api-key refreshToken must start with ksk_",
    });
  }

  if (
    account.startUrl !== undefined &&
    !UrlSchema.safeParse(account.startUrl).success
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startUrl"],
      message: "startUrl must be a valid URL",
    });
  }

  if (
    account.profileArn !== undefined &&
    !account.profileArn.startsWith("arn:")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["profileArn"],
      message: "profileArn must start with arn:",
    });
  }
}

export const KiroAccountMetadataSchema =
  KiroAccountMetadataObjectSchema.superRefine(validateKiroAccount);

export const AccountMetadataSchema = z
  .discriminatedUnion("provider", [
    XaiAccountMetadataSchema,
    CodexAccountMetadataSchema,
    KiroAccountMetadataObjectSchema,
  ])
  .superRefine((account, ctx) => {
    if (account.provider === "kiro") validateKiroAccount(account, ctx);
  });
export type AccountMetadata = z.infer<typeof AccountMetadataSchema>;
export type XaiAccountMetadata = z.infer<typeof XaiAccountMetadataSchema>;
export type CodexAccountMetadata = z.infer<typeof CodexAccountMetadataSchema>;
export type KiroAccountMetadata = z.infer<typeof KiroAccountMetadataSchema>;
export type AccountOf<P extends ProviderKind> = Extract<
  AccountMetadata,
  { provider: P }
>;

/**
 * Migration-only decoder for the previous two-provider storage document.
 */
export const AccountStorageV2Schema = z.object({
  version: z.literal(2),
  accounts: z.array(
    z.discriminatedUnion("provider", [
      XaiAccountMetadataSchema,
      CodexAccountMetadataSchema,
    ]),
  ),
  sticky: z.object({
    xai: z.string().optional(),
    codex: z.string().optional(),
  }),
});
export type AccountStorageV2 = z.infer<typeof AccountStorageV2Schema>;

/**
 * Unified v3 storage document.
 * sticky holds the active accountId per provider — never a shared int index.
 */
export const AccountStorageSchema = z.object({
  version: z.literal(3),
  accounts: z.array(AccountMetadataSchema).default([]),
  sticky: z
    .object({
      xai: z.string().optional(),
      codex: z.string().optional(),
      kiro: z.string().optional(),
    })
    .default({}),
});
export type AccountStorage = z.infer<typeof AccountStorageSchema>;

// ---------------------------------------------------------------------------
// Legacy v1 decoders (migration only — no provider field, activeIndex int)
// ---------------------------------------------------------------------------

/** Pre-merge xAI account shape (no `provider` discriminator). */
export const LegacyXaiAccountMetadataSchema = z.object({
  ...AccountBaseFields,
  ...XaiSpecificFields,
});
export type LegacyXaiAccountMetadata = z.infer<
  typeof LegacyXaiAccountMetadataSchema
>;

export const LegacyXaiAccountStorageSchema = z.object({
  version: z.literal(1),
  accounts: z.array(LegacyXaiAccountMetadataSchema).default([]),
  activeIndex: z.number().default(0),
});
export type LegacyXaiAccountStorage = z.infer<
  typeof LegacyXaiAccountStorageSchema
>;

/** Pre-merge Codex account shape (no `provider` discriminator). */
export const LegacyCodexAccountMetadataSchema = z.object({
  ...AccountBaseFields,
  ...CodexSpecificFields,
});
export type LegacyCodexAccountMetadata = z.infer<
  typeof LegacyCodexAccountMetadataSchema
>;

export const LegacyCodexAccountStorageSchema = z.object({
  version: z.literal(1),
  accounts: z.array(LegacyCodexAccountMetadataSchema).default([]),
  activeIndex: z.number().default(0),
});
export type LegacyCodexAccountStorage = z.infer<
  typeof LegacyCodexAccountStorageSchema
>;
