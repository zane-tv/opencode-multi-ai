/**
 * Codex / ChatGPT usage windows via `GET .../wham/usage` and `x-codex-*`
 * response headers.
 *
 * Absolute billing/plan endpoints from other providers are intentionally NOT used here.
 * planType is an opaque string from the backend (do not invent Plus/Pro enums).
 */

import { CODEX_BASE_URL } from "../constants.js";
import { createCodexHeaders } from "./codex-headers.js";

/** Epoch-seconds vs epoch-ms heuristic (matches classify-error / task contract). */
const EPOCH_SECONDS_MS_THRESHOLD = 1e10;

/**
 * Snapshot of Codex primary/secondary rate-limit windows.
 * Field names align with AccountMetadata + AccountManager.recordUsage.
 */
export type CodexUsageSummary = {
  planType?: string;
  primaryUsedPercent?: number;
  primaryWindowMinutes?: number;
  /** Epoch ms when the primary window resets. */
  primaryResetAt?: number;
  secondaryUsedPercent?: number;
  secondaryWindowMinutes?: number;
  /** Epoch ms when the secondary window resets. */
  secondaryResetAt?: number;
  activeLimit?: string;
  observedAt: number;
};

type UsageWindowRaw = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
};

/**
 * True when `windowMinutes === 0`: the window is DISABLED.
 * Must not be rendered as "100% free" / unlimited capacity.
 */
export function isWindowDisabled(
  windowMinutes: number | undefined,
): boolean {
  return windowMinutes === 0;
}

/** Remaining capacity percent (clamped 0–100). */
export function leftPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

/**
 * Human label for a window length in minutes.
 *  - 0 → "disabled" (window off; not free capacity)
 *  - 300 → "5h"
 *  - 10080 → "Weekly"
 *  - other hour-aligned → "Nh"
 *  - else → "Nm"
 */
