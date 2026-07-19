import { InvalidGrantError, TransientAuthError } from "../auth/oauth.js";

/**
 * Error classifier for ChatGPT/Codex backend-api responses.
 *
 * Codex surfaces errors via HTTP status + OpenAI-style envelopes
 * (`{"error":{"message","code","type"}}`) and flat shapes. Classification is a
 * discriminated union so the fetch rotation pipeline can mark/rotate without
 * re-parsing messages.
 *
 * This module is PURE and SYNCHRONOUS: no I/O, no logging. The caller owns
 * logging and account-pool mutations.
 *
 * SCOPE (v1): classifyResponse only inspects the initial response
 * status/headers/body. Streaming-body classification is out of scope; a 2xx
 * response is always `ok` even if the body later carries an error event.
 */

/**
 * Pure per-request rate limit (not subscription usage cap). INFORMATIONAL for
 * diagnostics; once usage_limit is excluded, plain rate_limit / bare 429 map
 * to `transient` (KEEP account, short backoff).
 */
export const RATE_LIMIT_RE =
  /rate_limit_exceeded|rate_limit|too many requests/i;

/**
 * Subscription / plan usage cap. RECOVERABLE — rotate to a sibling and record
 * reset time. NEVER maps to auth-dead or prune.
 */
export const QUOTA_EXHAUSTED_RE =
  /usage_limit_reached|usage_limit|usage limit/i;

/**
 * Plan does not include this model/surface. Siblings will fail the same way
 * for the same model — mark entitlement-blocked, do NOT treat as quota.
 */
export const ENTITLEMENT_RE =
  /usage_not_included|not[\s_.-]*included[\s_.-]*in[\s_.-]*your[\s_.-]*plan|subscription[\s_.-]*does[\s_.-]*not[\s_.-]*include/i;

/**
 * Credential / session death. Anchored to auth language only — must NOT match
 * usage/credit/limit strings (those stay recoverable).
 */
export const AUTH_DEAD_RE =
  /token has been invalidated|(?:authentication|auth|access|session|login)\s+token\b[^.]*\bsign(?:ing)?[\s-]*in again/i;

/**
 * Structured OAuth / token codes that mean the credential is dead.
 * Matched against the envelope `code` (and nested type) as a whole string.
 */
export const AUTH_DEAD_CODE_RE =
  /^(invalid_token|invalid_grant|token_expired|token_revoked)$/i;

/**
 * Workspace permanently deactivated (often HTTP 402). Terminal for that
 * workspace credential path → auth-dead.
 */
export const DEACTIVATED_WORKSPACE_RE = /deactivated_workspace/i;

/**
 * Upstream overload / temporary unavailability. Maps to `server` even when
 * the HTTP status is not 5xx. Anchored on structured codes + explicit overload
 * phrasing — bare "try again later" is intentionally excluded (it appears in
 * usage_limit copy and must not steal the quota path).
 */
export const SERVER_OVERLOAD_RE =
  /server_is_overloaded|service_unavailable_error|slow_down|servers?\s+(?:are\s+)?(?:currently\s+)?overloaded|(?:server|service)\s+is\s+overloaded/i;

/** Discriminated classification of a Codex response or thrown error. */
export type Classification =
  | { kind: "ok" }
  /** Per-request rate limit — backoff, KEEP account. */
  | { kind: "transient"; retryAfterMs?: number }
  /** Plan usage cap — ROTATE to sibling, account RECOVERS. */
  | { kind: "quota-exhausted"; resetAtMs?: number }
  /** Model/surface not in plan — mark account, SKIP for that path. */
  | { kind: "entitlement-blocked" }
  /** invalid_grant / revoked token / deactivated workspace — cooldown/remove. */
  | { kind: "auth-dead" }
  /** 5xx / overload — backoff then rotate if persistent. */
  | { kind: "server"; retryAfterMs?: number }
  /** fetch threw / network error — backoff then rotate. */
  | { kind: "network" }
  /** Other 4xx — conservative: do NOT rotate the whole pool. */
  | { kind: "unknown-client-error"; status: number };

