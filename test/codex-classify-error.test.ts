import { describe, it, expect } from "vitest";

import { InvalidGrantError, TransientAuthError } from "../lib/providers/codex/auth/oauth.js";
import {
  AUTH_DEAD_CODE_RE,
  AUTH_DEAD_RE,
  DEACTIVATED_WORKSPACE_RE,
  ENTITLEMENT_RE,
  QUOTA_EXHAUSTED_RE,
  RATE_LIMIT_RE,
  SERVER_OVERLOAD_RE,
  classifyResponse,
  classifyThrownError,
  parseRetryAfterMs,
  type Classification,
} from "../lib/providers/codex/request/classify-error.js";

/**
 * Codex / ChatGPT backend-api error envelopes.
 * Shapes drawn from openai/codex api_bridge + oc-codex-multi-auth fetch-helpers.
 */
const FIXTURES = {
  ok200: JSON.stringify({
    id: "resp_abc",
    object: "response",
    model: "gpt-5-codex",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
  }),

  // --- auth-dead ---
  unauthorized401: JSON.stringify({
    error: {
      message: "Unauthorized",
      type: "invalid_request_error",
      code: "unauthorized",
    },
  }),

  invalidatedToken401: JSON.stringify({
    error: {
      message:
        "Your authentication token has been invalidated. Please try signing in again.",
      type: "invalid_request_error",
      code: "invalid_token",
    },
  }),

  invalidGrantFlat: JSON.stringify({
    error: "invalid_grant",
    error_description: "Refresh token is invalid or revoked",
  }),

  invalidGrantNested: JSON.stringify({
    error: {
      message: "invalid_grant: token revoked",
      code: "invalid_grant",
      type: "invalid_request_error",
    },
  }),

  tokenExpiredCode: JSON.stringify({
    error: {
      message: "The access token expired",
      code: "token_expired",
    },
  }),

  tokenRevokedCode: JSON.stringify({
    error: {
      message: "Token revoked",
      code: "token_revoked",
    },
  }),

  // --- quota / rate limit ---
  usageLimit429: JSON.stringify({
    error: {
      type: "usage_limit_reached",
      plan_type: "pro",
      resets_at: 1_712_345_678,
      message: "You have reached your usage limit. Please try again later.",
    },
  }),

  usageLimit404: JSON.stringify({
    error: {
      type: "usage_limit_reached",
      code: "usage_limit_reached",
      message: "You have hit your usage limit for this window.",
      resets_at: 1_712_345_678,
    },
  }),

  rateLimit429: JSON.stringify({
    error: {
      message: "Rate limit exceeded",
      type: "rate_limit_exceeded",
      code: "rate_limit_exceeded",
    },
  }),

  rateLimitPlainMessage: JSON.stringify({
    error: {
      message: "rate_limit: too many requests",
      type: "rate_limit",
    },
  }),

  // --- entitlement ---
  usageNotIncluded: JSON.stringify({
    error: {
      type: "usage_not_included",
      code: "usage_not_included",
      message: "This model is not included in your plan.",
    },
  }),

  usageNotIncludedPlanCopy: JSON.stringify({
    error: {
      message: "This feature is not included in your plan.",
      code: "not_found",
    },
  }),

  subscriptionDoesNotInclude: JSON.stringify({
    error: {
      message: "Your subscription does not include this model.",
      type: "invalid_request_error",
    },
  }),

  // --- workspace dead ---
  deactivatedWorkspace402: JSON.stringify({
    detail: { code: "deactivated_workspace" },
  }),

  deactivatedWorkspaceNested: JSON.stringify({
    error: {
      message: "The selected ChatGPT workspace is deactivated.",
      type: "workspace_deactivated",
      code: "deactivated_workspace",
    },
  }),

  // --- server / overload ---
  serverOverloaded503: JSON.stringify({
    error: {
      code: "server_is_overloaded",
      type: "service_unavailable_error",
      message:
        "Our servers are currently overloaded. Please try again later.",
    },
  }),

  serverOverloadedNon5xx: JSON.stringify({
    error: {
      code: "server_is_overloaded",
      type: "service_unavailable_error",
      message: "The server is overloaded. Please try again later.",
    },
  }),

  serverError500: JSON.stringify({
    error: {
      message: "internal server error",
      type: "server_error",
      code: "server_error",
    },
  }),

  // --- unknown client (must NOT rotate / must NOT be auth-dead) ---
  param400: JSON.stringify({
    error: {
      message: "Invalid parameter: max_output_tokens",
      type: "invalid_request_error",
      code: "invalid_value",
    },
  }),

  modelNotFound404: JSON.stringify({
    error: {
      message: "Model not found",
      type: "invalid_request_error",
      code: "model_not_found",
    },
  }),

  // Guard: usage/credit strings must NEVER become auth-dead
  usageLooksLikeAuthNoise: JSON.stringify({
    error: {
      message: "You have used all available credits for this billing period.",
      type: "usage_limit_reached",
      code: "usage_limit_reached",
    },
  }),
};

