/**
 * OpenCode Go dashboard quota fetch.
 *
 * The OpenCode Go API (`https://opencode.ai/zen/go/v1`) exposes NO quota via
 * response headers (no `X-RateLimit-*`). Quota is fetched by SCRAPING the
 * dashboard HTML at `https://opencode.ai/workspace/<workspaceID>/go` with an
 * **auth cookie** (not the API key) — same approach as the reference
 * implementation `github.com/opgginc/opencode-bar` `OpenCodeGoProvider`.
 *
 * The dashboard HTML inlines three usage windows (server-side rendered,
 * possibly inside SolidJS `$R[N] = {…}` hydration objects):
 *
 *   rollingUsage: { usagePercent, resetInSec }   // 5-hour window
 *   weeklyUsage:  { usagePercent, resetInSec }
 *   monthlyUsage: { usagePercent, resetInSec }
 *
 * Quota is WORKSPACE-LEVEL: it is shared across every pool key, so callers
 * must display it once per workspace (tab-level), never per account.
 *
 * Credential source: per-account first, ENV fallback (no browser cookie scan):
 *   account.openCodeGoWorkspaceId / account.openCodeGoAuthCookie  (preferred)
 *   MULTI_AI_OPENCODE_GO_WORKSPACE_ID  (legacy: OPENCODE_GO_WORKSPACE_ID)
 *   MULTI_AI_OPENCODE_GO_AUTH_COOKIE   (legacy: OPENCODE_GO_AUTH_COOKIE)
 *
 * This fetch is READ-ONLY and runs at probe time only — it is not a request
 * interceptor and never touches the rotation pool.
 */

const DASHBOARD_URL = "https://opencode.ai/workspace";
const DASHBOARD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** One dashboard usage window (workspace-level). */
export interface OpenCodeGoUsageWindow {
  /** 0-100, percent of the window used. */
  usagePercent: number;
  /** Seconds from fetch time until the window resets. */
  resetInSeconds: number;
  /** Epoch ms when the window resets (`now + resetInSeconds * 1000`). */
  resetAt: number;
}

/** Parsed dashboard usage; only windows that parsed successfully are set. */
export interface OpenCodeGoDashboardUsage {
  rolling?: OpenCodeGoUsageWindow; // 5-hour window
  weekly?: OpenCodeGoUsageWindow;
  monthly?: OpenCodeGoUsageWindow;
}

/**
 * True when at least one usage window parsed. Shared by probe callers
 * (adapter / TUI / probe tool) to distinguish "the workspace exists but has
 * NO Go subscription" (`{}` from a 200 dashboard page) from "no data at all"
 * (`undefined` — no cred configured or the fetch failed).
 */
export function hasAnyUsage(usage: {
  rolling?: unknown;
  weekly?: unknown;
  monthly?: unknown;
}): boolean {
  return (
    usage.rolling !== undefined ||
    usage.weekly !== undefined ||
    usage.monthly !== undefined
  );
}

/** Env-only dashboard credentials (workspace id + auth cookie value). */
export interface OpenCodeGoDashboardCred {
  /** `wrk_XXXX` workspace id. */
  workspaceId: string;
  /**
   * Raw auth cookie value — WITHOUT the `auth=` prefix. Callers must strip
   * the prefix before storing (see `normalizeAuthCookie`). `fetchDashboardUsage`
   * always prepends `auth=` itself.
   */
  authCookie: string;
}

/**
 * Strip a leading `auth=` prefix (if present) and trim. Callers should run
 * user-entered cookie values through this before storing, so the persisted
 * field is always the raw value and `fetchDashboardUsage` can prepend the
 * `auth=` cookie name on its own. NEVER log the raw value.
 */
export function normalizeAuthCookie(input: string): string {
  let v = input.trim();
  if (v.toLowerCase().startsWith("auth=")) v = v.slice("auth=".length);
  return v.trim();
}

/**
 * Resolve dashboard credentials from the environment.
 *
 * `MULTI_AI_OPENCODE_GO_WORKSPACE_ID` / `MULTI_AI_OPENCODE_GO_AUTH_COOKIE`
 * preferred; legacy `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE`
 * fallbacks. Both must be non-empty (after trim) or `null` is returned.
 */
export function resolveDashboardCred(): OpenCodeGoDashboardCred | null {
  const workspaceId = (
    process.env.MULTI_AI_OPENCODE_GO_WORKSPACE_ID ??
    process.env.OPENCODE_GO_WORKSPACE_ID ??
    ""
  ).trim();
  const authCookie = (
    process.env.MULTI_AI_OPENCODE_GO_AUTH_COOKIE ??
    process.env.OPENCODE_GO_AUTH_COOKIE ??
    ""
  ).trim();
  if (workspaceId === "" || authCookie === "") return null;
  return { workspaceId, authCookie };
}

/**
 * Resolve dashboard credentials for a specific account, falling back to the
 * environment.
 *
 * Precedence: when the account carries BOTH a non-empty (after trim)
 * `openCodeGoWorkspaceId` and `openCodeGoAuthCookie`, those win — per-account
 * creds support multiple Go subscriptions / workspaces in one pool. Otherwise
 * `resolveDashboardCred()` (env) is used, and `null` is returned when neither
 * source has a complete pair. The auth cookie value is SENSITIVE — callers
 * must never log it.
 */
