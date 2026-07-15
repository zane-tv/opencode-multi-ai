import { describe, it, expect } from "vitest";

import { InvalidGrantError, TransientAuthError } from "../lib/providers/xai/auth/oauth.js";
import {
  AUTH_DEAD_RE,
  ENTITLEMENT_RE,
  QUOTA_EXHAUSTED_RE,
  RATE_LIMIT_RE,
  classifyResponse,
  classifyThrownError,
  parseRetryAfterMs,
  type Classification,
} from "../lib/providers/xai/request/classify-error.js";

/**
 * Real error envelopes observed from xAI (undocumented). Sources: live P0
 * spike, moltbot PR #86614, oh-my-pi PR #4913. The error envelope shape is
 * NOT first-party confirmed (P0 spike returned 200), so both the flat and the
 * nested OpenAI shapes are exercised below.
 */
const FIXTURES = {
  ok200: JSON.stringify({
    id: "chatcmpl-abc",
    object: "chat.completion",
    model: "grok-4.3",
    choices: [
      {
        message: {
          role: "assistant",
          content: "hi",
          reasoning_content: "thinking",
        },
      },
    ],
    usage: { cost_in_usd_ticks: 4706000 },
  }),

  rateLimit429: JSON.stringify({
    code: "Some resource has been exhausted",
    error: "Rate limit exceeded",
  }),

  creditExhausted429: JSON.stringify({
    code: "Some resource has been exhausted",
    error:
      "Your team team-xxx has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.",
  }),

  // NOTE: code says "permission" but error names a credit cap → quota-exhausted.
  creditExhausted403: JSON.stringify({
    code: "The caller does not have permission to execute the specified operation",
    error:
      "Your team team-xxx has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.",
  }),

  oauthCreditExhausted403: JSON.stringify({
    code: "The caller does not have permission to execute the specified operation",
    error:
      "personal-team-blocked:spending-limit — your team has run out of credits.",
  }),

  // Pure tier-gate 403 (#26847): permission strings, NO credit/quota strings.
  entitlement403: JSON.stringify({
    code: "The caller does not have permission to execute the specified operation",
    error:
      "The caller does not have permission to execute the specified operation. Your account is not on the allowlist for this API surface.",
  }),

  invalidKey400: JSON.stringify({
    code: "Client specified an invalid argument",
    error:
      "Incorrect API key provided: xa***en. You can obtain an API key from https://console.x.ai.",
  }),

  revokedToken401: JSON.stringify({
    code: "Unauthenticated",
    error: "The provided token has been revoked.",
  }),

  serverError: JSON.stringify({
    code: "Internal",
    error: "internal server error",
  }),

  // === Nested OpenAI-style envelopes (B-C) ===
  nestedRateLimit429: JSON.stringify({
    error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" },
  }),
  nestedCreditExhausted403: JSON.stringify({
    error: {
      message:
        "Your team team-xxx has either used all available credits or reached its monthly spending limit.",
      code: "permission_denied",
    },
  }),
  nestedEntitlement403: JSON.stringify({
    error: {
      message:
        "The caller does not have permission to execute the specified operation.",
      code: "permission_denied",
    },
  }),
  nestedInvalidKey400: JSON.stringify({
    error: {
      message: "Incorrect API key provided: xa***en.",
      code: "invalid_api_key",
    },
  }),

  // === Param / token-count 400s that must NOT be auth-dead (B-A) ===
  maxTokensInvalid400: JSON.stringify({
    code: "Client specified an invalid argument",
    error: "max_tokens 200000 is invalid for this model.",
  }),
  completionTokenLimit400: JSON.stringify({
    code: "Client specified an invalid argument",
    error: "completion token limit is invalid.",
  }),
  messagesTokens400: JSON.stringify({
    code: "invalid argument",
    error:
      "the messages resulted in 320000 tokens which is invalid; reduce the input.",
  }),
  reasoningEffort400: JSON.stringify({
    code: "Client specified an invalid argument",
    error: "invalid value for reasoning_effort: 'high'.",
  }),
  // Param allowlist 400 must NOT become entitlement-blocked (S-A).
  paramAllowlist400: JSON.stringify({
    code: "Client specified an invalid argument",
    error: "not on the allowlist for reasoning_effort=high.",
  }),
};

