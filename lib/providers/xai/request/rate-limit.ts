/**
 * Parse xAI inference rate-limit headers and optional usage cost.
 * Headers observed on api.x.ai chat/responses:
 *   x-ratelimit-limit-requests / remaining-requests
 *   x-ratelimit-limit-tokens / remaining-tokens
 * Body usage may include cost_in_usd_ticks (1 USD = 1e10 ticks).
 */

export type RateLimitSnapshot = {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
  costInUsdTicks?: number;
  observedAt: number;
};

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  return {
    limitRequests: headerNumber(headers, "x-ratelimit-limit-requests"),
    remainingRequests: headerNumber(headers, "x-ratelimit-remaining-requests"),
    limitTokens: headerNumber(headers, "x-ratelimit-limit-tokens"),
    remainingTokens: headerNumber(headers, "x-ratelimit-remaining-tokens"),
    observedAt: Date.now(),
  };
}

export function hasRateLimitData(s: RateLimitSnapshot): boolean {
  return (
    s.limitRequests !== undefined ||
    s.remainingRequests !== undefined ||
    s.limitTokens !== undefined ||
    s.remainingTokens !== undefined ||
    s.costInUsdTicks !== undefined
  );
}

export function formatRemaining(
  remaining: number | undefined,
  limit: number | undefined,
): string {
  if (remaining === undefined && limit === undefined) return "n/a";
  if (remaining !== undefined && limit !== undefined) {
    const pct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
    return `${fmtNum(remaining)} / ${fmtNum(limit)} (${pct}%)`;
  }
  if (remaining !== undefined) return `${fmtNum(remaining)} remaining`;
  return `limit ${fmtNum(limit!)}`;
}

export function formatCostUsd(ticks: number | undefined): string {
  if (ticks === undefined) return "n/a";
  const usd = ticks / 10_000_000_000;
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

import {
  CLI_PROXY_BASE,
  CLI_PROXY_ORIGIN,
  CLI_PROXY_REFERER,
  CLI_TOKEN_AUTH_VALUE,
  cliClientVersion,
  getXaiCliProxyMode,
} from "../cli-proxy.js";

/**
 * Cheap probe: tiny chat completion to refresh rate-limit headers.
 * Uses max_tokens=1 so cost stays minimal. In CLI-proxy mode the probe runs
 * against cli-chat-proxy.grok.com with the grok CLI auth headers (api.x.ai
 * rejects subscription tiers without API credits).
 */
export async function probeAccountRateLimit(
  accessToken: string,
  model = "grok-4.5",
): Promise<RateLimitSnapshot> {
  const cliProxy = getXaiCliProxyMode();
  const base = cliProxy ? CLI_PROXY_BASE : "https://api.x.ai/v1";
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  if (cliProxy) {
    headers["x-xai-token-auth"] = CLI_TOKEN_AUTH_VALUE;
    headers["x-grok-client-version"] = cliClientVersion();
    headers["origin"] = CLI_PROXY_ORIGIN;
    headers["referer"] = CLI_PROXY_REFERER;
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
  });

  const snap = parseRateLimitHeaders(res.headers);
  if (res.ok) {
    try {
      const body = (await res.json()) as {
        usage?: { cost_in_usd_ticks?: number };
      };
      if (typeof body.usage?.cost_in_usd_ticks === "number") {
        snap.costInUsdTicks = body.usage.cost_in_usd_ticks;
      }
    } catch {
      // ignore body parse errors; headers still useful
    }
  } else {
    // still return headers if present (429 may include remaining=0)
    const text = await res.text().catch(() => "");
    throw new Error(
      `probe failed HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`,
    );
  }
  return snap;
}
