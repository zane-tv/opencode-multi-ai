/**
 * ProviderAdapter — the contract the shared core depends on.
 *
 * Each provider (xAI, Codex) implements this TOTAL interface. The rotation
 * loop (`rotation-fetch.ts`) and plugin/CLI/TUI surfaces call only through
 * this surface so provider-specific URL policy, headers, body transforms,
 * classify tables, success metrics, models, and TUI columns stay isolated.
 *
 * Wave 3 fills in `lib/providers/{xai,codex}/` concrete adapters; this module
 * is interface + shared Classification shape only.
 */

/** Discriminator for account storage / manager identity. */
export type ProviderKind = "xai" | "codex";

/** OpenCode provider id registered by each plugin entry. */
export type ProviderId = "xai-multi" | "codex-multi";

/**
 * Headers init without relying on a DOM lib entry.
 * Matches undici / Fetch HeadersInit (string[][] | record | Headers).
 */
export type AdapterHeadersInit =
  | Headers
  | Record<string, string | ReadonlyArray<string>>
  | Array<[string, string]>;

/**
 * Discriminated classification of an HTTP response or thrown error.
 *
 * Shared by both providers' classify tables (same 8 kinds). Pure data —
 * fetch owns marks/rotation. Copied shape only; do not import from source
 * repos at runtime.
 */
export type Classification =
  | { kind: "ok" }
  /** Per-request / per-minute rate limit — backoff, KEEP account. */
  | { kind: "transient"; retryAfterMs?: number }
  /** Subscription / usage / credits cap — ROTATE; account RECOVERS. */
  | { kind: "quota-exhausted"; resetAtMs?: number }
  /** Plan/allowlist gate — mark blocked, SKIP in selection. */
  | { kind: "entitlement-blocked" }
  /** Revoked / invalid credential path — cooldown / dead. */
  | { kind: "auth-dead" }
  /** 5xx / overload — backoff then rotate. */
  | { kind: "server"; retryAfterMs?: number }
  /** fetch threw / network error — backoff then rotate. */
  | { kind: "network" }
  /** Other 4xx — return as-is; do NOT rotate the pool. */
  | { kind: "unknown-client-error"; status: number };

/**
 * Minimal write surface for success-metric recording.
 * Opaque to avoid circular imports with AccountManager.
 */
export interface SuccessRecordSink {
  recordRateLimit?(id: string, snap: Record<string, unknown>): Promise<void>;
  recordUsage?(id: string, snap: Record<string, unknown>): Promise<void>;
  recordPlan?(id: string, snap: Record<string, unknown>): Promise<void>;
  recordBillingQuota?(id: string, snap: Record<string, unknown>): Promise<void>;
}

/** Context for Authorization / provider-specific header packing. */
export interface BuildHeadersContext {
  accessToken: string;
  accountId: string;
  organizationId?: string;
  promptCacheKey?: string;
  initHeaders?: AdapterHeadersInit;
}

/** Context for body transform (reasoning inject / store:false / etc). */
export interface TransformBodyContext {
  url: string;
  sessionOptions?: Record<string, unknown>;
}

/** Context for post-success metric recording. */
export interface RecordSuccessContext {
  accountId: string;
  response: Response;
  bodyText?: string;
  record: SuccessRecordSink;
}

/** Options for the models catalog resolver. */
export interface ResolveModelsOptions {
  accessToken?: string;
  userModels?: Record<string, unknown>;
  allowNetwork?: boolean;
  cachePath?: string;
}

/**
 * Total provider adapter. All methods required unless marked optional.
 *
 * - `resolveUrl`: xai host-pins (throw on wrong host); codex rewrites to chatgpt.com
 * - `buildHeaders`: Authorization overwrite + provider headers
 * - `transformBody`: reasoning inject / store:false / effort map
 * - `classify*`: pure failure taxonomy
 * - `recordSuccess`: rate-limit (xai) or usage (codex) into manager
 * - `probeQuota` / `hostAuth`: optional provider-specific hooks
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly provider: ProviderKind;
  /** "Grok Multi-Account" | "Codex Multi-Account" */
  readonly displayName: string;

  /** URL policy: xai host-pins (throw); codex rewrites to chatgpt.com. */
  resolveUrl(input: string | URL): string;

  /** Build request headers including Authorization overwrite. */
  buildHeaders(ctx: BuildHeadersContext): Headers;

  /** Transform request body; return new init (or undefined). */
  transformBody(
    init: RequestInit | undefined,
    ctx: TransformBodyContext,
  ): RequestInit | undefined;

  /** Classify HTTP response (may be async if body parse needs it). */
  classifyResponse(
    res: Response,
    bodyText: string,
  ): Classification | Promise<Classification>;

  /** Classify thrown error (network, AbortError, InvalidGrant, …). */
  classifyThrownError(err: unknown): Classification;

  /**
   * On success: record rate-limit (xai) or usage (codex) into manager.
   * Fire-and-forget friendly; never throw into the success path.
   */
  recordSuccess(ctx: RecordSuccessContext): Promise<void>;

  /** Optional live quota probe for limits tool / TUI. */
  probeQuota?(
    accessToken: string,
    account: { accountId: string; organizationId?: string },
  ): Promise<Record<string, unknown>>;

  /** Models catalog resolver (cache / network / defaults). */
  resolveModels(opts: ResolveModelsOptions): Promise<Record<string, unknown>>;

  /**
   * Provider default options for opencode.json.
   * Codex: store/include/reasoningEffort; xAI may be {}.
   */
  providerDefaultOptions(): Record<string, unknown>;

  /** npm package for AI SDK (`@ai-sdk/xai` | `@ai-sdk/openai`). */
  readonly npmPackage: string;

  /** baseURL for auth.loader. */
  readonly baseURL: string;

  /** Dummy api key for SDK construction (overwritten by customFetch). */
  readonly dummyApiKey: string;

  /** TUI list subtitle line. */
  listSubtitle(account: Record<string, unknown>, now: number): string;

  /** TUI detail lines (plain strings for now; StyledText later). */
  detailLines(account: Record<string, unknown>, now: number): string[];

  /** Optional host-auth (codex only). */
  hostAuth?: {
    bootstrap(providerId: string): boolean;
    ensureAfterLogin(providerId: string, accountId?: string): void;
  };
}

/** Runtime type guard for objects that claim to be a ProviderAdapter. */
export function isProviderAdapter(x: unknown): x is ProviderAdapter {
  if (x === null || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  return (
    (a.id === "xai-multi" || a.id === "codex-multi") &&
    (a.provider === "xai" || a.provider === "codex") &&
    typeof a.displayName === "string" &&
    typeof a.resolveUrl === "function" &&
    typeof a.buildHeaders === "function" &&
    typeof a.transformBody === "function" &&
    typeof a.classifyResponse === "function" &&
    typeof a.classifyThrownError === "function" &&
    typeof a.recordSuccess === "function" &&
    typeof a.resolveModels === "function" &&
    typeof a.providerDefaultOptions === "function" &&
    typeof a.npmPackage === "string" &&
    typeof a.baseURL === "string" &&
    typeof a.dummyApiKey === "string" &&
    typeof a.listSubtitle === "function" &&
    typeof a.detailLines === "function"
  );
}
