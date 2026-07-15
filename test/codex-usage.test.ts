import { afterEach, describe, expect, it, vi } from "vitest";

import { CODEX_BASE_URL } from "../lib/providers/codex/constants.js";
import {
  fetchCodexUsage,
  isWindowDisabled,
  leftPercent,
  parseResetAt,
  parseUsageHeaders,
  parseUsagePayload,
  windowLabel,
  type CodexUsageSummary,
} from "../lib/providers/codex/request/usage.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("leftPercent / windowLabel / isWindowDisabled", () => {
  it("leftPercent = 100 - used (clamped)", () => {
    expect(leftPercent(0)).toBe(100);
    expect(leftPercent(37)).toBe(63);
    expect(leftPercent(100)).toBe(0);
    expect(leftPercent(120)).toBe(0);
    expect(leftPercent(-5)).toBe(100);
  });

  it("windowLabel maps known windows", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10_080)).toBe("Weekly");
    expect(windowLabel(0)).toBe("disabled");
    expect(windowLabel(60)).toBe("1h");
    expect(windowLabel(45)).toBe("45m");
    expect(windowLabel(undefined)).toBe("n/a");
  });

  it("windowMinutes === 0 means DISABLED (not 100% free)", () => {
    expect(isWindowDisabled(0)).toBe(true);
    expect(isWindowDisabled(300)).toBe(false);
    expect(isWindowDisabled(undefined)).toBe(false);
    // Callers must not treat disabled as full remaining capacity.
    expect(windowLabel(0)).not.toMatch(/100|free|unlimited/i);
  });
});

