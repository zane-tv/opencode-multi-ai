import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../lib/core/logger.js";

const SENTINEL_BEARER = "Bearer abc123secret-token-value";
const SENTINEL_KSK = "ksk_live_supersecret_key_xyz";
const SENTINEL_REFRESH = "refresh-token-sentinel-value-xyz";
  const SENTINEL_JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const SENTINEL_CLIENT_SECRET = "client-secret-sentinel-value-xyz";
const SAFE_CTX = "safe-user-id-42";

function captureStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    chunks,
    restore: () => {
      spy.mockRestore();
    },
  };
}

function joined(chunks: string[]): string {
  return chunks.join("");
}

function assertRedacted(output: string): void {
  expect(output).toContain("[REDACTED]");
  expect(output).toContain(SAFE_CTX);
  expect(output).not.toContain(SENTINEL_BEARER);
  expect(output).not.toContain("abc123secret-token-value");
  expect(output).not.toContain(SENTINEL_KSK);
  expect(output).not.toContain(SENTINEL_REFRESH);
  expect(output).not.toContain(SENTINEL_JWT);
  expect(output).not.toContain(SENTINEL_CLIENT_SECRET);
}

describe("logger secret redaction", () => {
  let prevDebug: string | undefined;

  beforeEach(() => {
    prevDebug = process.env.MULTI_AI_DEBUG;
    process.env.MULTI_AI_DEBUG = "1";
  });

  afterEach(() => {
    if (prevDebug === undefined) delete process.env.MULTI_AI_DEBUG;
    else process.env.MULTI_AI_DEBUG = prevDebug;
    vi.restoreAllMocks();
  });

  it("redacts secrets on debug while preserving safe context", () => {
    const cap = captureStderr();
    try {
      logger.debug("auth debug", {
        userId: SAFE_CTX,
        authorization: SENTINEL_BEARER,
        apiKey: SENTINEL_KSK,
      });
      assertRedacted(joined(cap.chunks));
    } finally {
      cap.restore();
    }
  });

  it("redacts secrets on warn while preserving safe context", () => {
    const cap = captureStderr();
    try {
      logger.warn("refresh warn", {
        account: SAFE_CTX,
        refreshToken: SENTINEL_REFRESH,
        note: SENTINEL_BEARER,
      });
      assertRedacted(joined(cap.chunks));
    } finally {
      cap.restore();
    }
  });

  it("redacts secrets on error while preserving safe context", () => {
    const cap = captureStderr();
    try {
      logger.error("oauth error", {
        requestId: SAFE_CTX,
        clientSecret: SENTINEL_CLIENT_SECRET,
        token: SENTINEL_JWT,
      });
      assertRedacted(joined(cap.chunks));
    } finally {
      cap.restore();
    }
  });

  it("redacts nested object context recursively", () => {
    const cap = captureStderr();
    try {
      logger.warn("nested", {
        meta: { user: SAFE_CTX },
        credentials: {
          access_token: SENTINEL_REFRESH,
          nested: {
            client_secret: SENTINEL_CLIENT_SECRET,
            headers: [SENTINEL_BEARER, { api_key: SENTINEL_KSK }],
          },
        },
        jwt: SENTINEL_JWT,
      });
      assertRedacted(joined(cap.chunks));
    } finally {
      cap.restore();
    }
  });

  it("redacts secrets in Error.cause while keeping safe context", () => {
    const cap = captureStderr();
    try {
      const cause = new Error(`upstream ${SENTINEL_BEARER}`);
      (cause as Error & { code?: string }).code = "E_UPSTREAM";
      const err = new Error(`failed for ${SAFE_CTX}`);
      (err as Error & { status?: number }).status = 401;
      err.cause = {
        refreshToken: SENTINEL_REFRESH,
        clientSecret: SENTINEL_CLIENT_SECRET,
        apiKey: SENTINEL_KSK,
        jwt: SENTINEL_JWT,
        detail: cause,
      };
      logger.error("rotation failed", err, { userId: SAFE_CTX });
      assertRedacted(joined(cap.chunks));
    } finally {
      cap.restore();
    }
  });

  it("does not redact ordinary file paths as JWTs", () => {
    const cap = captureStderr();
    try {
      const lockPath =
        "/Users/zens/.config/opencode/multi-ai-accounts.json.lock";
      logger.warn(
        `reclaimed stale lock ${lockPath} (mtime age 42060413ms > 60000ms)`,
      );
      const out = joined(cap.chunks);
      expect(out).toContain("multi-ai-accounts.json.lock");
      expect(out).not.toContain("[REDACTED]");
    } finally {
      cap.restore();
    }
  });
});
