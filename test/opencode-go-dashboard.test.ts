/**
 * OpenCode Go dashboard quota parser + env credential resolution.
 *
 * Parser is a port of the reference implementation
 * (`github.com/opgginc/opencode-bar` `OpenCodeGoProvider.swift`): the
 * dashboard HTML inlines `rollingUsage` / `weeklyUsage` / `monthlyUsage`
 * objects (possibly SolidJS `$R[N] = {…}` hydration refs) with entity- and
 * escape-encoded field names; the parser normalizes then regex-extracts
 * `usagePercent` / `resetInSec`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchDashboardUsage,
  normalizeAuthCookie,
  normalizeDashboardHTML,
  parseDashboardUsageHTML,
  resolveDashboardCred,
  resolveDashboardCredForAccount,
  type OpenCodeGoDashboardCred,
} from "../lib/providers/opencode-go/dashboard.js";
import { openCodeGoAdapter } from "../lib/providers/opencode-go/adapter.js";

const NOW = 1_800_000_000_000;

/** Mirrors the opencode-bar Swift fixture: next.js push with `\"` escapes. */
const ESCAPED_FIXTURE = String.raw`<script>
self.__next_f.push([1,"{\"rollingUsage\":{\"usagePercent\":12.5,\"resetInSec\":3600},\"weeklyUsage\":{\"usagePercent\":\"25\",\"resetInSec\":\"7200\"},\"monthlyUsage\":{\"usagePercent\":50,\"resetInSec\":10800}}"])
</script>`;

/** Mirrors the opencode-bar SolidJS hydration fixture. */
const SOLID_FIXTURE = `<script>
$R[24]($R[18],$R[30]={mine:!0,useBalance:!0,rollingUsage:$R[0] = {status:"ok",resetInSec:18000,usagePercent:0},weeklyUsage:$R[1]={status:"ok",resetInSec:162822,usagePercent:31},monthlyUsage:$R[2] = {status:"ok",resetInSec:1404782,usagePercent:21}});
</script>`;

/** Field names quoted with single quotes, double quotes, and unquoted. */
const QUOTED_NAMES_FIXTURE = `<script>
window.__DATA = {
  'rollingUsage': { 'usagePercent': 8, 'resetInSec': 3600 },
  "weeklyUsage": { "usagePercent": 9, "resetInSec": 7200 },
  monthlyUsage: { usagePercent: 10, resetInSec: 10800 }
};
</script>`;

/** HTML-entity encoded field names/values (`&quot;` `&#34;` `&#x27;` `&#39;`). */
const ENTITY_FIXTURE = `<script>
window.__DATA = {
  &#34;rollingUsage&#34;: { &#34;usagePercent&#34;: 40, &#34;resetInSec&#34;: 900 },
  &#x27;weeklyUsage&#x27;: { &#x27;usagePercent&#x27;: 55, &#x27;resetInSec&#x27;: 43200 },
  &quot;monthlyUsage&quot;: { &quot;usagePercent&quot;: 20, &quot;resetInSec&quot;: 2592000 },
  title: &quot;Go &amp; API dashboard&quot;
};
</script>`;