describe("classifyResponse — success", () => {
  it("classifies 2xx as ok", () => {
    expect(classifyResponse(200, {}, FIXTURES.ok200)).toEqual({ kind: "ok" });
    expect(classifyResponse(204, {}, "")).toEqual({ kind: "ok" });
  });

  it("treats a 2xx carrying an error envelope as ok (v1 scope)", () => {
    const c = classifyResponse(200, {}, FIXTURES.usageLimit429);
    expect(c).toEqual({ kind: "ok" });
  });
});

describe("classifyResponse — auth-dead", () => {
  it("classifies bare 401 as auth-dead", () => {
    expect(classifyResponse(401, {}, FIXTURES.unauthorized401)).toEqual({
      kind: "auth-dead",
    });
  });

  it("classifies 401 invalidated token message as auth-dead", () => {
    expect(classifyResponse(401, {}, FIXTURES.invalidatedToken401)).toEqual({
      kind: "auth-dead",
    });
  });

  it("classifies flat invalid_grant as auth-dead", () => {
    expect(classifyResponse(400, {}, FIXTURES.invalidGrantFlat)).toEqual({
      kind: "auth-dead",
    });
  });

  it("classifies nested invalid_grant as auth-dead", () => {
    expect(classifyResponse(400, {}, FIXTURES.invalidGrantNested)).toEqual({
      kind: "auth-dead",
    });
  });

  it("classifies token_expired / token_revoked codes as auth-dead", () => {
    expect(classifyResponse(400, {}, FIXTURES.tokenExpiredCode)).toEqual({
      kind: "auth-dead",
    });
    expect(classifyResponse(403, {}, FIXTURES.tokenRevokedCode)).toEqual({
      kind: "auth-dead",
    });
  });

  it("classifies an exact invalid_token code as auth-dead", () => {
    expect(
      classifyResponse(
        403,
        {},
        JSON.stringify({
          code: "invalid_token",
          message: "Credential rejected",
        }),
      ),
    ).toEqual({ kind: "auth-dead" });
  });

  it("classifies bare 401 with no body as auth-dead", () => {
    expect(classifyResponse(401, {}, "unauthorized")).toEqual({
      kind: "auth-dead",
    });
  });
});

describe("classifyResponse — quota-exhausted (usage_limit)", () => {
  it("classifies 429 usage_limit_reached as quota-exhausted", () => {
    const c = classifyResponse(429, {}, FIXTURES.usageLimit429);
    expect(c.kind).toBe("quota-exhausted");
    if (c.kind === "quota-exhausted") {
      expect(c.resetAtMs).toBe(1_712_345_678 * 1000);
    }
  });

  it("classifies 404 + usage_limit strings as quota-exhausted (remapped path)", () => {
    const c = classifyResponse(404, {}, FIXTURES.usageLimit404);
    expect(c.kind).toBe("quota-exhausted");
  });

  it("records resetAtMs from retry-after when body has no resets_at", () => {
    const before = Date.now();
    const c = classifyResponse(
      429,
      { "retry-after": "60" },
      JSON.stringify({
        error: { type: "usage_limit_reached", message: "usage limit hit" },
      }),
    );
    expect(c.kind).toBe("quota-exhausted");
    if (c.kind === "quota-exhausted") {
      expect(c.resetAtMs).toBeGreaterThanOrEqual(before + 60_000 - 1000);
      expect(c.resetAtMs).toBeLessThanOrEqual(Date.now() + 60_000 + 1000);
    }
  });

  it("NEVER maps usage/credit strings to auth-dead", () => {
    const c = classifyResponse(429, {}, FIXTURES.usageLooksLikeAuthNoise);
    expect(c.kind).toBe("quota-exhausted");
    expect(c.kind).not.toBe("auth-dead");
  });

  it("classifies 401 usage_limit credit copy before bare auth", () => {
    const c = classifyResponse(401, {}, FIXTURES.usageLooksLikeAuthNoise);
    expect(c.kind).toBe("quota-exhausted");
    expect(c.kind).not.toBe("auth-dead");
  });

  it("classifies usage_limit_reached with plan copy before entitlement", () => {
    const c = classifyResponse(
      403,
      {},
      JSON.stringify({
        code: "usage_limit_reached",
        message: "This model is not included in your plan.",
      }),
    );
    expect(c.kind).toBe("quota-exhausted");
    expect(c.kind).not.toBe("entitlement-blocked");
  });
});

