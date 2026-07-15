/**
 * Codex ProviderAdapter — ChatGPT/Codex multi-account wiring for the shared core.
 *
 * URL rewrite (not host-pin), Codex headers, body transform, classify table,
 * usage recording, models catalog, host-auth bootstrap. Does NOT implement
 * rotation-fetch (core) or plugin.ts (wave 4).
 */

import type {
  BuildHeadersContext,
  Classification,
  ProviderAdapter,
  RecordSuccessContext,
  ResolveModelsOptions,
  TransformBodyContext,
} from "../../core/adapter.js";
import { formatUntil } from "../../core/format-time.js";
import { accountDisplayName } from "../../core/tui-status.js";
import {
  CODEX_BASE_URL,
  DUMMY_API_KEY,
  PROVIDER_ID,
} from "./constants.js";
import {
  bootstrapHostAuthIfNeeded,
  ensureHostAuthAfterLogin,
} from "./auth/host-auth.js";
import {
  classifyResponse as classifyCodexResponse,
  classifyThrownError as classifyCodexThrownError,
} from "./request/classify-error.js";
import { rewriteUrlForCodex } from "./request/codex-url.js";
import { createCodexHeaders } from "./request/codex-headers.js";
import { transformCodexRequestInit } from "./request/body-transform.js";
import {
  fetchCodexUsage,
  isWindowDisabled,
  leftPercent,
  parseUsageHeaders,
  windowLabel,
} from "./request/usage.js";
import {
  CODEX_PROVIDER_DEFAULT_OPTIONS,
  resolveCodexMultiModels,
} from "./models-sync.js";

