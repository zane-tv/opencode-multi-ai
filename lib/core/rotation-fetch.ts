/**
 * Provider-agnostic rotation fetch loop.
 *
 * Takes a `ProviderAdapter` for URL policy / headers / body / classify /
 * success metrics, and a `RotationManager` for account selection + marks.
 *
 * NEVER host-pins or rewrites URLs here — only `adapter.resolveUrl`.
 * NEVER send Authorization before `adapter.resolveUrl`.
 * AccountManager (todo 8) is injected; no default singleton yet.
 */

import type {
  Classification,
  ProviderAdapter,
  ProviderKind,
  SuccessRecordSink,
} from "./adapter.js";
import { logger } from "./logger.js";
import {
  getSessionOptions,
  sessionIdFromHeaders,
} from "./session-options.js";

/** The input/init shapes of the runtime `fetch`, without relying on DOM libs. */
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** Fixed, bounded backoff for a single same-account transient retry. */
export const TRANSIENT_BACKOFF_MS = 250;
/** Brief backoff before rotating on server/network failures. */
export const NETWORK_BACKOFF_MS = 150;
/** Fallback quota reset window when no retry hint is present. */
export const QUOTA_FALLBACK_MS = 15 * 60_000;
/** Cooldown after auth-dead survives a forced refresh. */
export const AUTH_COOLDOWN_MS = 30_000;
/**
 * Upper bound on how much of an ERROR response body we read for classification.
 * A JSON error envelope is tiny; 64KB is generous.
 */
const MAX_CLASSIFY_BYTES = 64 * 1024;

/**
 * Error thrown when a refresh grant returns invalid_grant.
 * Rotation marks the account dead; other errors are treated as network.
 * AccountManager / oauth may throw a subclass with the same name.
 */
export class InvalidGrantError extends Error {
  readonly code = "invalid_grant" as const;
  constructor(message = "invalid_grant") {
    super(message);
    this.name = "InvalidGrantError";
  }
}

export function isInvalidGrantError(err: unknown): boolean {
  if (err instanceof InvalidGrantError) return true;
  if (err && typeof err === "object") {
    const e = err as { name?: string; code?: string };
    if (e.name === "InvalidGrantError") return true;
    if (e.code === "invalid_grant") return true;
  }
  return false;
}

/** Minimal account fields the rotation loop needs after selection. */
export interface RotationAccount {
  accountId: string;
  organizationId?: string;
  quotaResetAt?: number;
  coolingDownUntil?: number;
}

/**
 * Manager surface used by the rotation loop.
 * Scoped by `adapter.provider` on every call.
 * Keep minimal until AccountManager (todo 8) lands.
 */
export interface RotationManager {
  selectAccount(
    provider: ProviderKind,
    attempted: Set<string>,
  ): RotationAccount | null;

  ensureFreshToken(
    provider: ProviderKind,
    id: string,
    force?: boolean,
  ): Promise<{ accessToken: string }>;

  markQuotaExhausted(
    provider: ProviderKind,
    id: string,
    resetAt: number,
  ): Promise<void>;

  markEntitlementBlocked(provider: ProviderKind, id: string): Promise<void>;

  recordCooldown(
    provider: ProviderKind,
    id: string,
    reason: "auth-failure" | "network-error",
    until: number,
  ): Promise<void>;

  markDeadCandidate(provider: ProviderKind, id: string): Promise<void>;

  touchLastUsed(provider: ProviderKind, id: string): Promise<void>;

  list(provider: ProviderKind): RotationAccount[];

  /**
   * Optional re-read after refresh (organizationId may change).
   * Falls back to the selected account when omitted.
   */
  get?(provider: ProviderKind, id: string): RotationAccount | undefined;

  /** Optional success-metric sink passed to adapter.recordSuccess. */
  recordRateLimit?(id: string, snap: Record<string, unknown>): Promise<void>;
  recordUsage?(id: string, snap: Record<string, unknown>): Promise<void>;
  recordPlan?(id: string, snap: Record<string, unknown>): Promise<void>;
  recordBillingQuota?(id: string, snap: Record<string, unknown>): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Best-effort cancel of a response body we are DISCARDING (a rotate/retry path).
 * Never call this on a response we RETURN.
 */
function discardBody(res: Response | undefined): void {
  res?.body?.cancel().catch(() => {});
}

/** Coerce the various fetch input shapes into a parseable URL. */
function toURL(input: FetchInput): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL((input as Request).url);
}

/**
 * Read at most `maxBytes` of a CLONE of the response body, for classification.
 * The original `res` is left untouched.
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const clone = res.clone();
  const reader = clone.body?.getReader();
  if (!reader) {
    try {
      return await clone.text();
    } catch {
      return "";
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch {
    // A partial read is fine for classification.
  } finally {
    reader.cancel().catch(() => {});
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.min(c.byteLength, maxBytes - offset));
    merged.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= maxBytes) break;
  }
  return new TextDecoder().decode(merged);
}

/** Outcome of a single outward HTTP attempt against one bearer. */
interface Attempt {
  res?: Response;
  classification: Classification;
  error?: unknown;
  bodyText?: string;
}