describe("classifyResponse — transient rate limit", () => {
  it("classifies 429 rate_limit_exceeded (no usage_limit) as transient", () => {
    const c = classifyResponse(429, {}, FIXTURES.rateLimit429);
    expect(c.kind).toBe("transient");
  });

  it("classifies plain rate_limit message as transient", () => {
    const c = classifyResponse(429, {}, FIXTURES.rateLimitPlainMessage);
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

  it("classifies a bare 429 with unknown message as transient", () => {
    const c = classifyResponse(429, {}, JSON.stringify({ error: "slow down" }));
    expect(c.kind).toBe("transient");
  });

  it("prefers usage_limit over rate_limit when both appear", () => {
    const c = classifyResponse(
      429,
      {},
      JSON.stringify({
        error: {
          message: "rate_limit and usage_limit_reached",
          type: "usage_limit_reached",
        },
      }),
    );
    expect(c.kind).toBe("quota-exhausted");
  });
});

describe("classifyResponse — entitlement-blocked", () => {
  it("classifies usage_not_included as entitlement-blocked", () => {
    expect(classifyResponse(403, {}, FIXTURES.usageNotIncluded)).toEqual({
      kind: "entitlement-blocked",
    });
  });

  it("classifies 'not included in your plan' copy as entitlement-blocked", () => {
    expect(classifyResponse(404, {}, FIXTURES.usageNotIncludedPlanCopy)).toEqual({
      kind: "entitlement-blocked",
    });
  });

  it("classifies subscription.does.not.include as entitlement-blocked", () => {
    expect(
      classifyResponse(403, {}, FIXTURES.subscriptionDoesNotInclude),
    ).toEqual({ kind: "entitlement-blocked" });
  });

  it("classifies a 429 entitlement body as transient because status precedence wins", () => {
    const c = classifyResponse(429, {}, FIXTURES.usageNotIncluded);
    expect(c.kind).toBe("transient");
    expect(c.kind).not.toBe("quota-exhausted");
  });
});

describe("classifyResponse — deactivated_workspace", () => {
  it("classifies 402 + deactivated_workspace detail as auth-dead", () => {
    expect(
      classifyResponse(402, {}, FIXTURES.deactivatedWorkspace402),
    ).toEqual({ kind: "auth-dead" });
  });

  it("classifies 402 + nested deactivated_workspace as auth-dead", () => {
    expect(
      classifyResponse(402, {}, FIXTURES.deactivatedWorkspaceNested),
    ).toEqual({ kind: "auth-dead" });
  });

  it("does NOT treat deactivated_workspace on non-402 as auth-dead by status alone", () => {
    // Without 402, only code/message match can still hit via AUTH path if
    // code is not AUTH_DEAD_CODE — code is deactivated_workspace, not auth.
    // Spec: 402 + deactivated_workspace → auth-dead. Non-402 falls through.
    const c = classifyResponse(400, {}, FIXTURES.deactivatedWorkspace402);
    expect(c.kind).not.toBe("auth-dead");
    expect(c).toEqual({ kind: "unknown-client-error", status: 400 });
  });
});

describe("classifyResponse — server / overload", () => {
  it("classifies 503 server_is_overloaded as server", () => {
    const c = classifyResponse(503, {}, FIXTURES.serverOverloaded503);
    expect(c.kind).toBe("server");
  });

  it("classifies overload sentinel on non-5xx as server", () => {
    const c = classifyResponse(400, {}, FIXTURES.serverOverloadedNon5xx);
    expect(c.kind).toBe("server");
  });

  it("classifies bare 500 as server", () => {
    const c = classifyResponse(500, {}, FIXTURES.serverError500);
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

describe("classifyResponse — opaque Forbidden / usage headers (rotate)", () => {
  it("classifies bare 403 Forbidden as quota-exhausted", () => {
    const c = classifyResponse(403, {}, "Forbidden");
    expect(c.kind).toBe("quota-exhausted");
  });

  it("classifies empty 403 body as quota-exhausted", () => {
    const c = classifyResponse(403, {}, "");
    expect(c.kind).toBe("quota-exhausted");
  });

  it("classifies JSON message Forbidden without code as quota-exhausted", () => {
    const c = classifyResponse(
      403,
      {},
      JSON.stringify({ error: { message: "Forbidden" } }),
    );
    expect(c.kind).toBe("quota-exhausted");
  });

  it("classifies primary-used-percent 100 headers as quota-exhausted", () => {
    const before = Date.now();
    const c = classifyResponse(
      403,
      {
        "x-codex-primary-used-percent": "100",
        "x-codex-secondary-window-minutes": "0",
        "x-codex-primary-reset-after-seconds": "90",
      },
      JSON.stringify({ error: { message: "something else" } }),
    );
    expect(c.kind).toBe("quota-exhausted");
    if (c.kind === "quota-exhausted") {
      expect(c.resetAtMs).toBeGreaterThanOrEqual(before + 90_000 - 1000);
      expect(c.resetAtMs).toBeLessThanOrEqual(Date.now() + 90_000 + 1000);
    }
  });

  it("does NOT treat entitlement 403 as opaque Forbidden", () => {
    expect(classifyResponse(403, {}, FIXTURES.usageNotIncluded)).toEqual({
      kind: "entitlement-blocked",
    });
  });

  it("does NOT treat auth-dead 403 as opaque Forbidden", () => {
    expect(classifyResponse(403, {}, FIXTURES.tokenRevokedCode)).toEqual({
      kind: "auth-dead",
    });
  });
});

describe("classifyResponse — unknown client errors (no rotate)", () => {
  it("classifies param 400 as unknown-client-error", () => {
    expect(classifyResponse(400, {}, FIXTURES.param400)).toEqual({
      kind: "unknown-client-error",
      status: 400,
    });
  });

  it("classifies model_not_found 404 as unknown-client-error", () => {
    expect(classifyResponse(404, {}, FIXTURES.modelNotFound404)).toEqual({
      kind: "unknown-client-error",
      status: 404,
    });
  });

  it("classifies unparseable 4xx body as unknown-client-error", () => {
    expect(classifyResponse(400, {}, "<html>Bad Request</html>")).toEqual({
      kind: "unknown-client-error",
      status: 400,
    });
  });

  it("classifies empty 4xx body as unknown-client-error", () => {
    expect(classifyResponse(400, {}, "")).toEqual({
      kind: "unknown-client-error",
      status: 400,
    });
  });
});

describe("classifyResponse — body shape handling", () => {
  it("accepts an already-parsed object body", () => {
    const c = classifyResponse(429, {}, {
      error: { type: "rate_limit_exceeded", message: "Rate limit exceeded" },
    });
    expect(c.kind).toBe("transient");
  });

  it("accepts detail.code for deactivated_workspace", () => {
    const c = classifyResponse(402, {}, {
      detail: { code: "deactivated_workspace" },
    });
    expect(c).toEqual({ kind: "auth-dead" });
  });

  it("reads x-codex-primary-reset-after-seconds for quota reset", () => {
    const before = Date.now();
    const c = classifyResponse(
      429,
      { "x-codex-primary-reset-after-seconds": "120" },
      JSON.stringify({
        error: { type: "usage_limit_reached", message: "usage limit" },
      }),
    );
    expect(c.kind).toBe("quota-exhausted");
    if (c.kind === "quota-exhausted") {
      // body has no resets_at → header path
      expect(c.resetAtMs).toBeGreaterThanOrEqual(before + 120_000 - 1000);
      expect(c.resetAtMs).toBeLessThanOrEqual(Date.now() + 120_000 + 1000);
    }
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

  it("parses x-codex-primary-reset-after-seconds", () => {
    expect(
      parseRetryAfterMs({ "x-codex-primary-reset-after-seconds": "45" }),
    ).toBe(45_000);
  });

  it("returns undefined when no header present", () => {
    expect(parseRetryAfterMs({})).toBeUndefined();
  });

  it("returns undefined for a non-numeric, non-date value", () => {
    expect(parseRetryAfterMs({ "retry-after": "soon" })).toBeUndefined();
  });

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

  it("clamps a huge delta to the 24h ceiling", () => {
    const ms = parseRetryAfterMs({ "retry-after-ms": "999999999999" });
    expect(ms).toBe(86_400_000);
  });

  it("parses a unit-suffixed seconds value (7.6s)", () => {
    expect(parseRetryAfterMs({ "retry-after": "7.6s" })).toBe(7600);
  });

  it("parses a compound unit value (2m59s)", () => {
    expect(parseRetryAfterMs({ "retry-after": "2m59s" })).toBe(179_000);
  });
});

describe("exported regex constants", () => {
  it("RATE_LIMIT_RE matches plain rate-limit phrasing", () => {
    expect(RATE_LIMIT_RE.test("rate_limit_exceeded")).toBe(true);
    expect(RATE_LIMIT_RE.test("Too many requests")).toBe(true);
  });

  it("QUOTA_EXHAUSTED_RE matches usage_limit signals", () => {
    expect(QUOTA_EXHAUSTED_RE.test("usage_limit_reached")).toBe(true);
    expect(QUOTA_EXHAUSTED_RE.test("usage limit hit")).toBe(true);
  });

  it("ENTITLEMENT_RE matches usage_not_included / plan copy", () => {
    expect(ENTITLEMENT_RE.test("usage_not_included")).toBe(true);
    expect(ENTITLEMENT_RE.test("not included in your plan")).toBe(true);
    expect(ENTITLEMENT_RE.test("subscription does not include")).toBe(true);
  });

  it("AUTH_DEAD_CODE_RE matches structured token codes only", () => {
    expect(AUTH_DEAD_CODE_RE.test("invalid_grant")).toBe(true);
    expect(AUTH_DEAD_CODE_RE.test("invalid_token")).toBe(true);
    expect(AUTH_DEAD_CODE_RE.test("token_expired")).toBe(true);
    expect(AUTH_DEAD_CODE_RE.test("token_revoked")).toBe(true);
    expect(AUTH_DEAD_CODE_RE.test("unauthorized")).toBe(false);
    expect(AUTH_DEAD_CODE_RE.test("usage_limit_reached")).toBe(false);
  });

  it("AUTH_DEAD_RE matches invalidated-token message", () => {
    expect(
      AUTH_DEAD_RE.test(
        "Your authentication token has been invalidated. Please try signing in again.",
      ),
    ).toBe(true);
    expect(AUTH_DEAD_RE.test("usage_limit_reached")).toBe(false);
    expect(AUTH_DEAD_RE.test("used all available credits")).toBe(false);
  });

  it("DEACTIVATED_WORKSPACE_RE matches code", () => {
    expect(DEACTIVATED_WORKSPACE_RE.test("deactivated_workspace")).toBe(true);
  });

  it("SERVER_OVERLOAD_RE matches overload sentinels (not bare try-again)", () => {
    expect(SERVER_OVERLOAD_RE.test("server_is_overloaded")).toBe(true);
    expect(SERVER_OVERLOAD_RE.test("service_unavailable_error")).toBe(true);
    expect(SERVER_OVERLOAD_RE.test("Our servers are currently overloaded")).toBe(
      true,
    );
    // Bare "try again later" appears in usage_limit copy — must NOT force server.
    expect(SERVER_OVERLOAD_RE.test("Please try again later.")).toBe(false);
  });
});

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
