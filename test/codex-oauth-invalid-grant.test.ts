import { afterEach, describe, expect, it, vi } from "vitest";

import { InvalidGrantError, refreshTokens } from "../lib/providers/codex/auth/oauth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubRefreshResponse(body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(body, {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

async function captureRefreshError(body: string): Promise<unknown> {
  stubRefreshResponse(body);
  try {
    await refreshTokens("refresh-token");
  } catch (error) {
    return error;
  }
  throw new Error("expected token refresh to reject");
}

function stubRefreshStatus(status: number, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("refreshTokens — invalid_grant detection", () => {
  it("throws InvalidGrantError for an exact OAuth invalid_grant code", async () => {
    const error = await captureRefreshError(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "Refresh token is invalid or revoked",
      }),
    );

    expect(error).toBeInstanceOf(InvalidGrantError);
  });

  it("throws InvalidGrantError for nested OpenAI refresh_token_invalidated (HTTP 401)", async () => {
    stubRefreshStatus(
      401,
      JSON.stringify({
        error: {
          message: "Your session has ended. Please log in again.",
          type: "invalid_request_error",
          param: null,
          code: "refresh_token_invalidated",
        },
      }),
    );
    let error: unknown;
    try {
      await refreshTokens("refresh-token");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidGrantError);
  });

  it("does not throw InvalidGrantError when invalid_grant appears only in description copy", async () => {
    const error = await captureRefreshError(
      JSON.stringify({
        error: "invalid_request",
        error_description: "This is not an invalid_grant response.",
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InvalidGrantError);
  });

  it("does not throw InvalidGrantError for non-JSON prose containing invalid_grant", async () => {
    const error = await captureRefreshError(
      "The gateway says invalid_grant, but this is not an OAuth JSON envelope.",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InvalidGrantError);
  });
});