/**
 * Perform ONE request via adapter headers and classify the result.
 * Authorization is always built by the adapter (overwrite, never append).
 */
async function doRequest(
  adapter: ProviderAdapter,
  url: string,
  init: FetchInit | undefined,
  accessToken: string,
  accountId: string,
  organizationId: string | undefined,
  promptCacheKey: string | undefined,
): Promise<Attempt> {
  const headers = adapter.buildHeaders({
    accessToken,
    accountId,
    organizationId,
    promptCacheKey,
    initHeaders: init?.headers as
      | Headers
      | Record<string, string | ReadonlyArray<string>>
      | Array<[string, string]>
      | undefined,
  });

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err) {
    return { classification: adapter.classifyThrownError(err), error: err };
  }

  // Trust the status line on 2xx: return original (unconsumed) for streaming.
  if (res.status >= 200 && res.status < 300) {
    return { res, classification: { kind: "ok" } };
  }

  const bodyText = await readBoundedText(res, MAX_CLASSIFY_BYTES);
  return {
    res,
    bodyText,
    classification: await adapter.classifyResponse(res, bodyText),
  };
}

type Handled =
  | { action: "return"; res: Response }
  | { action: "throw"; error: unknown }
  | { action: "rotate"; backoffMs?: number }
  | { action: "auth-recover" };

interface HandleCtx {
  allowAuthRecover: boolean;
  warnEntitlement: (id: string) => void;
  record: SuccessRecordSink;
}

async function handleAttempt(
  adapter: ProviderAdapter,
  manager: RotationManager,
  provider: ProviderKind,
  attempt: Attempt,
  id: string,
  ctx: HandleCtx,
): Promise<Handled> {
  const c = attempt.classification;
  switch (c.kind) {
    case "ok": {
      await manager.touchLastUsed(provider, id);
      if (attempt.res) {
        void adapter
          .recordSuccess({
            accountId: id,
            response: attempt.res,
            bodyText: attempt.bodyText,
            record: ctx.record,
          })
          .catch(() => {});
      }
      return { action: "return", res: attempt.res as Response };
    }

    case "transient": {
      return { action: "rotate", backoffMs: NETWORK_BACKOFF_MS };
    }

    case "quota-exhausted": {
      const resetAt = c.resetAtMs ?? Date.now() + QUOTA_FALLBACK_MS;
      await manager.markQuotaExhausted(provider, id, resetAt);
      return { action: "rotate" };
    }

    case "entitlement-blocked": {
      await manager.markEntitlementBlocked(provider, id);
      ctx.warnEntitlement(id);
      return { action: "rotate" };
    }

    case "auth-dead": {
      if (ctx.allowAuthRecover) {
        return { action: "auth-recover" };
      }
      // NEVER mark dead here — only refresh-grant invalid_grant does that.
      await manager.recordCooldown(
        provider,
        id,
        "auth-failure",
        Date.now() + AUTH_COOLDOWN_MS,
      );
      return { action: "rotate" };
    }

    case "server":
    case "network": {
      return { action: "rotate", backoffMs: NETWORK_BACKOFF_MS };
    }

    case "unknown-client-error": {
      // Client/param error — return as-is; do NOT rotate (oracle B1).
      if (attempt.res) return { action: "return", res: attempt.res };
      return {
        action: "throw",
        error:
          attempt.error ??
          new Error(`multi-ai: unknown client error (${adapter.provider})`),
      };
    }
  }
}

/**
 * Synthesize the terminal 503 when no account can serve the request.
 * `retry-after` = earliest recovery across the pool.
 */
export function buildExhaustedResponse(
  manager: RotationManager,
  provider: ProviderKind,
  count: number,
  displayName: string,
): Response {
  const now = Date.now();
  let earliest = Number.POSITIVE_INFINITY;
  for (const a of manager.list(provider)) {
    if (typeof a.quotaResetAt === "number" && a.quotaResetAt > now) {
      earliest = Math.min(earliest, a.quotaResetAt);
    }
    if (typeof a.coolingDownUntil === "number" && a.coolingDownUntil > now) {
      earliest = Math.min(earliest, a.coolingDownUntil);
    }
  }

  const headers = new Headers({ "content-type": "application/json" });
  const body: Record<string, unknown> = {
    error: `All ${count} ${displayName} accounts exhausted`,
  };
  if (Number.isFinite(earliest)) {
    const retryAfterSec = Math.max(0, Math.ceil((earliest - now) / 1000));
    headers.set("retry-after", String(retryAfterSec));
    body.retryAfterSeconds = retryAfterSec;
    body.earliestResetAt = earliest;
  }

  return new Response(JSON.stringify(body), { status: 503, headers });
}