export function resolveDashboardCredForAccount(account: {
  openCodeGoWorkspaceId?: string;
  openCodeGoAuthCookie?: string;
}): OpenCodeGoDashboardCred | null {
  const workspaceId = (account.openCodeGoWorkspaceId ?? "").trim();
  const authCookie = (account.openCodeGoAuthCookie ?? "").trim();
  if (workspaceId !== "" && authCookie !== "") {
    return { workspaceId, authCookie };
  }
  return resolveDashboardCred();
}

/**
 * Fetch and parse the workspace dashboard usage.
 *
 * GET `https://opencode.ai/workspace/<workspaceId>/go` with header
 * `Cookie: auth=<value>`. The `authCookie` field must already be the raw
 * value (no `auth=` prefix); if a legacy caller passes `auth=…` the prefix
 * is normalized away here so the header is never `auth=auth=…`. Throws on
 * non-2xx (message includes the HTTP status); the caller decides how to
 * surface failures.
 */
export async function fetchDashboardUsage(
  cred: OpenCodeGoDashboardCred,
  now: number = Date.now(),
): Promise<OpenCodeGoDashboardUsage> {
  const raw = normalizeAuthCookie(cred.authCookie);
  const res = await fetch(
    `${DASHBOARD_URL}/${encodeURIComponent(cred.workspaceId)}/go`,
    {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Cookie: `auth=${raw}`,
        "User-Agent": DASHBOARD_USER_AGENT,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`dashboard fetch failed HTTP ${res.status}`);
  }
  return parseDashboardUsageHTML(await res.text(), now);
}

/**
 * Port of opencode-bar's `normalizedDashboardHTML`: decode the HTML-entity
 * and escaped forms the dashboard markup uses around field names/values.
 * Replacement order is significant and mirrors the Swift reference.
 */
export function normalizeDashboardHTML(html: string): string {
  let text = html;
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ["&quot;", '"'],
    ["&#34;", '"'],
    ["&#x27;", "'"],
    ["&#39;", "'"],
    ["&amp;", "&"],
    ['\\"', '"'],
    ["\\u0022", '"'],
  ];
  for (const [encoded, decoded] of replacements) {
    text = text.split(encoded).join(decoded);
  }
  return text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Port of opencode-bar's `captureObjectBody`: match
 * `"name": {…}` with optional quotes, optional SolidJS `$R[N] = ` prefix,
 * and capture the (nested-free) object body.
 */
function captureObjectBody(
  fieldName: string,
  text: string,
): string | undefined {
  const pattern = new RegExp(
    `["']?${escapeRegExp(fieldName)}["']?\\s*:\\s*` +
      `(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{(?<body>[^{}]*)\\}`,
    "s",
  );
  const match = text.match(pattern);
  const body = match?.groups?.body;
  return body === undefined ? undefined : body;
}

/**
 * Port of opencode-bar's `captureNumber`: first `"name": <number>` (value
 * optionally double-quoted, e.g. `"usagePercent":"25"`).
 */
function captureNumber(fieldName: string, text: string): number | undefined {
  const pattern = new RegExp(
    `["']?${escapeRegExp(fieldName)}["']?\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)"?`,
  );
  const match = text.match(pattern);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Port of opencode-bar's `parseWindow`: extract one usage window body and its
 * `usagePercent` / `resetInSec` numbers. `resetInSeconds` is floored at 0;
 * `resetAt` = `now + resetInSeconds * 1000`.
 */
function parseWindow(
  fieldName: string,
  text: string,
  now: number,
): OpenCodeGoUsageWindow | undefined {
  const body = captureObjectBody(fieldName, text);
  if (body === undefined) return undefined;
  const usagePercent = captureNumber("usagePercent", body);
  const resetInSeconds = captureNumber("resetInSec", body);
  if (usagePercent === undefined || resetInSeconds === undefined) {
    return undefined;
  }
  const resetSec = Math.max(0, Math.round(resetInSeconds));
  return {
    usagePercent,
    resetInSeconds: resetSec,
    resetAt: now + resetSec * 1000,
  };
}

/**
 * Parse dashboard HTML into usage windows. Missing windows are simply
 * omitted; when ALL three windows are missing the result is `{}` and the
 * caller decides whether to treat that as a failure.
 */
export function parseDashboardUsageHTML(
  html: string,
  now: number = Date.now(),
): OpenCodeGoDashboardUsage {
  const text = normalizeDashboardHTML(html);
  const usage: OpenCodeGoDashboardUsage = {};
  const rolling = parseWindow("rollingUsage", text, now);
  const weekly = parseWindow("weeklyUsage", text, now);
  const monthly = parseWindow("monthlyUsage", text, now);
  if (rolling !== undefined) usage.rolling = rolling;
  if (weekly !== undefined) usage.weekly = weekly;
  if (monthly !== undefined) usage.monthly = monthly;
  return usage;
}