describe("parseDashboardUsageHTML", () => {
  it("parses all three windows from the escaped next.js fixture", () => {
    const usage = parseDashboardUsageHTML(ESCAPED_FIXTURE, NOW);

    expect(usage.rolling?.usagePercent).toBeCloseTo(12.5, 3);
    expect(usage.rolling?.resetInSeconds).toBe(3_600);
    expect(usage.rolling?.resetAt).toBe(NOW + 3_600_000);
    expect(usage.weekly?.usagePercent).toBe(25);
    expect(usage.weekly?.resetInSeconds).toBe(7_200);
    expect(usage.weekly?.resetAt).toBe(NOW + 7_200_000);
    expect(usage.monthly?.usagePercent).toBe(50);
    expect(usage.monthly?.resetInSeconds).toBe(10_800);
    expect(usage.monthly?.resetAt).toBe(NOW + 10_800_000);
  });

  it("handles SolidJS $R[N] = {…} hydration prefixes", () => {
    const usage = parseDashboardUsageHTML(SOLID_FIXTURE, NOW);

    expect(usage.rolling?.usagePercent).toBe(0);
    expect(usage.rolling?.resetInSeconds).toBe(18_000);
    expect(usage.weekly?.usagePercent).toBe(31);
    expect(usage.weekly?.resetInSeconds).toBe(162_822);
    expect(usage.monthly?.usagePercent).toBe(21);
    expect(usage.monthly?.resetInSeconds).toBe(1_404_782);
  });

  it("parses single-quoted, double-quoted and unquoted field names", () => {
    const usage = parseDashboardUsageHTML(QUOTED_NAMES_FIXTURE, NOW);

    expect(usage.rolling?.usagePercent).toBe(8);
    expect(usage.rolling?.resetInSeconds).toBe(3_600);
    expect(usage.weekly?.usagePercent).toBe(9);
    expect(usage.weekly?.resetInSeconds).toBe(7_200);
    expect(usage.monthly?.usagePercent).toBe(10);
    expect(usage.monthly?.resetInSeconds).toBe(10_800);
  });

  it("decodes HTML entities before parsing", () => {
    const usage = parseDashboardUsageHTML(ENTITY_FIXTURE, NOW);

    expect(usage.rolling?.usagePercent).toBe(40);
    expect(usage.rolling?.resetInSeconds).toBe(900);
    expect(usage.weekly?.usagePercent).toBe(55);
    expect(usage.weekly?.resetInSeconds).toBe(43_200);
    expect(usage.monthly?.usagePercent).toBe(20);
    expect(usage.monthly?.resetInSeconds).toBe(2_592_000);

    // `&amp;` is decoded (after the named entities, same order as the
    // Swift reference).
    expect(normalizeDashboardHTML(ENTITY_FIXTURE)).toContain(
      '"Go & API dashboard"',
    );
  });

  it("keeps partial windows: missing monthly yields {rolling, weekly}", () => {
    const usage = parseDashboardUsageHTML(
      `<script>self.__next_f.push([1,"{\\"rollingUsage\\":{\\"usagePercent\\":64,\\"resetInSec\\":900},\\"weeklyUsage\\":{\\"usagePercent\\":12,\\"resetInSec\\":43200}}"])</script>`,
      NOW,
    );

    expect(usage.rolling?.usagePercent).toBe(64);
    expect(usage.weekly?.usagePercent).toBe(12);
    expect(usage.monthly).toBeUndefined();
    expect(Object.keys(usage).sort()).toEqual(["rolling", "weekly"]);
  });

  it("returns {} when no window parses (markup changed / empty page)", () => {
    expect(parseDashboardUsageHTML("<html><body>no data</body></html>", NOW)).toEqual(
      {},
    );
  });

  it("floors negative resetInSec at 0", () => {
    const usage = parseDashboardUsageHTML(
      `<script>var x = {rollingUsage: {usagePercent: 5, resetInSec: -30}};</script>`,
      NOW,
    );
    expect(usage.rolling?.resetInSeconds).toBe(0);
    expect(usage.rolling?.resetAt).toBe(NOW);
  });
});

describe("resolveDashboardCred", () => {
  const envKeys = [
    "MULTI_AI_OPENCODE_GO_WORKSPACE_ID",
    "MULTI_AI_OPENCODE_GO_AUTH_COOKIE",
    "OPENCODE_GO_WORKSPACE_ID",
    "OPENCODE_GO_AUTH_COOKIE",
  ] as const;

  afterEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  describe("normalizeAuthCookie", () => {
    it("strips a leading `auth=` prefix (case-insensitive)", () => {
      expect(normalizeAuthCookie("auth=cookie-a")).toBe("cookie-a");
      expect(normalizeAuthCookie("AUTH=cookie-A")).toBe("cookie-A");
      expect(normalizeAuthCookie("Auth=cookie-mixed")).toBe("cookie-mixed");
    });
    it("passes through a raw value untouched", () => {
      expect(normalizeAuthCookie("cookie-a")).toBe("cookie-a");
      expect(normalizeAuthCookie("a-b-c-123")).toBe("a-b-c-123");
    });
    it("trims surrounding whitespace", () => {
      expect(normalizeAuthCookie("  cookie-a  ")).toBe("cookie-a");
      expect(normalizeAuthCookie("  auth=cookie-a  ")).toBe("cookie-a");
    });
    it("only strips a leading prefix (mid-string `auth=` stays)", () => {
      expect(normalizeAuthCookie("cookie-auth=yes")).toBe("cookie-auth=yes");
    });
    it("returns empty string for blank input", () => {
      expect(normalizeAuthCookie("")).toBe("");
      expect(normalizeAuthCookie("   ")).toBe("");
    });
  });

  it("prefers MULTI_AI_* env vars", () => {
    process.env.MULTI_AI_OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.MULTI_AI_OPENCODE_GO_AUTH_COOKIE = "cookie-1";
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_legacy";
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-legacy";

    expect(resolveDashboardCred()).toEqual({
      workspaceId: "wrk_abc",
      authCookie: "cookie-1",
    });
  });

  it("falls back to legacy OPENCODE_GO_* env vars", () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_legacy";
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-legacy";

    expect(resolveDashboardCred()).toEqual({
      workspaceId: "wrk_legacy",
      authCookie: "cookie-legacy",
    });
  });

  it("trims values and returns null when either is empty", () => {
    process.env.MULTI_AI_OPENCODE_GO_WORKSPACE_ID = "  wrk_abc  ";
    expect(resolveDashboardCred()).toBeNull();

    process.env.MULTI_AI_OPENCODE_GO_AUTH_COOKIE = "  cookie  ";
    expect(resolveDashboardCred()).toEqual({
      workspaceId: "wrk_abc",
      authCookie: "cookie",
    });
  });

  it("returns null when neither pair is set", () => {
    expect(resolveDashboardCred()).toBeNull();
  });
});