function asRecordSink(manager: RotationManager): SuccessRecordSink {
  return {
    recordRateLimit: manager.recordRateLimit?.bind(manager),
    recordUsage: manager.recordUsage?.bind(manager),
    recordPlan: manager.recordPlan?.bind(manager),
    recordBillingQuota: manager.recordBillingQuota?.bind(manager),
  };
}

/**
 * Build a `fetch`-compatible function that:
 *   resolveUrl (adapter) → selectAccount → ensureFreshToken →
 *   buildHeaders/transformBody (adapter) → fetch → classify → handle.
 *
 * `manager` is required until AccountManager singleton (todo 8) exists.
 */
export function createRotationFetch(
  adapter: ProviderAdapter,
  manager: RotationManager,
): (input: FetchInput, init?: FetchInit) => Promise<Response> {
  const provider = adapter.provider;
  const record = asRecordSink(manager);

  return async function rotationFetch(
    input: FetchInput,
    init?: FetchInit,
  ): Promise<Response> {
    const parsedUrl = toURL(input);

    // URL policy lives ONLY in the adapter (host-pin vs rewrite).
    // Do not attach Authorization before this resolves.
    let resolvedUrl: string;
    try {
      resolvedUrl = adapter.resolveUrl(parsedUrl);
    } catch (err) {
      // Host-pin refusal etc. — surface immediately (no token was sent).
      throw err;
    }

    const sessionID = sessionIdFromHeaders(
      init?.headers as Headers | Record<string, string> | undefined,
    );
    const sessionOpts = getSessionOptions(sessionID);
    const requestInit =
      adapter.transformBody(init, {
        url: resolvedUrl,
        sessionOptions: sessionOpts as Record<string, unknown> | undefined,
      }) ?? init;
    const promptCacheKey =
      typeof sessionOpts?.promptCacheKey === "string"
        ? sessionOpts.promptCacheKey
        : undefined;

    const attempted = new Set<string>();
    const poolSize = manager.list(provider).length;
    let warnedEntitlement = false;
    const warnEntitlement = (id: string): void => {
      if (warnedEntitlement) return;
      warnedEntitlement = true;
      logger.warn(
        `account ${id} (${provider}) is entitlement-blocked; skipping in selection`,
      );
    };

    for (let i = 0; i < poolSize; i++) {
      const account = manager.selectAccount(provider, attempted);
      if (!account) break;
      const id = account.accountId;
      attempted.add(id);

      let accessToken: string;
      try {
        const tokens = await manager.ensureFreshToken(provider, id);
        accessToken = tokens.accessToken;
      } catch (err) {
        if (isInvalidGrantError(err)) {
          await manager.markDeadCandidate(provider, id);
        } else {
          await sleep(NETWORK_BACKOFF_MS);
        }
        continue;
      }

      const live = manager.get?.(provider, id) ?? account;
      const organizationId = live.organizationId;

      let attempt = await doRequest(
        adapter,
        resolvedUrl,
        requestInit,
        accessToken,
        id,
        organizationId,
        promptCacheKey,
      );

      // transient → ONE same-account backoff + retry (does not burn a slot).
      if (attempt.classification.kind === "transient") {
        await sleep(TRANSIENT_BACKOFF_MS);
        discardBody(attempt.res);
        attempt = await doRequest(
          adapter,
          resolvedUrl,
          requestInit,
          accessToken,
          id,
          organizationId,
          promptCacheKey,
        );
      }

      let handled = await handleAttempt(
        adapter,
        manager,
        provider,
        attempt,
        id,
        { allowAuthRecover: true, warnEntitlement, record },
      );

      // auth-dead recovery: force refresh once, then same handler without recover.
      if (handled.action === "auth-recover") {
        discardBody(attempt.res);
        let refreshedToken: string;
        try {
          const fresh = await manager.ensureFreshToken(provider, id, true);
          refreshedToken = fresh.accessToken;
        } catch (err) {
          if (isInvalidGrantError(err)) {
            await manager.markDeadCandidate(provider, id);
          } else {
            await sleep(NETWORK_BACKOFF_MS);
          }
          continue;
        }

        const liveAfter = manager.get?.(provider, id) ?? live;
        attempt = await doRequest(
          adapter,
          resolvedUrl,
          requestInit,
          refreshedToken,
          id,
          liveAfter.organizationId,
          promptCacheKey,
        );
        handled = await handleAttempt(
          adapter,
          manager,
          provider,
          attempt,
          id,
          { allowAuthRecover: false, warnEntitlement, record },
        );
      }

      switch (handled.action) {
        case "return":
          return handled.res;
        case "throw":
          discardBody(attempt.res);
          throw handled.error;
        case "rotate":
          discardBody(attempt.res);
          if (handled.backoffMs) await sleep(handled.backoffMs);
          continue;
      }
    }

    logger.warn(
      `all ${poolSize} ${adapter.displayName} account(s) exhausted for this request`,
    );
    return buildExhaustedResponse(
      manager,
      provider,
      poolSize,
      adapter.displayName,
    );
  };
}
