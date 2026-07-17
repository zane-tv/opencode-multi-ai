import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizeKiroIDC,
  pollKiroIDCToken,
} from "../lib/providers/kiro/auth/oauth-idc.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Kiro IDC device authorization", () => {
  it("registers a client and returns device authorization details", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ clientId: "cid", clientSecret: "csec" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            verificationUri: "https://example.com/verify",
            verificationUriComplete: "https://example.com/verify?code=1",
            userCode: "ABCD",
            deviceCode: "device",
            interval: 1,
            expiresIn: 10,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await authorizeKiroIDC("eu-central-1");
    expect(auth.clientId).toBe("cid");
    expect(auth.region).toBe("eu-central-1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "oidc.eu-central-1.amazonaws.com/client/register",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "device_authorization",
    );
  });

  it("polls until tokens arrive and supports cancellation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: "at",
            refreshToken: "rt",
            expiresIn: 100,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await pollKiroIDCToken("cid", "csec", "device", 0.01, 1, "us-east-1");
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.authMethod).toBe("idc");

    const controller = new AbortController();
    controller.abort();
    await expect(
      pollKiroIDCToken("cid", "csec", "device", 1, 10, "us-east-1", {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });
});