export function windowLabel(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes)) return "n/a";
  if (minutes === 0) return "disabled";
  if (minutes === 10_080) return "Weekly";
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}h`;
  }
  return `${minutes}m`;
}

/**
 * Prefer reset-after-seconds → now + n*1000;
 * else reset-at as epoch seconds (<1e10), epoch ms, or ISO date string.
 */
export function parseResetAt(
  resetAfterSeconds: unknown,
  resetAt: unknown,
  nowMs: number = Date.now(),
): number | undefined {
  const after = asFiniteNumber(resetAfterSeconds);
  if (after !== undefined && after >= 0) {
    return nowMs + after * 1000;
  }
  return coerceEpochMs(resetAt);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function coerceEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < EPOCH_SECONDS_MS_THRESHOLD) return value * 1000;
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return coerceEpochMs(n);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function secondsToMinutes(seconds: unknown): number | undefined {
  const s = asFiniteNumber(seconds);
  if (s === undefined) return undefined;
  // Round to nearest minute; 0 stays 0 (disabled).
  return Math.round(s / 60);
}

function parseWindow(
  raw: UsageWindowRaw | null | undefined,
  nowMs: number,
): {
  usedPercent?: number;
  windowMinutes?: number;
  resetAt?: number;
} {
  if (!raw || typeof raw !== "object") return {};
  const usedPercent = asFiniteNumber(raw.used_percent);
  const windowMinutes = secondsToMinutes(raw.limit_window_seconds);
  const resetAt = parseResetAt(
    raw.reset_after_seconds,
    raw.reset_at,
    nowMs,
  );
  return {
    usedPercent: usedPercent !== undefined ? usedPercent : undefined,
    windowMinutes,
    resetAt,
  };
}

/**
 * Parse `GET .../wham/usage` JSON body into CodexUsageSummary.
 *
 * Expected shape (best-effort; missing fields stay undefined):
 * ```
 * {
 *   plan_type?: string,
 *   rate_limit?: {
 *     primary_window?: { used_percent, limit_window_seconds, reset_at, reset_after_seconds },
 *     secondary_window?: { ... }
 *   },
 *   credits?: unknown  // ignored — not stored on AccountMetadata
 * }
 * ```
 */
export function parseUsagePayload(
  json: unknown,
  nowMs: number = Date.now(),
): CodexUsageSummary {
  const root =
    json && typeof json === "object"
      ? (json as Record<string, unknown>)
      : {};

  const planType =
    typeof root.plan_type === "string" && root.plan_type.trim() !== ""
      ? root.plan_type
      : undefined;

  const rateLimit =
    root.rate_limit && typeof root.rate_limit === "object"
      ? (root.rate_limit as Record<string, unknown>)
      : {};

  const primary = parseWindow(
    rateLimit.primary_window as UsageWindowRaw | undefined,
    nowMs,
  );
  const secondary = parseWindow(
    rateLimit.secondary_window as UsageWindowRaw | undefined,
    nowMs,
  );

  // Optional top-level active limit hint (string or nested).
  let activeLimit: string | undefined;
  if (typeof root.active_limit === "string" && root.active_limit.trim()) {
    activeLimit = root.active_limit;
  } else if (typeof rateLimit.active_limit === "string" && rateLimit.active_limit.trim()) {
    activeLimit = rateLimit.active_limit as string;
  }

  return {
    planType,
    primaryUsedPercent: primary.usedPercent,
    primaryWindowMinutes: primary.windowMinutes,
    primaryResetAt: primary.resetAt,
    secondaryUsedPercent: secondary.usedPercent,
    secondaryWindowMinutes: secondary.windowMinutes,
    secondaryResetAt: secondary.resetAt,
    activeLimit,
    observedAt: nowMs,
  };
}

function headerString(
  headers: Headers,
  name: string,
): string | undefined {
  const raw = headers.get(name);
  if (raw == null || raw === "") return undefined;
  return raw;
}

function headerNumber(
  headers: Headers,
  name: string,
): number | undefined {
  const raw = headerString(headers, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse `x-codex-*` usage headers from a successful inference (or usage) response.
 *
 * Headers:
 *  - x-codex-primary-used-percent
 *  - x-codex-primary-window-minutes
 *  - x-codex-primary-reset-at
 *  - x-codex-primary-reset-after-seconds
 *  - x-codex-secondary-used-percent
 *  - x-codex-secondary-window-minutes
 *  - x-codex-secondary-reset-at
 *  - x-codex-secondary-reset-after-seconds
 *  - x-codex-plan-type
 *  - x-codex-active-limit
 */
export function parseUsageHeaders(
  headers: Headers,
  nowMs: number = Date.now(),
): CodexUsageSummary {
  const planType = headerString(headers, "x-codex-plan-type");
  const activeLimit = headerString(headers, "x-codex-active-limit");

  const primaryUsedPercent = headerNumber(
    headers,
    "x-codex-primary-used-percent",
  );
  const primaryWindowMinutes = headerNumber(
    headers,
    "x-codex-primary-window-minutes",
  );
  const primaryResetAt = parseResetAt(
    headerString(headers, "x-codex-primary-reset-after-seconds"),
    headerString(headers, "x-codex-primary-reset-at"),
    nowMs,
  );

  const secondaryUsedPercent = headerNumber(
    headers,
    "x-codex-secondary-used-percent",
  );
  const secondaryWindowMinutes = headerNumber(
    headers,
    "x-codex-secondary-window-minutes",
  );
  const secondaryResetAt = parseResetAt(
    headerString(headers, "x-codex-secondary-reset-after-seconds"),
    headerString(headers, "x-codex-secondary-reset-at"),
    nowMs,
  );

  return {
    planType,
    primaryUsedPercent,
    primaryWindowMinutes,
    primaryResetAt,
    secondaryUsedPercent,
    secondaryWindowMinutes,
    secondaryResetAt,
    activeLimit,
    observedAt: nowMs,
  };
}

/**
 * Live probe: GET `${CODEX_BASE_URL}/wham/usage`.
 * Reuses createCodexHeaders, then overrides accept → application/json.
 */
export async function fetchCodexUsage(
  accessToken: string,
  accountId: string,
  organizationId?: string,
): Promise<CodexUsageSummary> {
  const headers = createCodexHeaders({
    accessToken,
    accountId,
    organizationId,
  });
  headers.set("accept", "application/json");

  const url = `${CODEX_BASE_URL}/wham/usage`;
  const res = await fetch(url, {
    method: "GET",
    headers,
  });

  const nowMs = Date.now();
  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(
      `usage probe failed HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
    );
  }

  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `usage probe returned non-JSON body: ${text.slice(0, 120)}`,
      );
    }
  }

  // Prefer body; fill gaps from response headers when present.
  const fromBody = parseUsagePayload(json, nowMs);
  const fromHeaders = parseUsageHeaders(res.headers, nowMs);

  return {
    planType: fromBody.planType ?? fromHeaders.planType,
    primaryUsedPercent:
      fromBody.primaryUsedPercent ?? fromHeaders.primaryUsedPercent,
    primaryWindowMinutes:
      fromBody.primaryWindowMinutes ?? fromHeaders.primaryWindowMinutes,
    primaryResetAt: fromBody.primaryResetAt ?? fromHeaders.primaryResetAt,
    secondaryUsedPercent:
      fromBody.secondaryUsedPercent ?? fromHeaders.secondaryUsedPercent,
    secondaryWindowMinutes:
      fromBody.secondaryWindowMinutes ?? fromHeaders.secondaryWindowMinutes,
    secondaryResetAt:
      fromBody.secondaryResetAt ?? fromHeaders.secondaryResetAt,
    activeLimit: fromBody.activeLimit ?? fromHeaders.activeLimit,
    observedAt: nowMs,
  };
}