describe("classifyResponse — success", () => {
  it("classifies 2xx as ok", () => {
    expect(classifyResponse(200, {}, FIXTURES.ok200)).toEqual({ kind: "ok" });
    expect(classifyResponse(204, {}, "")).toEqual({ kind: "ok" });
  });

  // S-C: v1 trusts the status line on the initial response.
  it("treats a 2xx carrying an error envelope as ok (v1 scope)", () => {
    const c = classifyResponse(200, {}, FIXTURES.creditExhausted429);
    expect(c).toEqual({ kind: "ok" });
  });
});

describe("classifyResponse — transient rate limit", () => {
  it("classifies 429 rate limit as transient", () => {
    const c = classifyResponse(429, {}, FIXTURES.rateLimit429);
    expect(c.kind).toBe("transient");
  });

  it("extracts retryAfterMs from retry-after seconds header", () => {
    const c = classifyResponse(
      429,
      { "retry-after": "30" },
      FIXTURES.rateLimit429,
    );
    expect(c).toEqual({ kind: "transient", retryAfterMs: 30_000 });
  });

  // P-A: every 429 (once quota/auth/entitlement excluded) is transient, even
  // with an unrecognized message.
  it("classifies a 429 with an unknown message as transient", () => {
    const c = classifyResponse(429, {}, JSON.stringify({ error: "slow down" }));
    expect(c.kind).toBe("transient");
  });
});

describe("classifyResponse — quota exhausted (recoverable)", () => {
  it("classifies 429 credit exhaustion as quota-exhausted", () => {
    const c = classifyResponse(429, {}, FIXTURES.creditExhausted429);
    expect(c.kind).toBe("quota-exhausted");
  });

  // Oracle B1 regression guard: 403 whose code says "permission" but whose
  // error names a credit cap MUST be quota-exhausted, NOT entitlement-blocked.
  it("B1 GUARD: 403 with credit strings → quota-exhausted (NOT entitlement)", () => {
    const c = classifyResponse(403, {}, FIXTURES.creditExhausted403);
    expect(c.kind).toBe("quota-exhausted");
    expect(c.kind).not.toBe("entitlement-blocked");
  });

  // B1 guard must also hold for the nested OpenAI shape (B-C).
  it("B1 GUARD (nested): nested 403 credit strings → quota-exhausted", () => {
    const c = classifyResponse(403, {}, FIXTURES.nestedCreditExhausted403);
    expect(c.kind).toBe("quota-exhausted");
    expect(c.kind).not.toBe("entitlement-blocked");
  });

  it("classifies OAuth 403 run-out-of-credits as quota-exhausted", () => {
    const c = classifyResponse(403, {}, FIXTURES.oauthCreditExhausted403);
    expect(c.kind).toBe("quota-exhausted");
  });

  it("records resetAtMs when a retry hint is present", () => {
    const before = Date.now();
    const c = classifyResponse(
      429,
      { "retry-after": "60" },
      FIXTURES.creditExhausted429,
    );
    expect(c.kind).toBe("quota-exhausted");
    if (c.kind === "quota-exhausted") {
      expect(c.resetAtMs).toBeGreaterThanOrEqual(before + 60_000 - 1000);
      expect(c.resetAtMs).toBeLessThanOrEqual(Date.now() + 60_000 + 1000);
    }
  });

  it("omits resetAtMs when no retry hint present", () => {
    const c = classifyResponse(403, {}, FIXTURES.creditExhausted403);
    expect(c).toEqual({ kind: "quota-exhausted" });
  });
});

describe("classifyResponse — entitlement blocked (tier-gate #26847)", () => {
  it("pure permission 403 without credit strings → entitlement-blocked", () => {
    const c = classifyResponse(403, {}, FIXTURES.entitlement403);
    expect(c).toEqual({ kind: "entitlement-blocked" });
  });

  it("nested pure permission 403 → entitlement-blocked", () => {
    const c = classifyResponse(403, {}, FIXTURES.nestedEntitlement403);
    expect(c).toEqual({ kind: "entitlement-blocked" });
  });

  // S-A: entitlement is gated to 403. The same permission string on a non-403
  // must NOT be entitlement-blocked.
  it("permission phrasing on a 400 is NOT entitlement-blocked", () => {
    const c = classifyResponse(
      400,
      {},
      JSON.stringify({ error: "does not have permission" }),
    );
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });

  // S-A: a param-allowlist 400 must not be mistaken for a tier-gate.
  it("param allowlist 400 → unknown-client-error (NOT entitlement)", () => {
    const c = classifyResponse(400, {}, FIXTURES.paramAllowlist400);
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });
});

