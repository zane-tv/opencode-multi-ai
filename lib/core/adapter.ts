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

import type { ProviderKind } from "./schemas.js";

export type { ProviderKind } from "./schemas.js";

/** OpenCode provider id registered by each plugin entry. */
export type ProviderId = "xai-multi" | "codex-multi" | "kiro-multi";

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

/** Provider metadata shared by HTTP and SDK-backed transports. */
export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly provider: ProviderKind;
  readonly displayName: string;
  readonly npmPackage: string;
  readonly baseURL: string;
  readonly dummyApiKey: string;
  resolveModels(opts: ResolveModelsOptions): Promise<Record<string, unknown>>;
  providerDefaultOptions(): Record<string, unknown>;
  listSubtitle(account: Record<string, unknown>, now: number): string;
  detailLines(account: Record<string, unknown>, now: number): string[];
  probeQuota?(
    accessToken: string,
    account: { accountId: string; organizationId?: string },
  ): Promise<Record<string, unknown>>;
  hostAuth?: {
    bootstrap(providerId: string): boolean;
    ensureAfterLogin(providerId: string, accountId?: string): void;
  };
}

/** HTTP-only request surface used by createRotationFetch. */
export interface HttpTransportAdapter {
  resolveUrl(input: string | URL): string;
  buildHeaders(ctx: BuildHeadersContext): Headers;
  transformBody(
    init: RequestInit | undefined,
    ctx: TransformBodyContext,
  ): RequestInit | undefined;
  classifyResponse(
    res: Response,
    bodyText: string,
  ): Classification | Promise<Classification>;
  classifyThrownError(err: unknown): Classification;
  recordSuccess(ctx: RecordSuccessContext): Promise<void>;
  probeQuota?(
    accessToken: string,
    account: { accountId: string; organizationId?: string },
  ): Promise<Record<string, unknown>>;
}

export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

/** Deliberately structural to avoid a runtime dependency on rotation-fetch. */
export interface ProviderFetchContext {
  readonly descriptor: ProviderDescriptor;
  readonly manager: unknown;
}

export type ProviderTransport =
  | ({ readonly kind: "http" } & HttpTransportAdapter)
  | {
      readonly kind: "custom";
      createFetch(ctx: ProviderFetchContext): FetchLike;
    };

/** Canonical post-Wave-5 provider shape. */
export type TransportProviderAdapter = ProviderDescriptor & {
  readonly transport: ProviderTransport;
};

export type HttpTransportProviderAdapter = TransportProviderAdapter &
  Partial<HttpTransportAdapter>;

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

export type AnyProviderAdapter = ProviderAdapter | TransportProviderAdapter;

export function assertNever(value: never): never {
  throw new Error(`unhandled provider transport: ${String(value)}`);
}

function isDescriptor(value: Record<string, unknown>): boolean {
  const provider = value.provider;
  const id = value.id;
  return (
    (provider === "xai" && id === "xai-multi") ||
    (provider === "codex" && id === "codex-multi") ||
    (provider === "kiro" && id === "kiro-multi")
  ) &&
    typeof value.displayName === "string" &&
    typeof value.resolveModels === "function" &&
    typeof value.providerDefaultOptions === "function" &&
    typeof value.npmPackage === "string" &&
    typeof value.baseURL === "string" &&
    typeof value.dummyApiKey === "string" &&
    typeof value.listSubtitle === "function" &&
    typeof value.detailLines === "function";
}

export function isProviderAdapter(x: unknown): x is AnyProviderAdapter {
  if (x === null || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  if (!isDescriptor(a)) return false;
  if (a.transport === undefined) {
    return (
      typeof a.resolveUrl === "function" &&
      typeof a.buildHeaders === "function" &&
      typeof a.transformBody === "function" &&
      typeof a.classifyResponse === "function" &&
      typeof a.classifyThrownError === "function" &&
      typeof a.recordSuccess === "function"
    );
  }
  if (a.transport === null || typeof a.transport !== "object") return false;
  const transport = a.transport as Record<string, unknown>;
  if (transport.kind === "custom") {
    return typeof transport.createFetch === "function";
  }
  if (transport.kind === "http") {
    return (
      typeof transport.resolveUrl === "function" &&
      typeof transport.buildHeaders === "function" &&
      typeof transport.transformBody === "function" &&
      typeof transport.classifyResponse === "function" &&
      typeof transport.classifyThrownError === "function" &&
      typeof transport.recordSuccess === "function"
    );
  }
  return false;
}