describe("resolveDashboardCredForAccount", () => {
  const envKeys = [
    "MULTI_AI_OPENCODE_GO_WORKSPACE_ID",
    "MULTI_AI_OPENCODE_GO_AUTH_COOKIE",
    "OPENCODE_GO_WORKSPACE_ID",
    "OPENCODE_GO_AUTH_COOKIE",
  ] as const;

  afterEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  it("prefers the account's cred over env when both account fields are set", () => {
    process.env.MULTI_AI_OPENCODE_GO_WORKSPACE_ID = "wrk_env";
    process.env.MULTI_AI_OPENCODE_GO_AUTH_COOKIE = "cookie-env";

    expect(
      resolveDashboardCredForAccount({
        openCodeGoWorkspaceId: "wrk_account",
        openCodeGoAuthCookie: "auth=cookie-account",
      }),
    ).toEqual({
      workspaceId: "wrk_account",
      authCookie: "auth=cookie-account",
    });
  });

  it("falls back to env when the account carries no cred", () => {
    process.env.MULTI_AI_OPENCODE_GO_WORKSPACE_ID = "wrk_env";
    process.env.MULTI_AI_OPENCODE_GO_AUTH_COOKIE = "cookie-env";

    expect(
      resolveDashboardCredForAccount({ openCodeGoWorkspaceId: undefined }),
    ).toEqual({ workspaceId: "wrk_env", authCookie: "cookie-env" });
  });

  it("falls back to env when only one account field is set (partial cred)", () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_legacy";
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-legacy";

    expect(
      resolveDashboardCredForAccount({ openCodeGoAuthCookie: "cookie-only" }),
    ).toEqual({ workspaceId: "wrk_legacy", authCookie: "cookie-legacy" });
  });

  it("trims account fields and returns null when neither source has a pair", () => {
    expect(
      resolveDashboardCredForAccount({
        openCodeGoWorkspaceId: "  wrk_abc  ",
        openCodeGoAuthCookie: "  ",
      }),
    ).toBeNull();
    expect(resolveDashboardCredForAccount({})).toBeNull();
  });
});

