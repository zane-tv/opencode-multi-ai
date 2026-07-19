import { InvalidGrantError, TransientAuthError } from "../auth/oauth.js";

/**
 * Error classifier for xAI API responses.
 *
 * xAI is OpenAI-compatible. Because our P0 spike returned HTTP 200 (success),
 * the *error* envelope shape is NOT confirmed by first-party evidence. We
 * therefore handle BOTH shapes defensively:
 *   - flat:   {"error":"...","code":"..."}
 *   - nested: {"error":{"message":"...","code":"..."}}   (OpenAI-style)
 *
 * xAI also does NOT distinguish error kinds by HTTP status. A single status
 * (notably 403) carries THREE distinct meanings, each needing a different
 * pipeline action, so we parse the message string and return a discriminated
 * union rather than a simple transient/terminal split.
 *
 * This module is PURE and SYNCHRONOUS: no I/O, no logging. The caller owns
 * logging and the resulting account-pool mutations. All message strings are
 * isolated as named exported constants so they are easy to update if xAI
 * changes wording (the envelopes are undocumented).
 *
 * SCOPE (v1, oracle S3): classifyResponse only inspects the initial response
 * status/headers/body. Streaming-body classification is out of scope for v1;
 * a non-stream 2xx response that happens to carry an error envelope is treated
 * as `ok` (we trust the status line on the initial response).
 */

/**
 * Per-minute rate limit phrasing (429).
 *
 * INFORMATIONAL ONLY — not decision-load-bearing. Once quota / auth-dead /
 * entitlement are excluded, every 429 is treated as `transient` regardless of
 * whether this pattern matches. Kept exported for diagnostics/tests.
 */
export const RATE_LIMIT_RE = /rate limit exceeded|too many requests/i;

/**
 * Monthly/periodic subscription cap. RECOVERABLE — this is the common
 * auto-switch trigger. Rotate to a sibling account and record a reset time;
 * the account RECOVERS next cycle. These strings NEVER mean the subscription
 * is cancelled and must NEVER map to auth-dead or a prune.
 *
 * Anchored on STRONG confirmed signals only. Bare "purchase more credits" was
 * dropped (S-B): it appears in tier-upsell copy and risks a blind rotate.
 * `run out of credits` / `personal-team-blocked` are the oh-my-pi confirmed
 * OAuth quota signals and are retained.
 */
export const QUOTA_EXHAUSTED_RE =
  /used all available credits|monthly spending limit|spending-limit|run out of credits|personal-team-blocked|out of credits|need a grok subscription|add credits at/i;

/**
 * Account not allowlisted for the OAuth API surface (xAI issue #26847).
 * Sibling accounts on the same tier will 403 identically, so blind rotation
 * loops forever. Mark the account and SKIP it in selection; do NOT rotate the
 * whole pool.
 *
 * Anchored to account / API-surface language (S-A) so a param-allowlist error
 * such as "not on the allowlist for reasoning_effort=high" does NOT match.
 * Only consulted for status === 403.
 */
export const ENTITLEMENT_RE =
  /does not have permission|account .*not .*allowlist|not on the allowlist for this api/i;

/**
 * Revoked / invalid access token or API key. Terminal for that credential.
 *
 * Anchored STRICTLY to credential language (B-A). It must NOT match
 * token-COUNT / context-length / param-validation 400s such as
 * "max_tokens ... is invalid" or "completion token limit is invalid" — those
 * must fall through to unknown-client-error, not churn a healthy account.
 */
export const AUTH_DEAD_RE =
  /incorrect api key|invalid api key|api key .*(invalid|revoked)|token has been revoked|unauthenticated/i;

/** Discriminated classification of an xAI response or thrown error. */
export type Classification =
  | { kind: "ok" }
  /** Per-minute rate limit — backoff, KEEP account. */
  | { kind: "transient"; retryAfterMs?: number }
  /** Monthly/periodic cap — ROTATE to sibling, account RECOVERS. */
  | { kind: "quota-exhausted"; resetAtMs?: number }
  /** Tier-gate #26847 — mark account, warn, SKIP in selection. */
  | { kind: "entitlement-blocked" }
  /** Refresh grant invalid_grant / revoked token — cooldown/remove. */
  | { kind: "auth-dead" }
  /** 5xx — backoff then rotate if persistent. */
  | { kind: "server"; retryAfterMs?: number }
  /** fetch threw / network error — backoff then rotate. */
  | { kind: "network" }
  /** Other 4xx — conservative: do NOT rotate the whole pool. */
  | { kind: "unknown-client-error"; status: number };