function sessionOptionsToBody(
  sessionOptions: Record<string, unknown> | undefined,
): {
  reasoningEffort?: string;
  reasoningSummary?: string;
  textVerbosity?: string;
} {
  if (!sessionOptions) return {};
  const out: {
    reasoningEffort?: string;
    reasoningSummary?: string;
    textVerbosity?: string;
  } = {};
  if (typeof sessionOptions.reasoningEffort === "string") {
    out.reasoningEffort = sessionOptions.reasoningEffort;
  }
  if (typeof sessionOptions.reasoningSummary === "string") {
    out.reasoningSummary = sessionOptions.reasoningSummary;
  }
  if (typeof sessionOptions.textVerbosity === "string") {
    out.textVerbosity = sessionOptions.textVerbosity;
  }
  return out;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function usageLine(
  label: string,
  usedPercent: number | undefined,
  windowMinutes: number | undefined,
  resetAt: number | undefined,
  now: number,
): string | undefined {
  if (usedPercent === undefined && windowMinutes === undefined) return undefined;
  if (isWindowDisabled(windowMinutes)) {
    return `${label}: disabled`;
  }
  const left =
    usedPercent === undefined ? "?" : `${leftPercent(usedPercent)}% left`;
  const win = windowLabel(windowMinutes);
  const until =
    typeof resetAt === "number" && resetAt > now
      ? ` · resets ${formatUntil(resetAt, now)}`
      : "";
  return `${label}: ${left} (${win})${until}`;
}

export const codexAdapter: ProviderAdapter = {
  id: PROVIDER_ID,
  provider: "codex",
  displayName: "Codex Multi-Account",
  npmPackage: "@ai-sdk/openai",
  baseURL: CODEX_BASE_URL,
  dummyApiKey: DUMMY_API_KEY,

  resolveUrl(input: string | URL): string {
    return rewriteUrlForCodex(input);
  },

  buildHeaders(ctx: BuildHeadersContext): Headers {
    const headers = createCodexHeaders({
      accessToken: ctx.accessToken,
      accountId: ctx.accountId,
      organizationId: ctx.organizationId,
      promptCacheKey: ctx.promptCacheKey,
    });
    // Merge caller headers underneath, then re-apply Codex required fields so
    // dummy SDK keys / x-api-key cannot win.
    if (ctx.initHeaders) {
      const init = new Headers(ctx.initHeaders);
      init.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower === "authorization" || lower === "x-api-key") return;
        if (!headers.has(key)) headers.set(key, value);
      });
    }
    headers.set("Authorization", `Bearer ${ctx.accessToken}`);
    headers.delete("x-api-key");
    return headers;
  },

  transformBody(
    init: RequestInit | undefined,
    ctx: TransformBodyContext,
  ): RequestInit | undefined {
    // SSE→JSON for stream:false is applied in the fetch layer (rotation-fetch /
    // plugin customFetch), not here — body transform stays pure JSON rewrite.
    void ctx.url;
    return transformCodexRequestInit(
      init,
      sessionOptionsToBody(ctx.sessionOptions),
    );
  },

  classifyResponse(
    res: Response,
    bodyText: string,
  ): Classification | Promise<Classification> {
    return classifyCodexResponse(res.status, res.headers, bodyText);
  },

  classifyThrownError(err: unknown): Classification {
    return classifyCodexThrownError(err);
  },

  async recordSuccess(ctx: RecordSuccessContext): Promise<void> {
    try {
      const snap = parseUsageHeaders(ctx.response.headers);
      const hasSignal =
        snap.planType !== undefined ||
        snap.primaryUsedPercent !== undefined ||
        snap.secondaryUsedPercent !== undefined ||
        snap.activeLimit !== undefined ||
        snap.primaryWindowMinutes !== undefined ||
        snap.secondaryWindowMinutes !== undefined;
      if (!hasSignal) return;
      if (!ctx.record.recordUsage) return;
      await ctx.record.recordUsage(ctx.accountId, {
        planType: snap.planType,
        primaryUsedPercent: snap.primaryUsedPercent,
        primaryWindowMinutes: snap.primaryWindowMinutes,
        primaryResetAt: snap.primaryResetAt,
        secondaryUsedPercent: snap.secondaryUsedPercent,
        secondaryWindowMinutes: snap.secondaryWindowMinutes,
        secondaryResetAt: snap.secondaryResetAt,
        activeLimit: snap.activeLimit,
        observedAt: snap.observedAt,
      });
    } catch {
      /* never throw into the success path */
    }
  },

  async probeQuota(
    accessToken: string,
    account: { accountId: string; organizationId?: string },
  ): Promise<Record<string, unknown>> {
    const usage = await fetchCodexUsage(
      accessToken,
      account.accountId,
      account.organizationId,
    );
    return { ...usage };
  },

  async resolveModels(opts: ResolveModelsOptions): Promise<Record<string, unknown>> {
    return resolveCodexMultiModels({
      accessToken: opts.accessToken,
      userModels: opts.userModels,
      allowNetwork: opts.allowNetwork,
      cachePath: opts.cachePath,
    });
  },

  providerDefaultOptions(): Record<string, unknown> {
    return {
      store: CODEX_PROVIDER_DEFAULT_OPTIONS.store,
      include: [...CODEX_PROVIDER_DEFAULT_OPTIONS.include],
      reasoningEffort: CODEX_PROVIDER_DEFAULT_OPTIONS.reasoningEffort,
      reasoningSummary: CODEX_PROVIDER_DEFAULT_OPTIONS.reasoningSummary,
      textVerbosity: CODEX_PROVIDER_DEFAULT_OPTIONS.textVerbosity,
    };
  },

  listSubtitle(account: Record<string, unknown>, now: number): string {
    const plan = asString(account.planType);
    const primary = asNumber(account.primaryUsedPercent);
    const win = asNumber(account.primaryWindowMinutes);
    const resetAt = asNumber(account.primaryResetAt);
    const parts: string[] = [];
    if (plan) parts.push(plan);
    if (isWindowDisabled(win)) {
      parts.push("primary off");
    } else if (primary !== undefined) {
      parts.push(`${leftPercent(primary)}% left`);
      if (typeof resetAt === "number" && resetAt > now) {
        parts.push(`resets ${formatUntil(resetAt, now)}`);
      }
    }
    if (parts.length === 0) {
      return accountDisplayName({
        label: asString(account.label),
        email: asString(account.email),
        accountId: String(account.accountId ?? ""),
      });
    }
    return parts.join(" · ");
  },

  detailLines(account: Record<string, unknown>, now: number): string[] {
    const lines: string[] = [];
    const name = accountDisplayName({
      label: asString(account.label),
      email: asString(account.email),
      accountId: String(account.accountId ?? ""),
    });
    lines.push(name);
    const plan = asString(account.planType);
    if (plan) lines.push(`plan: ${plan}`);
    const primary = usageLine(
      "primary",
      asNumber(account.primaryUsedPercent),
      asNumber(account.primaryWindowMinutes),
      asNumber(account.primaryResetAt),
      now,
    );
    if (primary) lines.push(primary);
    const secondary = usageLine(
      "secondary",
      asNumber(account.secondaryUsedPercent),
      asNumber(account.secondaryWindowMinutes),
      asNumber(account.secondaryResetAt),
      now,
    );
    if (secondary) lines.push(secondary);
    const active = asString(account.activeLimit);
    if (active) lines.push(`active limit: ${active}`);
    if (account.enabled === false) lines.push("disabled");
    if (account.subscriptionStatus === "dead") lines.push("dead");
    if (account.entitlementBlocked === true) lines.push("entitlement blocked");
    return lines;
  },

  hostAuth: {
    bootstrap(providerId: string): boolean {
      return bootstrapHostAuthIfNeeded(providerId);
    },
    ensureAfterLogin(providerId: string, accountId?: string): void {
      ensureHostAuthAfterLogin(providerId, accountId);
    },
  },
};

export default codexAdapter;
