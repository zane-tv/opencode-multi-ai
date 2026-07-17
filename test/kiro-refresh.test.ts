import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KiroInvalidGrantError,
  refreshKiroAccount,
} from "../lib/providers/kiro/auth/refresh.js";
import type { AccountOf } from "../lib/core/schemas.js";

function kiroAccount(
  overrides: Partial<AccountOf<"kiro">> &
    Pick<AccountOf<"kiro">, "authMethod" | "refreshToken">,
): AccountOf<"kiro"> {
  return {
    provider: "kiro",
    accountId: "a1",
    tags: [],
    enabled: true,
    priority: 0,
    addedAt: 1,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "unknown",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    region: "us-east-1",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("refreshKiroAccount", () => {
  it("returns the api-key without network I/O", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tokens = await refreshKiroAccount(
      kiroAccount({ authMethod: "api-key", refreshToken: "ksk_live_abc" }),
    );
    expect(tokens.accessToken).toBe("ksk_live_abc");
    expect(tokens.refreshToken).toBe("ksk_live_abc");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes desktop tokens via the desktop auth endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
        );
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ refreshToken: "rt-old" });
        return new Response(
          JSON.stringify({
            accessToken: "at-new",
            refreshToken: "rt-new",
            expiresIn: 3600,
          }),
          { status: 200 },
        );
      }),
    );
    const tokens = await refreshKiroAccount(
      kiroAccount({ authMethod: "desktop", refreshToken: "rt-old" }),
    );
    expect(tokens.accessToken).toBe("at-new");
    expect(tokens.refreshToken).toBe("rt-new");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshes IDC tokens with client credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://oidc.eu-central-1.amazonaws.com/token");
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          refreshToken: "rt-idc",
          clientId: "cid",
          clientSecret: "csec",
          grantType: "refresh_token",
        });
        return new Response(
          JSON.stringify({ accessToken: "at-idc", expiresIn: 1200 }),
          { status: 200 },
        );
      }),
    );
    const tokens = await refreshKiroAccount(
      kiroAccount({
        authMethod: "idc",
        refreshToken: "rt-idc",
        clientId: "cid",
        clientSecret: "csec",
        oidcRegion: "eu-central-1",
        region: "us-east-1",
      }),
    );
    expect(tokens.accessToken).toBe("at-idc");
    expect(tokens.refreshToken).toBe("rt-idc");
  });

  it("maps invalid_grant responses to KiroInvalidGrantError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid_grant", message: "dead" }), {
          status: 400,
        }),
      ),
    );
    await expect(
      refreshKiroAccount(
        kiroAccount({ authMethod: "desktop", refreshToken: "rt-dead" }),
      ),
    ).rejects.toBeInstanceOf(KiroInvalidGrantError);
  });
});