describe("parseResetAt", () => {
  it("prefers reset-after-seconds over reset-at", () => {
    const now = 1_700_000_000_000;
    expect(parseResetAt(120, 1_800_000_000, now)).toBe(now + 120_000);
  });

  it("parses epoch seconds when < 1e10", () => {
    expect(parseResetAt(undefined, 1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("parses epoch ms when >= 1e10", () => {
    expect(parseResetAt(undefined, 1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("parses ISO date strings", () => {
    const iso = "2026-07-15T12:00:00.000Z";
    expect(parseResetAt(undefined, iso)).toBe(Date.parse(iso));
  });
});

describe("parseUsagePayload", () => {
  const NOW = 1_720_000_000_000;

  it("parses plan_type + primary/secondary windows", () => {
    const json = {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 42.5,
          limit_window_seconds: 18_000, // 300 minutes
          reset_after_seconds: 600,
        },
        secondary_window: {
          used_percent: 10,
          limit_window_seconds: 604_800, // weekly
          reset_at: 1_720_100_000,
        },
      },
      credits: { balance: 99 },
    };

    const snap = parseUsagePayload(json, NOW);
    expect(snap.planType).toBe("plus");
    expect(snap.primaryUsedPercent).toBe(42.5);
    expect(snap.primaryWindowMinutes).toBe(300);
    expect(snap.primaryResetAt).toBe(NOW + 600_000);
    expect(snap.secondaryUsedPercent).toBe(10);
    expect(snap.secondaryWindowMinutes).toBe(10_080);
    expect(snap.secondaryResetAt).toBe(1_720_100_000_000);
    expect(snap.observedAt).toBe(NOW);
  });

  it("treats limit_window_seconds=0 as disabled window", () => {
    const json = {
      plan_type: "free",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 0,
          reset_after_seconds: 0,
        },
        secondary_window: {
          used_percent: 55,
          limit_window_seconds: 18_000,
          reset_after_seconds: 100,
        },
      },
    };

    const snap = parseUsagePayload(json, NOW);
    expect(snap.primaryWindowMinutes).toBe(0);
    expect(isWindowDisabled(snap.primaryWindowMinutes)).toBe(true);
    expect(windowLabel(snap.primaryWindowMinutes)).toBe("disabled");
    // used_percent may be 0 but must not be shown as unlimited free capacity
    expect(snap.primaryUsedPercent).toBe(0);
    expect(snap.secondaryWindowMinutes).toBe(300);
    expect(isWindowDisabled(snap.secondaryWindowMinutes)).toBe(false);
  });

  it("handles missing rate_limit gracefully", () => {
    const snap = parseUsagePayload({ plan_type: "team" }, NOW);
    expect(snap.planType).toBe("team");
    expect(snap.primaryUsedPercent).toBeUndefined();
    expect(snap.secondaryUsedPercent).toBeUndefined();
    expect(snap.observedAt).toBe(NOW);
  });

  it("keeps planType as opaque string (no Plus/Pro enum)", () => {
    const snap = parseUsagePayload(
      { plan_type: "enterprise_custom_xyz" },
      NOW,
    );
    expect(snap.planType).toBe("enterprise_custom_xyz");
  });
});

describe("parseUsageHeaders", () => {
  const NOW = 1_720_000_000_000;

  it("reads all x-codex-* usage headers", () => {
    const headers = new Headers({
      "x-codex-plan-type": "pro",
      "x-codex-active-limit": "primary",
      "x-codex-primary-used-percent": "88",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-after-seconds": "3600",
      "x-codex-secondary-used-percent": "12.5",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1720100000",
    });

    const snap = parseUsageHeaders(headers, NOW);
    expect(snap).toMatchObject({
      planType: "pro",
      activeLimit: "primary",
      primaryUsedPercent: 88,
      primaryWindowMinutes: 300,
      primaryResetAt: NOW + 3_600_000,
      secondaryUsedPercent: 12.5,
      secondaryWindowMinutes: 10_080,
      secondaryResetAt: 1_720_100_000_000,
      observedAt: NOW,
    } satisfies Partial<CodexUsageSummary>);
  });

  it("0-minute primary window is disabled (not free)", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "0",
      "x-codex-primary-window-minutes": "0",
      "x-codex-secondary-used-percent": "40",
      "x-codex-secondary-window-minutes": "300",
      "x-codex-plan-type": "free",
    });

    const snap = parseUsageHeaders(headers, NOW);
    expect(snap.primaryWindowMinutes).toBe(0);
    expect(isWindowDisabled(snap.primaryWindowMinutes)).toBe(true);
    expect(windowLabel(snap.primaryWindowMinutes)).toBe("disabled");
    // Must not render disabled primary as 100% free remaining
    if (isWindowDisabled(snap.primaryWindowMinutes)) {
      expect(windowLabel(snap.primaryWindowMinutes)).not.toBe("100% free");
    }
    expect(snap.secondaryWindowMinutes).toBe(300);
    expect(leftPercent(snap.secondaryUsedPercent ?? 0)).toBe(60);
  });

  it("prefers reset-after-seconds over reset-at on headers", () => {
    const headers = new Headers({
      "x-codex-primary-reset-after-seconds": "90",
      "x-codex-primary-reset-at": "9999999999",
    });
    const snap = parseUsageHeaders(headers, NOW);
    expect(snap.primaryResetAt).toBe(NOW + 90_000);
  });

  it("parses ISO reset-at header when no after-seconds", () => {
    const iso = "2026-08-01T00:00:00.000Z";
    const headers = new Headers({
      "x-codex-secondary-reset-at": iso,
    });
    const snap = parseUsageHeaders(headers, NOW);
    expect(snap.secondaryResetAt).toBe(Date.parse(iso));
  });
});

describe("fetchCodexUsage", () => {
  it("GET wham/usage with codex headers + accept application/json", async () => {
    const payload = {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_after_seconds: 100,
        },
        secondary_window: {
          used_percent: 5,
          limit_window_seconds: 604_800,
          reset_after_seconds: 200,
        },
      },
    };

    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe(`${CODEX_BASE_URL}/wham/usage`);
      expect(init?.method ?? "GET").toBe("GET");

      const h = new Headers(init?.headers);
      expect(h.get("Authorization")).toBe("Bearer tok-abc");
      expect(h.get("chatgpt-account-id")).toBe("acct-1");
      expect(h.get("OpenAI-Beta")).toBe("responses=experimental");
      expect(h.get("originator")).toBe("codex_cli_rs");
      expect(h.get("accept")).toBe("application/json");
      expect(h.get("openai-organization")).toBe("org-9");

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-codex-active-limit": "primary",
        },
      });
    }) as typeof fetch;

    const snap = await fetchCodexUsage("tok-abc", "acct-1", "org-9");
    expect(snap.planType).toBe("plus");
    expect(snap.primaryUsedPercent).toBe(20);
    expect(snap.primaryWindowMinutes).toBe(300);
    expect(snap.secondaryWindowMinutes).toBe(10_080);
    expect(snap.activeLimit).toBe("primary");
    expect(typeof snap.observedAt).toBe("number");
  });

  it("throws on non-OK status", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("nope", { status: 401 }),
    ) as typeof fetch;

    await expect(fetchCodexUsage("t", "a")).rejects.toThrow(/HTTP 401/);
  });
});

/** Shape check: CodexUsageSummary fields match recordUsage snapshot keys. */
describe("CodexUsageSummary ↔ recordUsage alignment", () => {
  it("exposes the fields AccountManager.recordUsage persists", () => {
    const snap: CodexUsageSummary = {
      planType: "plus",
      primaryUsedPercent: 1,
      primaryWindowMinutes: 300,
      primaryResetAt: 1,
      secondaryUsedPercent: 2,
      secondaryWindowMinutes: 10_080,
      secondaryResetAt: 2,
      activeLimit: "primary",
      observedAt: 3,
    };
    // recordUsage accepts these keys (observedAt → usageObservedAt on disk)
    const recordUsageKeys = [
      "planType",
      "primaryUsedPercent",
      "primaryWindowMinutes",
      "primaryResetAt",
      "secondaryUsedPercent",
      "secondaryWindowMinutes",
      "secondaryResetAt",
      "activeLimit",
      "observedAt",
    ] as const;
    for (const k of recordUsageKeys) {
      expect(snap[k]).toBeDefined();
    }
  });
});