/**
 * Upper bound on any retry/reset delay we will return, in ms. A misread epoch
 * or a pathological header must never bench a healthy account for days.
 * 24h is generous for any real per-minute or usage-window signal.
 */
const SANE_CEILING_MS = 86_400_000; // 24h

/**
 * A numeric value above this (interpreted as SECONDS) is treated as an
 * absolute epoch rather than a delta. ~year 2001; realistic deltas are orders
 * of magnitude smaller.
 */
const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;

/**
 * A numeric value above this (interpreted as MILLISECONDS) is treated as an
 * absolute epoch rather than a delta. Current epoch ms (~1.7e12) is well
 * above; realistic ms deltas are far below.
 */
const EPOCH_MS_THRESHOLD = 1_000_000_000_000;

/** Parsed `{code, error}` envelope. Both fields are best-effort. */
interface ErrorEnvelope {
  code?: string;
  error?: string;
  resetsAtMs?: number;
}

/**
 * Iterate headers (Headers instance or plain object) with lower-cased keys.
 * Single reusable walk shared by getHeader / findHeader.
 */
function eachHeader(
  headers: Headers | Record<string, string>,
  fn: (key: string, value: string) => void,
): void {
  if (typeof (headers as Headers).forEach === "function") {
    (headers as Headers).forEach((value, key) => fn(key.toLowerCase(), value));
    return;
  }
  const obj = headers as Record<string, string>;
  for (const key of Object.keys(obj)) {
    fn(key.toLowerCase(), obj[key]);
  }
}

/** First header whose (lower-cased) name equals `name`, else undefined. */
function getHeader(
  headers: Headers | Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  let found: string | undefined;
  eachHeader(headers, (k, v) => {
    if (found === undefined && k === lower) found = v;
  });
  return found;
}

/** First header whose (lower-cased) name satisfies `predicate`, else undefined. */
function findHeader(
  headers: Headers | Record<string, string>,
  predicate: (key: string) => boolean,
): string | undefined {
  let found: string | undefined;
  eachHeader(headers, (k, v) => {
    if (found === undefined && predicate(k)) found = v;
  });
  return found;
}

/** Clamp a delay to [0, SANE_CEILING_MS]; non-finite/negative → 0. */
function clampMs(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, SANE_CEILING_MS);
}

interface ParsedDuration {
  /** Delta ms when a unit suffix was present; else `undefined`. */
  ms?: number;
  /** True when a unit suffix (ms/s/m/h) was present. */
  hadUnit: boolean;
  /** Raw number when NO unit suffix was present (epoch detection needed). */
  rawNumber?: number;
  /** Default unit to apply to a bare number for this header. */
  unit: "ms" | "s";
}

/**
 * Parse a duration header value (best-effort). Honors unit suffixes so
 * unit-suffixed values like "7.6s", "500ms", "2m59s" are not dropped as NaN.
 * A bare number is reported via `rawNumber` so the caller can apply
 * epoch-vs-delta detection with the correct default unit.
 */
function parseDurationMs(
  raw: string,
  defaultUnit: "ms" | "s",
): ParsedDuration | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "") return undefined;

  // Sum any unit-suffixed components ("2m59s" → 2m + 59s). "ms" precedes "m"
  // in the alternation so millisecond values are matched correctly.
  const unitRe = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = unitRe.exec(s)) !== null) {
    matched = true;
    const n = Number.parseFloat(m[1]);
    switch (m[2]) {
      case "ms":
        total += n;
        break;
      case "s":
        total += n * 1000;
        break;
      case "m":
        total += n * 60_000;
        break;
      case "h":
        total += n * 3_600_000;
        break;
    }
  }
  if (matched) return { ms: total, hadUnit: true, unit: defaultUnit };

  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return { hadUnit: false, rawNumber: n, unit: defaultUnit };
}

