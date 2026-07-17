import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApiKeyCandidate } from "../lib/providers/kiro/auth/api-key.js";
import {
  normalizeCredentialCandidate,
  normalizeCredentialCandidates,
} from "../lib/providers/kiro/auth/credentials-import.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Kiro credentials import", () => {
  it("builds api-key candidates and rejects invalid keys", () => {
    const candidate = buildApiKeyCandidate("ksk_live_abc", "eu-central-1");
    expect(candidate.authMethod).toBe("api-key");
    expect(candidate.region).toBe("eu-central-1");
    expect(candidate.refreshToken).toBe("ksk_live_abc");
    expect(() => buildApiKeyCandidate("not-a-key")).toThrow(/ksk_/);
  });

  it("normalizes desktop/idc credentials and validates non-api refresh when requested", async () => {
    const desktop = await normalizeCredentialCandidate(
      {
        authMethod: "desktop",
        refreshToken: "rt-desktop",
        email: "a@example.com",
      },
      { validateRefresh: false },
    );
    expect(desktop.authMethod).toBe("desktop");
    expect(desktop.email).toBe("a@example.com");

    await expect(
      normalizeCredentialCandidate({
        authMethod: "idc",
        refreshToken: "rt",
      }),
    ).rejects.toThrow(/clientId and clientSecret/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ accessToken: "at", refreshToken: "rt2", expiresIn: 60 }),
          { status: 200 },
        ),
      ),
    );
    const refreshed = await normalizeCredentialCandidate({
      authMethod: "desktop",
      refreshToken: "rt-old",
    });
    expect(refreshed.accessToken).toBe("at");
    expect(refreshed.refreshToken).toBe("rt2");
  });

  it("imports arrays of accounts without secrets in thrown errors", async () => {
    const list = await normalizeCredentialCandidates({
      accounts: [
        { authMethod: "api-key", refreshToken: "ksk_one" },
        { authMethod: "api-key", refreshToken: "ksk_two" },
      ],
    });
    expect(list).toHaveLength(2);
    await expect(
      normalizeCredentialCandidate({ authMethod: "social", refreshToken: "x" }),
    ).rejects.toThrow(/social login/i);
  });
});