describe("classifyResponse — auth dead", () => {
  it("classifies 400 incorrect api key as auth-dead", () => {
    const c = classifyResponse(400, {}, FIXTURES.invalidKey400);
    expect(c).toEqual({ kind: "auth-dead" });
  });

  it("classifies nested 400 incorrect api key as auth-dead", () => {
    const c = classifyResponse(400, {}, FIXTURES.nestedInvalidKey400);
    expect(c).toEqual({ kind: "auth-dead" });
  });

  it("classifies 401 revoked token as auth-dead", () => {
    const c = classifyResponse(401, {}, FIXTURES.revokedToken401);
    expect(c).toEqual({ kind: "auth-dead" });
  });

  it("classifies bare 401 with no known string as auth-dead", () => {
    const c = classifyResponse(401, {}, "unauthorized");
    expect(c).toEqual({ kind: "auth-dead" });
  });
});

// B-A: param / token-count validation 400s must NEVER be auth-dead — that
// would refresh + retry the same malformed request and churn a healthy account.
describe("classifyResponse — B-A: param 400s are NOT auth-dead", () => {
  it("max_tokens invalid → unknown-client-error", () => {
    const c = classifyResponse(400, {}, FIXTURES.maxTokensInvalid400);
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });

  it("completion token limit invalid → unknown-client-error", () => {
    const c = classifyResponse(400, {}, FIXTURES.completionTokenLimit400);
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });

  it("messages resulted in N tokens invalid → unknown-client-error", () => {
    const c = classifyResponse(400, {}, FIXTURES.messagesTokens400);
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });

  it("invalid value for reasoning_effort → unknown-client-error", () => {
    const c = classifyResponse(400, {}, FIXTURES.reasoningEffort400);
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });
});

describe("classifyResponse — server errors", () => {
  it("classifies 500 as server", () => {
    const c = classifyResponse(500, {}, FIXTURES.serverError);
    expect(c.kind).toBe("server");
  });

  it("classifies 503 as server", () => {
    const c = classifyResponse(503, {}, "");
    expect(c.kind).toBe("server");
  });

  it("classifies unparseable 5xx body as server", () => {
    const c = classifyResponse(502, {}, "<html>Bad Gateway</html>");
    expect(c.kind).toBe("server");
  });

  it("extracts retryAfterMs for server errors", () => {
    const c = classifyResponse(503, { "retry-after": "5" }, "");
    expect(c).toEqual({ kind: "server", retryAfterMs: 5000 });
  });
});

describe("classifyResponse — unknown client errors (conservative)", () => {
  it("classifies unmatched 400 as unknown-client-error", () => {
    const c = classifyResponse(400, {}, JSON.stringify({ error: "bad json" }));
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });

  it("classifies unparseable 4xx body as unknown-client-error", () => {
    const c = classifyResponse(400, {}, "<html>Bad Request</html>");
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });

  it("classifies 404 as unknown-client-error", () => {
    const c = classifyResponse(404, {}, JSON.stringify({ error: "not found" }));
    expect(c).toEqual({ kind: "unknown-client-error", status: 404 });
  });

  it("classifies 403 with no known string as unknown-client-error", () => {
    const c = classifyResponse(403, {}, JSON.stringify({ error: "nope" }));
    expect(c).toEqual({ kind: "unknown-client-error", status: 403 });
  });
});