describe("fetchDashboardUsage", () => {
  const cred: OpenCodeGoDashboardCred = {
    workspaceId: "wrk_abc",
    authCookie: "cookie-1",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the dashboard with auth cookie + browser UA and parses the body", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => ({
        ok: true,
        status: 200,
        text: async () => ESCAPED_FIXTURE,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchDashboardUsage(cred, NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(url).toBe("https://opencode.ai/workspace/wrk_abc/go");
    expect(headers.Cookie).toBe("auth=cookie-1");
    expect(headers.Accept).toBe("text/html,application/xhtml+xml");
    expect(headers["User-Agent"]).toMatch(/Chrome\/126\.0/);

    expect(usage.rolling?.usagePercent).toBeCloseTo(12.5, 3);
    expect(usage.monthly?.usagePercent).toBe(50);
  });

  it("passes a raw cookie through unchanged when it already contains auth=", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => ({
        ok: true,
        status: 200,
        text: async () => ESCAPED_FIXTURE,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDashboardUsage(
      { workspaceId: "wrk_abc", authCookie: "auth=cookie-full; other=1" },
      NOW,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(url).toBe("https://opencode.ai/workspace/wrk_abc/go");
    expect(headers.Cookie).toBe("auth=cookie-full; other=1");
  });

  it("throws with the HTTP status on non-2xx (caller catches)", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => ({
        ok: false,
        status: 403,
        text: async () => "",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDashboardUsage(cred, NOW)).rejects.toThrow(/HTTP 403/);
  });
});

describe("openCodeGoAdapter.probeQuota (dashboard wiring)", () => {
  const GO_ENV = [
    "MULTI_AI_OPENCODE_GO_WORKSPACE_ID",
    "MULTI_AI_OPENCODE_GO_AUTH_COOKIE",
    "OPENCODE_GO_WORKSPACE_ID",
    "OPENCODE_GO_AUTH_COOKIE",
  ] as const;

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of GO_ENV) delete process.env[key];
  });

  function stubModelsAndDashboard(
    dashboardStatus: number,
  ): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(
      async (url: string, _init?: RequestInit) => {
        if (String(url).endsWith("/zen/go/v1/models")) {
          return { ok: true, status: 200, text: async () => "{}" };
        }
        if (dashboardStatus === 200) {
          return { ok: true, status: 200, text: async () => ESCAPED_FIXTURE };
        }
        return { ok: false, status: dashboardStatus, text: async () => "" };
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.MULTI_AI_OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.MULTI_AI_OPENCODE_GO_AUTH_COOKIE = "cookie-1";
    return fetchMock;
  }

  it("attaches workspace quota when the dashboard fetch succeeds", async () => {
    const fetchMock = stubModelsAndDashboard(200);

    const result = await openCodeGoAdapter.probeQuota!("key-1", {
      accountId: "acc-1",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.openCodeGoQuota?.rolling?.usagePercent).toBeCloseTo(12.5, 3);
    const now = Date.now();
    expect(result.openCodeGoQuota?.rolling?.resetAt).toBeGreaterThan(
      now + 3_599_000,
    );
    expect(result.openCodeGoQuota?.rolling?.resetAt).toBeLessThanOrEqual(
      now + 3_601_000,
    );
    expect(result.openCodeGoQuota?.weekly?.usagePercent).toBe(25);
    expect(result.openCodeGoQuota?.monthly?.usagePercent).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stays ok:true without quota when the dashboard fetch fails", async () => {
    stubModelsAndDashboard(500);

    const result = await openCodeGoAdapter.probeQuota!("key-1", {
      accountId: "acc-1",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.openCodeGoQuota).toBeUndefined();
  });

  it("prefers the account's dashboard cred over env at probe time", async () => {
    const fetchMock = vi.fn(
      async (url: string, _init?: RequestInit) => {
        if (String(url).endsWith("/zen/go/v1/models")) {
          return { ok: true, status: 200, text: async () => "{}" };
        }
        return { ok: true, status: 200, text: async () => ESCAPED_FIXTURE };
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.MULTI_AI_OPENCODE_GO_WORKSPACE_ID = "wrk_env";
    process.env.MULTI_AI_OPENCODE_GO_AUTH_COOKIE = "cookie-env";

    const result = await openCodeGoAdapter.probeQuota!("key-1", {
      accountId: "acc-1",
      openCodeGoWorkspaceId: "wrk_account",
      openCodeGoAuthCookie: "auth=cookie-account",
    });

    expect(result.ok).toBe(true);
    expect(result.openCodeGoQuota?.monthly?.usagePercent).toBe(50);
    const dashboardCall = fetchMock.mock.calls.find(
      ([url]) => String(url).includes("/workspace/"),
    );
    expect(dashboardCall).toBeDefined();
    const url = String(dashboardCall![0]);
    const init = dashboardCall![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(url).toBe("https://opencode.ai/workspace/wrk_account/go");
    expect(headers.Cookie).toBe("auth=cookie-account");
  });

  it("falls back to env cred when the account carries none", async () => {
    const fetchMock = vi.fn(
      async (url: string, _init?: RequestInit) => {
        if (String(url).endsWith("/zen/go/v1/models")) {
          return { ok: true, status: 200, text: async () => "{}" };
        }
        return { ok: true, status: 200, text: async () => ESCAPED_FIXTURE };
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.MULTI_AI_OPENCODE_GO_WORKSPACE_ID = "wrk_env";
    process.env.MULTI_AI_OPENCODE_GO_AUTH_COOKIE = "cookie-env";

    const result = await openCodeGoAdapter.probeQuota!("key-1", {
      accountId: "acc-1",
    });

    expect(result.ok).toBe(true);
    expect(result.openCodeGoQuota?.rolling?.usagePercent).toBeCloseTo(12.5, 3);
    const dashboardCall = fetchMock.mock.calls.find(
      ([url]) => String(url).includes("/workspace/"),
    );
    expect(dashboardCall).toBeDefined();
    expect(String(dashboardCall![0])).toBe(
      "https://opencode.ai/workspace/wrk_env/go",
    );
    const init = dashboardCall![1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Cookie).toBe("auth=cookie-env");
  });

  it("skips the dashboard entirely when no env cred is configured", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        String(url).endsWith("/zen/go/v1/models")
          ? { ok: true, status: 200, text: async () => "{}" }
          : { ok: false, status: 404, text: async () => "" },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openCodeGoAdapter.probeQuota!("key-1", {
      accountId: "acc-1",
    });

    expect(result.ok).toBe(true);
    expect(result.openCodeGoQuota).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false with the HTTP status when the key is rejected", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: false, status: 401, text: async () => "" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openCodeGoAdapter.probeQuota!("bad-key", {
      accountId: "acc-1",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.reason).toBe("HTTP 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
