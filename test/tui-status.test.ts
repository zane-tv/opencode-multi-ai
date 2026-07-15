import { describe, expect, it } from "vitest";

import {
  renderStatusLine,
  summarizePool,
  type PoolStatusSummary,
  type StatusAccount,
} from "../lib/core/tui-status.js";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

function makeAccount(
  id: string,
  overrides: Partial<StatusAccount> = {},
): StatusAccount {
  return {
    accountId: id,
    // Token-like fields are NOT on StatusAccount; seed via cast only if needed.
    enabled: true,
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    ...overrides,
  };
}

describe("summarizePool", () => {
  it("counts each state bucket independently", () => {
    const accounts = [
      makeAccount("ready0"),
      makeAccount("ready1"),
      makeAccount("quota", { quotaResetAt: NOW + HOUR }),
      makeAccount("cooling", {
        coolingDownUntil: NOW + HOUR,
      }),
      makeAccount("blocked", { entitlementBlocked: true }),
      makeAccount("dead", { subscriptionStatus: "dead" }),
      makeAccount("flagged", { flaggedForRemoval: true }),
      makeAccount("disabled", { enabled: false }),
    ];

    const s = summarizePool(accounts, NOW);
    const expected: PoolStatusSummary = {
      total: 8,
      ready: 3, // ready0, ready1, flagged (flag alone does not block selection)
      quotaExhausted: 1,
      cooling: 1,
      entitlementBlocked: 1,
      dead: 1,
      flagged: 1,
      disabled: 1,
    };
    expect(s).toEqual(expected);
  });

  it("treats an expired quotaResetAt / coolingDownUntil as recovered (ready)", () => {
    const accounts = [
      makeAccount("a0", { quotaResetAt: NOW - 1_000 }),
      makeAccount("a1", { coolingDownUntil: NOW - 1_000 }),
    ];
    const s = summarizePool(accounts, NOW);
    expect(s.ready).toBe(2);
    expect(s.quotaExhausted).toBe(0);
    expect(s.cooling).toBe(0);
  });

  it("empty pool → all zero", () => {
    expect(summarizePool([], NOW)).toEqual({
      total: 0,
      ready: 0,
      quotaExhausted: 0,
      cooling: 0,
      entitlementBlocked: 0,
      dead: 0,
      flagged: 0,
      disabled: 0,
    });
  });
});

describe("renderStatusLine", () => {
  it("empty pool → 'ai: no accounts' by default", () => {
    expect(renderStatusLine([], 0, NOW)).toBe("ai: no accounts");
  });

  it("uses provider prefix when provided", () => {
    expect(renderStatusLine([], 0, NOW, { prefix: "xai" })).toBe(
      "xai: no accounts",
    );
    expect(renderStatusLine([], 0, NOW, { prefix: "codex" })).toBe(
      "codex: no accounts",
    );
  });

  it("renders the active account name (label ?? email ?? shortId)", () => {
    const accounts = [
      makeAccount("a0", { label: "work" }),
      makeAccount("a1"),
    ];
    expect(renderStatusLine(accounts, 0, NOW)).toContain("work");
  });

  it("falls back to email then shortId for the active name", () => {
    const byEmail = [makeAccount("a0", { email: "me@x.ai" })];
    expect(renderStatusLine(byEmail, 0, NOW)).toContain("me@x.ai");

    const longId = "1234567890abcdefghijkl";
    const byId = [makeAccount(longId)];
    const line = renderStatusLine(byId, 0, NOW);
    expect(line).toContain("1234567890ab…");
  });

  it("shows ready count plus quota / cooling / blocked / disabled segments", () => {
    const accounts = [
      makeAccount("a0", { label: "primary" }),
      makeAccount("a1", { quotaResetAt: NOW + HOUR }),
      makeAccount("a2", { coolingDownUntil: NOW + HOUR }),
      makeAccount("a3", { entitlementBlocked: true }),
      makeAccount("a4", { enabled: false }),
    ];
    const line = renderStatusLine(accounts, 0, NOW);
    expect(line).toContain("1 ready");
    expect(line).toContain("1 quota");
    expect(line).toContain("1 cooling");
    expect(line).toContain("1 blocked");
    expect(line).toContain("1 disabled");
  });

  it("omits zero-count segments (no '0 quota' noise)", () => {
    const line = renderStatusLine([makeAccount("a0")], 0, NOW);
    expect(line).toBe("ai: a0 · 1 ready");
    expect(line).not.toContain("quota");
    expect(line).not.toContain("cooling");
  });

  it("emits a ⚠ warning badge when any account is dead or flagged", () => {
    const dead = [
      makeAccount("a0", { label: "primary" }),
      makeAccount("a1", { subscriptionStatus: "dead" }),
    ];
    const deadLine = renderStatusLine(dead, 0, NOW, { prefix: "xai" });
    expect(deadLine).toContain("⚠");
    expect(deadLine).toContain("1 dead");
    expect(deadLine).toContain("xai-prune");

    const flagged = [makeAccount("a0", { flaggedForRemoval: true })];
    const flaggedLine = renderStatusLine(flagged, 0, NOW, {
      prefix: "codex",
    });
    expect(flaggedLine).toContain("⚠");
    expect(flaggedLine).toContain("1 flagged");
    expect(flaggedLine).toContain("codex-prune");
  });

  it("no warning badge for a healthy pool", () => {
    const line = renderStatusLine([makeAccount("a0")], 0, NOW);
    expect(line).not.toContain("⚠");
  });

  it("degrades gracefully when activeIndex is out of range", () => {
    const accounts = [makeAccount("a0")];
    const line = renderStatusLine(accounts, 5, NOW);
    expect(line).toBe("ai: 1 ready");
  });

  it("NEVER leaks token-like values into the output", () => {
    const secret = "rt-SECRET-should-not-appear";
    const accounts = [
      makeAccount("a0", { label: "work", email: "ok@example.com" }),
      makeAccount("a1", { subscriptionStatus: "dead" }),
    ];
    const line = renderStatusLine(accounts, 0, NOW);
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain(secret);
    expect(line).not.toContain("rt-");
    expect(line).not.toContain("at-");
  });
});