describe("classifyResponse — body shape handling", () => {
  it("accepts an already-parsed object body", () => {
    const c = classifyResponse(429, {}, {
      code: "Some resource has been exhausted",
      error: "Rate limit exceeded",
    });
    expect(c.kind).toBe("transient");
  });

  it("accepts a parsed object for the quota case", () => {
    const c = classifyResponse(403, {}, {
      code: "permission",
      error: "used all available credits",
    });
    expect(c.kind).toBe("quota-exhausted");
  });

  it("treats empty 4xx body as unknown-client-error", () => {
    const c = classifyResponse(400, {}, "");
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });

  // B-C: nested OpenAI shape must be parsed, not dropped.
  it("classifies nested rate-limit 429 as transient", () => {
    const c = classifyResponse(429, {}, FIXTURES.nestedRateLimit429);
    expect(c.kind).toBe("transient");
  });

  it("accepts an already-parsed nested object body", () => {
    const c = classifyResponse(403, {}, {
      error: { message: "used all available credits", code: "permission" },
    });
    expect(c.kind).toBe("quota-exhausted");
  });
});

describe("classifyResponse — Headers instance support", () => {
  it("reads retry-after from a Headers instance", () => {
    const h = new Headers({ "retry-after": "15" });
    const c = classifyResponse(429, h, FIXTURES.rateLimit429);
    expect(c).toEqual({ kind: "transient", retryAfterMs: 15_000 });
  });
});

describe("classifyThrownError", () => {
  it("maps InvalidGrantError → auth-dead", () => {
    const err = new InvalidGrantError("invalid_grant", 400, "invalid_grant");
    expect(classifyThrownError(err)).toEqual({ kind: "auth-dead" });
  });

  it("maps TransientAuthError → network", () => {
    const err = new TransientAuthError("timeout");
    expect(classifyThrownError(err)).toEqual({ kind: "network" });
  });

  it("maps a fetch TypeError → network", () => {
    const err = new TypeError("fetch failed");
    expect(classifyThrownError(err)).toEqual({ kind: "network" });
  });

  it("maps ECONNRESET-coded error → network", () => {
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(classifyThrownError(err)).toEqual({ kind: "network" });
  });

  it("maps an AbortError by name → network", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyThrownError(err)).toEqual({ kind: "network" });
  });

  it("maps unknown thrown value → unknown-client-error status 0", () => {
    expect(classifyThrownError(new Error("weird"))).toEqual({
      kind: "unknown-client-error",
      status: 0,
    });
    expect(classifyThrownError("string throw")).toEqual({
      kind: "unknown-client-error",
      status: 0,
    });
  });
});

describe("parseRetryAfterMs", () => {
  it("parses retry-after-ms directly", () => {
    expect(parseRetryAfterMs({ "retry-after-ms": "2500" })).toBe(2500);
  });

  it("parses retry-after seconds", () => {
    expect(parseRetryAfterMs({ "retry-after": "10" })).toBe(10_000);
  });

  it("parses retry-after HTTP-date as a delta", () => {
    const future = new Date(Date.now() + 20_000).toUTCString();
    const ms = parseRetryAfterMs({ "retry-after": future });
    expect(ms).toBeGreaterThan(15_000);
    expect(ms).toBeLessThanOrEqual(21_000);
  });

  it("parses x-ratelimit-reset delta seconds", () => {
    expect(parseRetryAfterMs({ "x-ratelimit-reset": "3" })).toBe(3000);
  });

  it("parses x-ratelimit-reset-ms delta", () => {
    expect(parseRetryAfterMs({ "x-ratelimit-reset-ms": "1200" })).toBe(1200);
  });

  it("returns undefined when no header present", () => {
    expect(parseRetryAfterMs({})).toBeUndefined();
  });

  it("returns undefined for a non-numeric, non-date value", () => {
    expect(parseRetryAfterMs({ "retry-after": "soon" })).toBeUndefined();
  });

  // === B-B: epoch handling and clamping ===
  it("converts a near-future epoch (seconds) to a small delta", () => {
    const epochSec = Math.floor((Date.now() + 5000) / 1000);
    const ms = parseRetryAfterMs({ "x-ratelimit-reset": String(epochSec) });
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(6000);
  });

  it("clamps a past epoch (seconds) to 0", () => {
    const pastSec = Math.floor((Date.now() - 5000) / 1000);
    const ms = parseRetryAfterMs({ "x-ratelimit-reset": String(pastSec) });
    expect(ms).toBe(0);
  });

  it("converts a near-future epoch (ms) to a small delta", () => {
    const epochMs = Date.now() + 5000;
    const ms = parseRetryAfterMs({ "x-ratelimit-reset-ms": String(epochMs) });
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(6000);
  });

  it("clamps a huge delta to the 24h ceiling", () => {
    const ms = parseRetryAfterMs({ "retry-after-ms": "999999999999" });
    expect(ms).toBe(86_400_000);
  });

  it("clamps a huge retry-after seconds delta to the ceiling", () => {
    // Below the epoch threshold, so treated as a (very large) delta.
    const ms = parseRetryAfterMs({ "retry-after": "999999999" });
    expect(ms).toBe(86_400_000);
  });

  // === S-D: unit-suffixed values ===
  it("parses a unit-suffixed seconds value (7.6s)", () => {
    expect(parseRetryAfterMs({ "retry-after": "7.6s" })).toBe(7600);
  });

  it("parses a unit-suffixed ms value (500ms)", () => {
    expect(parseRetryAfterMs({ "retry-after": "500ms" })).toBe(500);
  });

  it("parses a compound unit value (2m59s)", () => {
    expect(parseRetryAfterMs({ "retry-after": "2m59s" })).toBe(179_000);
  });

  it("parses a minutes-only unit value (2m)", () => {
    expect(parseRetryAfterMs({ "retry-after": "2m" })).toBe(120_000);
  });
});