/**
 * Resolve a parsed duration into a clamped delta in ms.
 *
 * - Unit-suffixed values are always deltas → clamp directly.
 * - Bare numbers use a unit-appropriate epoch threshold: a value that looks
 *   like an absolute epoch is converted to `epoch - now`; otherwise it is a
 *   delta. All results are clamped.
 */
function resolveDuration(d: ParsedDuration): number {
  if (d.hadUnit) return clampMs(d.ms ?? 0);
  const v = d.rawNumber ?? 0;
  if (d.unit === "s") {
    if (v > EPOCH_SECONDS_THRESHOLD) return clampMs(v * 1000 - Date.now());
    return clampMs(v * 1000);
  }
  if (v > EPOCH_MS_THRESHOLD) return clampMs(v - Date.now());
  return clampMs(v);
}

/**
 * Best-effort extraction of a retry delay in milliseconds from response
 * headers. Order of preference:
 *  - `retry-after-ms`            (ms delta)
 *  - `retry-after`               (seconds delta, unit-suffixed, or HTTP-date)
 *  - `x-ratelimit-reset*-ms`     (ms — epoch or delta)
 *  - `x-ratelimit-reset*`        (seconds — epoch or delta)
 *  - `x-codex-*-reset-after-seconds` (Codex usage window remaining)
 */
export function parseRetryAfterMs(
  headers: Headers | Record<string, string>,
): number | undefined {
  // retry-after-ms: a millisecond value.
  const retryAfterMs = getHeader(headers, "retry-after-ms");
  if (retryAfterMs !== undefined) {
    const d = parseDurationMs(retryAfterMs, "ms");
    if (d) return resolveDuration(d);
  }

  // retry-after: seconds, unit-suffixed, or an HTTP-date.
  const retryAfter = getHeader(headers, "retry-after");
  if (retryAfter !== undefined) {
    // An HTTP-date carries a month/zone token (3+ consecutive letters); a
    // unit-suffixed value like "2m59s" never does. Prefer date parsing then.
    if (/[a-z]{3}/i.test(retryAfter)) {
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) return clampMs(dateMs - Date.now());
    } else {
      const d = parseDurationMs(retryAfter, "s");
      if (d) return resolveDuration(d);
    }
  }

  // x-ratelimit-reset* — millisecond variants first, then seconds.
  const resetMs = findHeader(
    headers,
    (k) => k.startsWith("x-ratelimit-reset") && k.endsWith("ms"),
  );
  if (resetMs !== undefined) {
    const d = parseDurationMs(resetMs, "ms");
    if (d) return resolveDuration(d);
  }

  const resetSec = findHeader(
    headers,
    (k) => k.startsWith("x-ratelimit-reset") && !k.endsWith("ms"),
  );
  if (resetSec !== undefined) {
    const d = parseDurationMs(resetSec, "s");
    if (d) return resolveDuration(d);
  }

  // Codex usage-window remaining (prefer primary, then secondary, then any).
  const codexPrimary = getHeader(
    headers,
    "x-codex-primary-reset-after-seconds",
  );
  if (codexPrimary !== undefined) {
    const d = parseDurationMs(codexPrimary, "s");
    if (d) return resolveDuration(d);
  }
  const codexSecondary = getHeader(
    headers,
    "x-codex-secondary-reset-after-seconds",
  );
  if (codexSecondary !== undefined) {
    const d = parseDurationMs(codexSecondary, "s");
    if (d) return resolveDuration(d);
  }
  const codexAny = findHeader(
    headers,
    (k) => k.startsWith("x-codex-") && k.endsWith("reset-after-seconds"),
  );
  if (codexAny !== undefined) {
    const d = parseDurationMs(codexAny, "s");
    if (d) return resolveDuration(d);
  }

  return undefined;
}

/**
 * Coerce a unix seconds/ms timestamp (or ISO string) into epoch ms.
 * Returns undefined when the value is not a usable future-ish timestamp.
 */
function coerceEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds vs ms heuristic.
    if (value > EPOCH_MS_THRESHOLD) return value;
    if (value > EPOCH_SECONDS_THRESHOLD) return value * 1000;
    return undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return coerceEpochMs(n);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Defensively coerce a raw body (string or already-parsed object) into an
 * `{code, error}` envelope. Handles:
 *  - nested OpenAI: `{"error":{"message","code"|"type","resets_at"}}`
 *  - flat: `{"error":"...","code":"..."}`
 *  - detail: `{"detail":{"code":"deactivated_workspace"}}`
 *  - OAuth flat string error: `{"error":"invalid_grant"}`
 * Non-JSON strings expose the raw text as `error` so message regexes still run.
 */
function parseEnvelope(body: string | object): ErrorEnvelope {
  let obj: unknown = body;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed === "") return {};
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Not JSON — expose the raw text so message regexes can still match.
      return { error: body };
    }
  }

  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;

    // Nested OpenAI shape: { error: { message, code|type, resets_at } }.
    if (rec.error && typeof rec.error === "object") {
      const nested = rec.error as Record<string, unknown>;
      const message =
        typeof nested.message === "string" ? nested.message : undefined;
      const nestedCode =
        typeof nested.code === "string"
          ? nested.code
          : typeof nested.type === "string"
            ? nested.type
            : undefined;
      const topCode = typeof rec.code === "string" ? rec.code : undefined;
      const resetsAtMs =
        coerceEpochMs(nested.resets_at) ??
        coerceEpochMs(nested.reset_at) ??
        coerceEpochMs(rec.resets_at) ??
        coerceEpochMs(rec.reset_at);
      return {
        error: message,
        code: nestedCode ?? topCode,
        resetsAtMs,
      };
    }

    // detail object: { detail: { code, message } } (deactivated_workspace).
    if (rec.detail && typeof rec.detail === "object") {
      const detail = rec.detail as Record<string, unknown>;
      const detailCode =
        typeof detail.code === "string" ? detail.code : undefined;
      const detailMsg =
        typeof detail.message === "string" ? detail.message : undefined;
      const topCode = typeof rec.code === "string" ? rec.code : undefined;
      const topMsg =
        typeof rec.message === "string"
          ? rec.message
          : typeof rec.error === "string"
            ? rec.error
            : undefined;
      return {
        code: detailCode ?? topCode,
        error: detailMsg ?? topMsg,
        resetsAtMs:
          coerceEpochMs(detail.resets_at) ?? coerceEpochMs(rec.resets_at),
      };
    }

    // Flat shape: { error: "...", code: "..." }, with a `message` fallback.
    // OAuth token endpoint often returns { error: "invalid_grant" }.
    const code = typeof rec.code === "string" ? rec.code : undefined;
    const error = typeof rec.error === "string" ? rec.error : undefined;
    const message = typeof rec.message === "string" ? rec.message : undefined;
    // When error is the OAuth code string itself (invalid_grant), treat as code.
    const oauthCode =
      error !== undefined && AUTH_DEAD_CODE_RE.test(error.trim())
        ? error.trim()
        : undefined;
    return {
      code: code ?? oauthCode,
      error: error ?? message,
      resetsAtMs: coerceEpochMs(rec.resets_at) ?? coerceEpochMs(rec.reset_at),
    };
  }

  return {};
}

/** Text used for message matching: combine `error` and `code`. */
function matchText(env: ErrorEnvelope): string {
  return `${env.error ?? ""} ${env.code ?? ""}`;
}

/**
 * Best-effort absolute reset time (epoch ms) for a quota-exhausted account,
 * derived from a retry hint if one is present.
 */
function resetAtFromHeaders(
  headers: Headers | Record<string, string>,
): number | undefined {
  const ms = parseRetryAfterMs(headers);
  return ms === undefined ? undefined : Date.now() + ms;
}

function withRetryAfter(
  kind: "transient" | "server",
  headers: Headers | Record<string, string>,
): Classification {
  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs === undefined) return { kind };
  return { kind, retryAfterMs };
}

