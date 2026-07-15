import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type {
  Classification,
  ProviderAdapter,
  ProviderKind,
} from "../lib/core/adapter.js";
import {
  AUTH_COOLDOWN_MS,
  createRotationFetch,
  InvalidGrantError,
  QUOTA_FALLBACK_MS,
  type RotationAccount,
  type RotationManager,
} from "../lib/core/rotation-fetch.js";

const ENDPOINT = "https://api.example.com/v1/chat";

function makeAdapter(
  overrides: Partial<ProviderAdapter> = {},
): ProviderAdapter {
  return {
    id: "xai-multi",
    provider: "xai",
    displayName: "Grok Multi-Account",
    npmPackage: "@ai-sdk/xai",
    baseURL: "https://api.example.com/v1",
    dummyApiKey: "dummy",
    resolveUrl(input: string | URL): string {
      const u = typeof input === "string" ? new URL(input) : input;
      if (u.host !== "api.example.com") {
        throw new Error(`host-pin refuse: ${u.host}`);
      }
      return u.toString();
    },
    buildHeaders(ctx) {
      const h = new Headers(ctx.initHeaders);
      h.set("Authorization", `Bearer ${ctx.accessToken}`);
      h.set("x-account-id", ctx.accountId);
      return h;
    },
    transformBody(init) {
      return init;
    },
    async classifyResponse(res, bodyText): Promise<Classification> {
      if (res.status >= 200 && res.status < 300) return { kind: "ok" };
      if (res.status === 429) {
        if (bodyText.includes("quota")) {
          return { kind: "quota-exhausted", resetAtMs: Date.now() + 60_000 };
        }
        return { kind: "transient", retryAfterMs: 100 };
      }
      if (res.status === 403 && bodyText.includes("entitlement")) {
        return { kind: "entitlement-blocked" };
      }
      if (res.status === 401) return { kind: "auth-dead" };
      if (res.status >= 500) return { kind: "server" };
      if (res.status >= 400) {
        return { kind: "unknown-client-error", status: res.status };
      }
      return { kind: "ok" };
    },
    classifyThrownError(): Classification {
      return { kind: "network" };
    },
    async recordSuccess() {
      /* no-op */
    },
    async resolveModels() {
      return {};
    },
    providerDefaultOptions() {
      return {};
    },
    listSubtitle() {
      return "";
    },
    detailLines() {
      return [];
    },
    ...overrides,
  };
}

function makeManager(
  accounts: RotationAccount[],
  opts?: {
    tokens?: Record<string, string>;
    failRefresh?: Set<string>;
    invalidGrant?: Set<string>;
  },
): RotationManager & {
  marks: {
    quota: string[];
    entitlement: string[];
    cooldown: string[];
    dead: string[];
    touched: string[];
  };
} {
  const marks = {
    quota: [] as string[],
    entitlement: [] as string[],
    cooldown: [] as string[],
    dead: [] as string[],
    touched: [] as string[],
  };
  const tokens = opts?.tokens ?? {};
  for (const a of accounts) {
    if (!tokens[a.accountId]) tokens[a.accountId] = `tok-${a.accountId}`;
  }
  const byId = new Map(accounts.map((a) => [a.accountId, a]));

  return {
    marks,
    selectAccount(_provider: ProviderKind, attempted: Set<string>) {
      for (const a of accounts) {
        if (!attempted.has(a.accountId) && !marks.dead.includes(a.accountId)) {
          return a;
        }
      }
      return null;
    },
    async ensureFreshToken(
      _provider: ProviderKind,
      id: string,
      _force?: boolean,
    ) {
      if (opts?.invalidGrant?.has(id)) {
        throw new InvalidGrantError();
      }
      if (opts?.failRefresh?.has(id)) {
        throw new Error("network");
      }
      return { accessToken: tokens[id] ?? `tok-${id}` };
    },
    async markQuotaExhausted(_p, id, resetAt) {
      marks.quota.push(id);
      const a = byId.get(id);
      if (a) a.quotaResetAt = resetAt;
    },
    async markEntitlementBlocked(_p, id) {
      marks.entitlement.push(id);
    },
    async recordCooldown(_p, id) {
      marks.cooldown.push(id);
    },
    async markDeadCandidate(_p, id) {
      marks.dead.push(id);
    },
    async touchLastUsed(_p, id) {
      marks.touched.push(id);
    },
    list() {
      return accounts;
    },
    get(_p, id) {
      return byId.get(id);
    },
  };
}

type FetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function bearerOf(init: Parameters<typeof fetch>[1]): string | undefined {
  const h = new Headers(init?.headers);
  return h.get("authorization") ?? undefined;
}

let fetchSpy: MockInstance<FetchFn>;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  fetchSpy = vi.fn() as MockInstance<FetchFn>;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("createRotationFetch", () => {
  it("resolveUrl host-pin refuses before Authorization is sent", async () => {
    const adapter = makeAdapter();
    const manager = makeManager([{ accountId: "a0" }]);
    const custom = createRotationFetch(adapter, manager);

    await expect(
      custom("https://evil.example/v1/chat", { method: "POST" }),
    ).rejects.toThrow(/host-pin/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("attaches bearer from selected account on success", async () => {
    const adapter = makeAdapter();
    const manager = makeManager([{ accountId: "a0" }]);
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const custom = createRotationFetch(adapter, manager);
    const res = await custom(ENDPOINT, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bearerOf(fetchSpy.mock.calls[0]![1])).toBe("Bearer tok-a0");
    expect(manager.marks.touched).toEqual(["a0"]);
  });

  it("rotates on quota-exhausted and marks the account", async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const manager = makeManager([
      { accountId: "a0" },
      { accountId: "a1" },
    ]);
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "quota" }), { status: 429 }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const custom = createRotationFetch(adapter, manager);
    const p = custom(ENDPOINT, { method: "POST" });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(manager.marks.quota).toEqual(["a0"]);
    expect(bearerOf(fetchSpy.mock.calls[1]![1])).toBe("Bearer tok-a1");
  });

  it("returns unknown-client-error without rotating", async () => {
    const adapter = makeAdapter();
    const manager = makeManager([
      { accountId: "a0" },
      { accountId: "a1" },
    ]);
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "bad_param" }), { status: 400 }),
    );

    const custom = createRotationFetch(adapter, manager);
    const res = await custom(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(manager.marks.touched).toEqual([]);
  });

  it("auth-recover: force refresh then succeed", async () => {
    const adapter = makeAdapter();
    const tokens: Record<string, string> = { a0: "tok-old" };
    const manager = makeManager([{ accountId: "a0" }], { tokens });
    let forceCalls = 0;
    const orig = manager.ensureFreshToken.bind(manager);
    manager.ensureFreshToken = async (p, id, force) => {
      if (force) {
        forceCalls++;
        tokens.a0 = "tok-new";
      }
      return orig(p, id, force);
    };

    fetchSpy
      .mockResolvedValueOnce(new Response("auth", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const custom = createRotationFetch(adapter, manager);
    const res = await custom(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(200);
    expect(forceCalls).toBe(1);
    expect(bearerOf(fetchSpy.mock.calls[1]![1])).toBe("Bearer tok-new");
    expect(manager.marks.cooldown).toEqual([]);
  });

  it("auth-dead after recover → cooldown + rotate", async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const manager = makeManager([
      { accountId: "a0" },
      { accountId: "a1" },
    ]);
    fetchSpy
      .mockResolvedValueOnce(new Response("auth", { status: 401 }))
      .mockResolvedValueOnce(new Response("auth", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const custom = createRotationFetch(adapter, manager);
    const p = custom(ENDPOINT, { method: "POST" });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(manager.marks.cooldown).toEqual(["a0"]);
    expect(manager.marks.dead).toEqual([]);
    expect(AUTH_COOLDOWN_MS).toBe(30_000);
  });

  it("invalid_grant on ensureFreshToken marks dead and rotates", async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const manager = makeManager(
      [{ accountId: "a0" }, { accountId: "a1" }],
      { invalidGrant: new Set(["a0"]) },
    );
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const custom = createRotationFetch(adapter, manager);
    const p = custom(ENDPOINT, { method: "POST" });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(manager.marks.dead).toEqual(["a0"]);
    expect(bearerOf(fetchSpy.mock.calls[0]![1])).toBe("Bearer tok-a1");
  });

  it("exhausted pool returns 503 with retry-after", async () => {
    const resetAt = Date.now() + 120_000;
    const adapter = makeAdapter();
    const manager = makeManager([
      { accountId: "a0", quotaResetAt: resetAt },
    ]);
    // selectAccount still returns a0 once; quota mark then pool has no more.
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "quota" }), { status: 429 }),
    );

    const custom = createRotationFetch(adapter, manager);
    const res = await custom(ENDPOINT, { method: "POST" });
    // After one rotate attempt, no more accounts → 503
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: string;
      retryAfterSeconds?: number;
    };
    expect(body.error).toMatch(/exhausted/i);
    expect(typeof body.retryAfterSeconds).toBe("number");
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(QUOTA_FALLBACK_MS).toBe(15 * 60_000);
  });

  it("entitlement-blocked marks and rotates", async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const manager = makeManager([
      { accountId: "a0" },
      { accountId: "a1" },
    ]);
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "entitlement" }), {
          status: 403,
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const custom = createRotationFetch(adapter, manager);
    const p = custom(ENDPOINT, { method: "POST" });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(manager.marks.entitlement).toEqual(["a0"]);
  });

  it("transient → one backoff+retry on the SAME account, then success", async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const manager = makeManager([
      { accountId: "a0" },
      { accountId: "a1" },
    ]);
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "rate limit" }), { status: 429 }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const custom = createRotationFetch(adapter, manager);
    const p = custom(ENDPOINT, { method: "POST" });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bearerOf(fetchSpy.mock.calls[0]![1])).toBe("Bearer tok-a0");
    expect(bearerOf(fetchSpy.mock.calls[1]![1])).toBe("Bearer tok-a0");
    expect(manager.marks.quota).toEqual([]);
    expect(manager.marks.cooldown).toEqual([]);
  });

  it("overwrites the SDK dummy apiKey with a real per-account bearer", async () => {
    const adapter = makeAdapter();
    const manager = makeManager([{ accountId: "a0" }]);
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const custom = createRotationFetch(adapter, manager);
    await custom(ENDPOINT, {
      method: "POST",
      headers: { authorization: "Bearer multi-ai-dummy-key" },
    });

    expect(bearerOf(fetchSpy.mock.calls[0]![1])).toBe("Bearer tok-a0");
  });

  it("S-2: auth-dead retry hitting quota-exhausted MARKS the account", async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const tokens: Record<string, string> = { a0: "tok-old", a1: "tok-a1" };
    const manager = makeManager(
      [{ accountId: "a0" }, { accountId: "a1" }],
      { tokens },
    );
    const orig = manager.ensureFreshToken.bind(manager);
    manager.ensureFreshToken = async (p, id, force) => {
      if (force && id === "a0") tokens.a0 = "tok-a0-rotated";
      return orig(p, id, force);
    };

    fetchSpy
      .mockResolvedValueOnce(new Response("auth", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "quota" }), { status: 429 }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const custom = createRotationFetch(adapter, manager);
    const p = custom(ENDPOINT, { method: "POST" });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(manager.marks.quota).toEqual(["a0"]);
    expect(manager.marks.dead).toEqual([]);
    expect(bearerOf(fetchSpy.mock.calls[2]![1])).toBe("Bearer tok-a1");
  });

  it("all-exhausted across two accounts attempts each once", async () => {
    const adapter = makeAdapter();
    const manager = makeManager([
      { accountId: "a0" },
      { accountId: "a1" },
    ]);
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "quota" }), {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "quota" }), {
          status: 429,
          headers: { "retry-after": "60" },
        }),
      );

    const custom = createRotationFetch(adapter, manager);
    const res = await custom(ENDPOINT, { method: "POST" });
    expect(res.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(manager.marks.quota.sort()).toEqual(["a0", "a1"]);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});