describe("exported regex constants", () => {
  it("RATE_LIMIT_RE matches rate limit phrasing", () => {
    expect(RATE_LIMIT_RE.test("Rate limit exceeded")).toBe(true);
    expect(RATE_LIMIT_RE.test("Too many requests")).toBe(true);
  });

  it("QUOTA_EXHAUSTED_RE matches the strong credit phrasings", () => {
    expect(QUOTA_EXHAUSTED_RE.test("used all available credits")).toBe(true);
    expect(QUOTA_EXHAUSTED_RE.test("monthly spending limit")).toBe(true);
    expect(QUOTA_EXHAUSTED_RE.test("run out of credits")).toBe(true);
    expect(QUOTA_EXHAUSTED_RE.test("personal-team-blocked:spending-limit")).toBe(
      true,
    );
  });

  // S-B: bare upsell copy must not trigger quota rotation on its own.
  it("QUOTA_EXHAUSTED_RE does NOT match bare upsell copy", () => {
    expect(QUOTA_EXHAUSTED_RE.test("purchase more credits to unlock Pro")).toBe(
      false,
    );
  });

  it("ENTITLEMENT_RE matches account/API-surface permission phrasing", () => {
    expect(ENTITLEMENT_RE.test("The caller does not have permission")).toBe(
      true,
    );
    expect(
      ENTITLEMENT_RE.test("your account is not on the allowlist for this API"),
    ).toBe(true);
  });

  // S-A: a bare param allowlist message must not match entitlement.
  it("ENTITLEMENT_RE does NOT match a param allowlist message", () => {
    expect(
      ENTITLEMENT_RE.test("not on the allowlist for reasoning_effort=high"),
    ).toBe(false);
  });

  it("AUTH_DEAD_RE matches credential phrasing", () => {
    expect(AUTH_DEAD_RE.test("Incorrect API key provided")).toBe(true);
    expect(AUTH_DEAD_RE.test("invalid api key")).toBe(true);
    expect(AUTH_DEAD_RE.test("token has been revoked")).toBe(true);
    expect(AUTH_DEAD_RE.test("Unauthenticated")).toBe(true);
  });

  // B-A: the tightened regex must NOT match token-count / param 400s.
  it("AUTH_DEAD_RE does NOT match token-count / param validation messages", () => {
    expect(AUTH_DEAD_RE.test("max_tokens 200000 is invalid")).toBe(false);
    expect(AUTH_DEAD_RE.test("completion token limit is invalid")).toBe(false);
    expect(
      AUTH_DEAD_RE.test("the messages resulted in 320000 tokens which is invalid"),
    ).toBe(false);
    expect(AUTH_DEAD_RE.test("invalid value for reasoning_effort")).toBe(false);
  });
});

// Type-level sanity: the union is exhaustive over `kind`.
describe("Classification type", () => {
  it("covers every kind at runtime", () => {
    const kinds: Classification["kind"][] = [
      "ok",
      "transient",
      "quota-exhausted",
      "entitlement-blocked",
      "auth-dead",
      "server",
      "network",
      "unknown-client-error",
    ];
    expect(new Set(kinds).size).toBe(8);
  });
});