function withQuotaReset(
  headers: Headers | Record<string, string>,
  bodyResetsAtMs?: number,
): Classification {
  // Prefer body resets_at (Codex usage_limit_reached), then headers.
  let resetAtMs = bodyResetsAtMs;
  if (resetAtMs === undefined) {
    resetAtMs = resetAtFromHeaders(headers);
  }
  return resetAtMs === undefined
    ? { kind: "quota-exhausted" }
    : { kind: "quota-exhausted", resetAtMs };
}

/**
 * True when body/code indicates a subscription usage cap (not plain rate limit).
 * Checked before RATE_LIMIT_RE so usage_limit* wins over overlapping phrasing.
 */
function isUsageQuota(text: string, code: string | undefined): boolean {
  if (QUOTA_EXHAUSTED_RE.test(text)) return true;
  if (code && /usage_limit/i.test(code)) return true;
  return false;
}

const OPAQUE_FORBIDDEN_RE =
  /^(?:forbidden|access\s*denied|permission\s*denied)?$/i;

function isOpaqueForbiddenBody(text: string, code: string | undefined): boolean {
  const t = text.trim();
  if (code && code.trim() !== "") return false;
  return OPAQUE_FORBIDDEN_RE.test(t);
}

function isPrimaryWindowExhaustedFromHeaders(
  headers: Headers | Record<string, string>,
): boolean {
  const primaryRaw = getHeader(headers, "x-codex-primary-used-percent");
  if (primaryRaw === undefined || primaryRaw === "") return false;
  const primary = Number(primaryRaw);
  if (!Number.isFinite(primary) || primary < 100) return false;

  const secondaryWinRaw = getHeader(
    headers,
    "x-codex-secondary-window-minutes",
  );
  const secondaryUsedRaw = getHeader(
    headers,
    "x-codex-secondary-used-percent",
  );
  const secondaryWin =
    secondaryWinRaw !== undefined && secondaryWinRaw !== ""
      ? Number(secondaryWinRaw)
      : undefined;
  const secondaryUsed =
    secondaryUsedRaw !== undefined && secondaryUsedRaw !== ""
      ? Number(secondaryUsedRaw)
      : undefined;
  const secondaryOpen =
    typeof secondaryWin === "number" &&
    Number.isFinite(secondaryWin) &&
    secondaryWin > 0 &&
    typeof secondaryUsed === "number" &&
    Number.isFinite(secondaryUsed) &&
    secondaryUsed < 100;
  return !secondaryOpen;
}

function primaryResetAtFromHeaders(
  headers: Headers | Record<string, string>,
): number | undefined {
  const after = getHeader(headers, "x-codex-primary-reset-after-seconds");
  if (after !== undefined && after !== "") {
    const d = parseDurationMs(after, "s");
    if (d) return Date.now() + resolveDuration(d);
  }
  const at = getHeader(headers, "x-codex-primary-reset-at");
  if (at !== undefined && at !== "") {
    return coerceEpochMs(at);
  }
  return undefined;
}

/**
 * True when body/code indicates a pure rate limit (no usage_limit signal).
 */
function isPlainRateLimit(text: string, code: string | undefined): boolean {
  if (isUsageQuota(text, code)) return false;
  if (RATE_LIMIT_RE.test(text)) return true;
  if (code && /rate_limit/i.test(code)) return true;
  return false;
}

function isAuthDeadCode(code: string | undefined): boolean {
  if (!code) return false;
  return AUTH_DEAD_CODE_RE.test(code.trim());
}

function isServerOverload(text: string, code: string | undefined): boolean {
  if (code && /^(server_is_overloaded|slow_down|service_unavailable_error)$/i.test(code.trim())) {
    return true;
  }
  if (code && /server_is_overloaded|service_unavailable/i.test(code)) {
    return true;
  }
  return SERVER_OVERLOAD_RE.test(text);
}

/**
 * Classify an HTTP response from the ChatGPT/Codex backend-api.
 *
 * @param status  HTTP status code.
 * @param headers Response headers (Headers instance or plain object).
 * @param body    Raw body string, or an already-parsed object.
 */
