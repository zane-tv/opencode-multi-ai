import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAntigravityFetch } from "../lib/providers/antigravity/request/antigravity-fetch.js";

// Mock directGoogleFetch
vi.mock("../lib/providers/antigravity/request/direct-fetch.js", () => ({
  directGoogleFetch: vi.fn(),
}));

import { directGoogleFetch } from "../lib/providers/antigravity/request/direct-fetch.js";

describe("createAntigravityFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMockStream(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: {"response":{"candidates":[{"content":{"parts":[{"text":"${text}"}]},"finishReason":"STOP"}]}}\n\n`,
          ),
        );
        controller.close();
      },
    });
  }

  it("falls back from Daily (429) to Prod (200) without marking account exhausted", async () => {
    const markQuotaExhausted = vi.fn().mockResolvedValue(undefined);
    const touchLastUsed = vi.fn().mockResolvedValue(undefined);

    const mockManager = {
      list: vi.fn().mockReturnValue([{ accountId: "acc-1" }]),
      selectAccount: vi.fn().mockReturnValue({ accountId: "acc-1" }),
      get: vi.fn().mockReturnValue({ accountId: "acc-1", email: "test@gmail.com" }),
      ensureFreshToken: vi.fn().mockResolvedValue({ accessToken: "fresh-token-1" }),
      touchLastUsed,
      markQuotaExhausted,
      markEntitlementBlocked: vi.fn().mockResolvedValue(undefined),
      markDeadCandidate: vi.fn().mockResolvedValue(undefined),
    };

    // First call (Daily): returns 429
    // Second call (Prod): returns 200 with body
    const mockedFetch = vi.mocked(directGoogleFetch);
    mockedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 429, message: "Resource exhausted" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(createMockStream("Hello from prod!"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

    const fetchFn = createAntigravityFetch({ manager: mockManager as any } as any);

    const res = await fetchFn("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.7-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    // Verified: Daily was called first, then Prod
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch.mock.calls[0][0]).toContain("daily-cloudcode-pa.googleapis.com");
    expect(mockedFetch.mock.calls[1][0]).toContain("cloudcode-pa.googleapis.com");

    // Quota should NOT be exhausted because Prod succeeded
    expect(markQuotaExhausted).not.toHaveBeenCalled();
    expect(touchLastUsed).toHaveBeenCalledWith("antigravity", "acc-1");
  });

  it("marks quota exhausted and rotates when both Daily and Prod return 429", async () => {
    const markQuotaExhausted = vi.fn().mockResolvedValue(undefined);
    let attemptCount = 0;

    const mockManager = {
      list: vi.fn().mockReturnValue([{ accountId: "acc-1" }, { accountId: "acc-2" }]),
      selectAccount: vi.fn().mockImplementation(() => {
        attemptCount++;
        if (attemptCount === 1) return { accountId: "acc-1" };
        if (attemptCount === 2) return { accountId: "acc-2" };
        return null;
      }),
      get: vi.fn().mockImplementation((_prov, id) => ({ accountId: id, email: `${id}@gmail.com` })),
      ensureFreshToken: vi.fn().mockResolvedValue({ accessToken: "fresh-token" }),
      touchLastUsed: vi.fn().mockResolvedValue(undefined),
      markQuotaExhausted,
      markEntitlementBlocked: vi.fn().mockResolvedValue(undefined),
      markDeadCandidate: vi.fn().mockResolvedValue(undefined),
    };

    const mockedFetch = vi.mocked(directGoogleFetch);
    // acc-1: Daily 429 -> Prod 429
    // acc-2: Daily 200
    mockedFetch
      .mockResolvedValueOnce(new Response("429 error", { status: 429 }))
      .mockResolvedValueOnce(new Response("429 error", { status: 429 }))
      .mockResolvedValueOnce(new Response(createMockStream("Acc 2 success"), { status: 200 }));

    const fetchFn = createAntigravityFetch({ manager: mockManager as any } as any);

    const res = await fetchFn("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.7-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    // acc-1 should be marked exhausted
    expect(markQuotaExhausted).toHaveBeenCalledWith("antigravity", "acc-1", expect.any(Number));
  });

  it("blocks entitlement and rotates immediately on 403 VALIDATION_REQUIRED", async () => {
    const markEntitlementBlocked = vi.fn().mockResolvedValue(undefined);
    let attemptCount = 0;

    const mockManager = {
      list: vi.fn().mockReturnValue([{ accountId: "acc-1" }, { accountId: "acc-2" }]),
      selectAccount: vi.fn().mockImplementation(() => {
        attemptCount++;
        if (attemptCount === 1) return { accountId: "acc-1" };
        if (attemptCount === 2) return { accountId: "acc-2" };
        return null;
      }),
      get: vi.fn().mockImplementation((_prov, id) => ({ accountId: id, email: `${id}@gmail.com` })),
      ensureFreshToken: vi.fn().mockResolvedValue({ accessToken: "fresh-token" }),
      touchLastUsed: vi.fn().mockResolvedValue(undefined),
      markQuotaExhausted: vi.fn().mockResolvedValue(undefined),
      markEntitlementBlocked,
      markDeadCandidate: vi.fn().mockResolvedValue(undefined),
    };

    const mockedFetch = vi.mocked(directGoogleFetch);
    mockedFetch
      .mockResolvedValueOnce(new Response("VALIDATION_REQUIRED", { status: 403 }))
      .mockResolvedValueOnce(new Response(createMockStream("Success on acc 2"), { status: 200 }));

    const fetchFn = createAntigravityFetch({ manager: mockManager as any } as any);

    const res = await fetchFn("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.7-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(markEntitlementBlocked).toHaveBeenCalledWith("antigravity", "acc-1");
  });
});