/**
 * Upper bound on any retry/reset delay we will return, in ms. A misread epoch
 * or a pathological header must never bench a healthy account for days
 * (oracle B-B). 24h is generous for any real per-minute or monthly signal
 * (callers apply their own recovery cadence on top).
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
}

/**
 * Iterate headers (Headers instance or plain object) with lower-cased keys.
 * Single reusable walk shared by getHeader / findHeader (P-B).
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
 * unit-suffixed values like "7.6s", "500ms", "2m59s" are not dropped as NaN
 * (oracle S-D). A bare number is reported via `rawNumber` so the caller can
 * apply epoch-vs-delta detection with the correct default unit.
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
 * - Unit-suffixed values are always deltas (nobody encodes an epoch with a
 *   `s`/`ms` suffix) → clamp directly.
 * - Bare numbers use a unit-appropriate epoch threshold: a value that looks
 *   like an absolute epoch is converted to `epoch - now`; otherwise it is a
 *   delta. All results are clamped, so a slightly-past epoch → ~0 and a huge
 *   delta → the ceiling (oracle B-B).
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
 * headers. xAI's rate-limit headers are undocumented, so we probe several
 * conventions and fall back to undefined. All returned values are clamped to
 * a sane ceiling and epoch values are converted to deltas (oracle B-B).
 *
 * Order of preference:
 *  - `retry-after-ms`            (ms delta)
 *  - `retry-after`               (seconds delta, unit-suffixed, or HTTP-date)
 *  - `x-ratelimit-reset*-ms`     (ms — epoch or delta)
 *  - `x-ratelimit-reset*`        (seconds — epoch or delta)
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

  return undefined;
}

/**
 * Defensively coerce a raw body (string or already-parsed object) into an
 * `{code, error}` envelope. Handles BOTH the flat shape
 * (`{"error":"...","code":"..."}`) and the nested OpenAI shape
 * (`{"error":{"message":"...","code":"..."}}`) so the classifier is never
 * silently defeated (oracle B-C). Non-JSON strings expose the raw text as
 * `error` so message regexes can still run.
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

    // Nested OpenAI shape: { error: { message, code|type } }.
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
      return { error: message, code: nestedCode ?? topCode };
    }

    // Flat shape: { error: "...", code: "..." }, with a `message` fallback.
    const code = typeof rec.code === "string" ? rec.code : undefined;
    const error = typeof rec.error === "string" ? rec.error : undefined;
    const message = typeof rec.message === "string" ? rec.message : undefined;
    return { code, error: error ?? message };
  }

  return {};
}

/** Text used for message matching: combine `error` and `code`. */
function matchText(env: ErrorEnvelope): string {
  return `${env.error ?? ""} ${env.code ?? ""}`;
}

/**
 * Classify an HTTP response from the xAI API.
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
  // v1 (S-C): trust the status line on the initial response. A 2xx is `ok`
  // even if the body happens to carry an error envelope; stream-body error
  // detection is out of scope for v1.
  if (status >= 200 && status < 300) {
    return { kind: "ok" };
  }

  // 5xx — server error. Parse-independent; honor a retry hint if present.
  if (status >= 500) {
    const retryAfterMs = parseRetryAfterMs(headers);
    return retryAfterMs === undefined
      ? { kind: "server" }
      : { kind: "server", retryAfterMs };
  }

  const env = parseEnvelope(body);
  const text = matchText(env);

  // Quota check MUST come first: a 403 whose code says "permission" but whose
  // error names a credit/spending cap is quota-exhausted, NOT entitlement.
  // (Oracle B1 regression guard — holds for flat AND nested shapes.)
  if (QUOTA_EXHAUSTED_RE.test(text)) {
    const resetAtMs = resetAtFromHeaders(headers);
    return resetAtMs === undefined
      ? { kind: "quota-exhausted" }
      : { kind: "quota-exhausted", resetAtMs };
  }

  // Revoked / invalid token or API key. Terminal for the credential. Checked
  // before entitlement so a real "invalid key" is auth-dead; the tightened
  // regex (B-A) will NOT match token-count / param-validation 400s.
  if (AUTH_DEAD_RE.test(text)) {
    return { kind: "auth-dead" };
  }

  // Tier-gate #26847 — permission/allowlist, gated to 403 (S-A) and with the
  // quota cap already excluded above.
  if (status === 403 && ENTITLEMENT_RE.test(text)) {
    return { kind: "entitlement-blocked" };
  }

  // Every remaining 429 → transient backoff (P-A). We do not burn the pool on
  // a rate limit; RATE_LIMIT_RE is informational only.
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers);
    return retryAfterMs === undefined
      ? { kind: "transient" }
      : { kind: "transient", retryAfterMs };
  }

  // 401 with no recognized token string is still an auth failure.
  if (status === 401) {
    return { kind: "auth-dead" };
  }

  // Any other 4xx — conservative. Caller must NOT rotate the whole pool.
  return { kind: "unknown-client-error", status };
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