export function classifyResponse(
  status: number,
  headers: Headers | Record<string, string>,
  body: string | object,
): Classification {
  // v1: trust the status line on the initial response. A 2xx is `ok` even if
  // the body happens to carry an error envelope; stream-body error detection
  // is out of scope for v1.
  if (status >= 200 && status < 300) {
    return { kind: "ok" };
  }

  const env = parseEnvelope(body);
  const text = matchText(env);
  const code = env.code;

  // 5xx or overload sentinels (including on non-5xx) → server.
  if (status >= 500 || isServerOverload(text, code)) {
    return withRetryAfter("server", headers);
  }

  // Exact credential-death codes/messages win before all recoverable limits.
  // Keep the existing exact 402 deactivated-workspace terminal signal here too.
  if (
    isAuthDeadCode(code) ||
    AUTH_DEAD_RE.test(text) ||
    (status === 402 &&
      (DEACTIVATED_WORKSPACE_RE.test(text) ||
        (code !== undefined && DEACTIVATED_WORKSPACE_RE.test(code))))
  ) {
    return { kind: "auth-dead" };
  }

  // Usage cap → quota-exhausted (recoverable rotate). Prefer usage_limit* over
  // entitlement copy and bare 401. This also remaps 404 bodies carrying usage
  // strings (Codex sometimes returns 404 for exhausted windows).
  if (isUsageQuota(text, code)) {
    return withQuotaReset(headers, env.resetsAtMs);
  }

  if (isPrimaryWindowExhaustedFromHeaders(headers)) {
    const headerReset =
      primaryResetAtFromHeaders(headers) ?? env.resetsAtMs;
    return withQuotaReset(headers, headerReset);
  }

  // Plain rate limit (body) or bare 429 → transient before entitlement/auth.
  if (status === 429 || isPlainRateLimit(text, code)) {
    return withRetryAfter("transient", headers);
  }

  // Plan does not include this model/surface after recoverable limit signals.
  if (ENTITLEMENT_RE.test(text)) {
    return { kind: "entitlement-blocked" };
  }

  // A remaining bare 401 has no quota or entitlement signal.
  if (status === 401) {
    return { kind: "auth-dead" };
  }

  if (status === 403 && isOpaqueForbiddenBody(text, code)) {
    const headerReset =
      primaryResetAtFromHeaders(headers) ?? env.resetsAtMs;
    return withQuotaReset(headers, headerReset);
  }

  // 404 with no usage/rate signal stays unknown-client (not a remapped 429).
  // Any other remaining 4xx — conservative. Caller must NOT rotate the pool.
  return { kind: "unknown-client-error", status };
}

/**
 * Classify a thrown error (as opposed to an HTTP response). Used when the
 * request pipeline catches an exception rather than receiving a Response.
 *
 *  - InvalidGrantError   → auth-dead (refresh grant rejected, token dead).
 *  - TransientAuthError  → network  (timeout / 5xx / network during auth).
 *  - fetch TypeError     → network  (raw connection failure).
 *  - anything else       → unknown-client-error (status 0; nothing HTTP known).
 */
export function classifyThrownError(err: unknown): Classification {
  if (err instanceof InvalidGrantError) {
    return { kind: "auth-dead" };
  }
  if (err instanceof TransientAuthError) {
    return { kind: "network" };
  }
  // Undici/Node fetch surfaces connection failures as TypeError.
  if (err instanceof TypeError) {
    return { kind: "network" };
  }
  // Some environments tag network errors via name/code instead of type.
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; code?: unknown };
    const name = typeof e.name === "string" ? e.name : "";
    const code = typeof e.code === "string" ? e.code : "";
    if (
      name === "FetchError" ||
      name === "AbortError" ||
      /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(
        code,
      )
    ) {
      return { kind: "network" };
    }
  }
  return { kind: "unknown-client-error", status: 0 };
}
