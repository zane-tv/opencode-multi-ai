import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseGrpcWebBillingResponse,
  parseCreditsBillingJson,
  fetchGrokBillingQuota,
  billingPeriodLabel,
  normalizeBillingPeriodType,
  GROK_CREDITS_BILLING_URL,
} from "../lib/providers/xai/request/billing-quota.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return new Uint8Array(bytes);
}

function varintField(field: number, value: number): Uint8Array {
  const key = encodeVarint((field << 3) | 0);
  const val = encodeVarint(value);
  const out = new Uint8Array(key.length + val.length);
  out.set(key, 0);
  out.set(val, key.length);
  return out;
}

function fixed32Field(field: number, value: number): Uint8Array {
  const key = encodeVarint((field << 3) | 5);
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  const out = new Uint8Array(key.length + 4);
  out.set(key, 0);
  out.set(new Uint8Array(buf), key.length);
  return out;
}

function lengthDelimitedField(field: number, payload: Uint8Array): Uint8Array {
  const key = encodeVarint((field << 3) | 2);
  const len = encodeVarint(payload.length);
  const out = new Uint8Array(key.length + len.length + payload.length);
  out.set(key, 0);
  out.set(len, key.length);
  out.set(payload, key.length + len.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function grpcWebFrame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + message.length);
  out[0] = 0;
  out[1] = (message.length >>> 24) & 0xff;
  out[2] = (message.length >>> 16) & 0xff;
  out[3] = (message.length >>> 8) & 0xff;
  out[4] = message.length & 0xff;
  out.set(message, 5);
  return out;
}

describe("parseGrpcWebBillingResponse", () => {
  it("reads monthly used % and preferred reset path", () => {
    const resetEpoch = 1_800_000_000;
    const inner = concat(
      fixed32Field(1, 42.5),
      lengthDelimitedField(5, varintField(1, resetEpoch)),
    );
    const message = lengthDelimitedField(1, inner);
    const response = grpcWebFrame(message);

    const parsed = parseGrpcWebBillingResponse(
      response,
      1_700_000_000 * 1000,
    );
    expect(parsed.monthlyUsedPercent).toBeCloseTo(42.5, 2);
    expect(parsed.remainingPercent).toBe(57);
    expect(parsed.resetsAtMs).toBe(resetEpoch * 1000);
  });

  it("uses 0% when only reset marker is present", () => {
    const resetEpoch = 1_800_000_000;
    const inner = concat(
      lengthDelimitedField(5, varintField(1, resetEpoch)),
      lengthDelimitedField(6, varintField(1, 1)),
    );
    const parsed = parseGrpcWebBillingResponse(
      grpcWebFrame(lengthDelimitedField(1, inner)),
      1_700_000_000 * 1000,
    );
    expect(parsed.monthlyUsedPercent).toBe(0);
    expect(parsed.remainingPercent).toBe(100);
  });

  it("uses 0% when credit_usage_percent omitted but current_period present", () => {
    const periodStart = 1_784_128_107;
    const periodEnd = 1_784_732_907;
    const period = concat(
      varintField(1, 2),
      lengthDelimitedField(2, varintField(1, periodStart)),
      lengthDelimitedField(3, varintField(1, periodEnd)),
    );
    const inner = concat(
      lengthDelimitedField(4, varintField(1, periodStart)),
      lengthDelimitedField(5, varintField(1, periodEnd)),
      lengthDelimitedField(8, period),
      varintField(11, 1),
      varintField(13, 1),
    );
    const parsed = parseGrpcWebBillingResponse(
      grpcWebFrame(lengthDelimitedField(1, inner)),
      1_784_200_000 * 1000,
    );
    expect(parsed.monthlyUsedPercent).toBe(0);
    expect(parsed.remainingPercent).toBe(100);
    expect(parsed.resetsAtMs).toBe(periodEnd * 1000);
    expect(parsed.periodType).toBe("weekly");
  });
});

describe("parseCreditsBillingJson", () => {
  it("reads weekly period + usage like Grok Build", () => {
    const now = Date.parse("2026-07-19T12:00:00Z");
    const parsed = parseCreditsBillingJson(
      {
        config: {
          creditUsagePercent: 73.4,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-07-15T15:08:00Z",
            end: "2026-07-22T15:08:00Z",
          },
          isUnifiedBillingUser: true,
        },
      },
      now,
    );
    expect(parsed.monthlyUsedPercent).toBeCloseTo(73.4, 1);
    expect(parsed.remainingPercent).toBe(27);
    expect(parsed.periodType).toBe("weekly");
    expect(parsed.periodEndMs).toBe(Date.parse("2026-07-22T15:08:00Z"));
    expect(parsed.resetsAtMs).toBe(parsed.periodEndMs);
    expect(parsed.isUnifiedBillingUser).toBe(true);
    expect(parsed.source).toBe("credits-json");
  });

  it("accepts snake_case and monthly enum", () => {
    const parsed = parseCreditsBillingJson({
      credit_usage_percent: 10,
      current_period: {
        period_type: "USAGE_PERIOD_TYPE_MONTHLY",
        end: "2026-08-01T00:00:00Z",
      },
    });
    expect(parsed.periodType).toBe("monthly");
    expect(parsed.remainingPercent).toBe(90);
  });
});

describe("billingPeriodLabel / normalizeBillingPeriodType", () => {
  it("maps labels for UI", () => {
    expect(normalizeBillingPeriodType("USAGE_PERIOD_TYPE_WEEKLY")).toBe(
      "weekly",
    );
    expect(normalizeBillingPeriodType(2)).toBe("weekly");
    expect(billingPeriodLabel("weekly")).toBe("Weekly limit");
    expect(billingPeriodLabel("monthly")).toBe("Monthly limit");
    expect(billingPeriodLabel(undefined)).toBe("Credits");
  });
});

describe("fetchGrokBillingQuota", () => {
  it("prefers format=credits JSON", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        return new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 50,
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                end: "2026-07-22T15:08:00Z",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const snap = await fetchGrokBillingQuota("tok");
    expect(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe(
      GROK_CREDITS_BILLING_URL,
    );
    expect(snap.periodType).toBe("weekly");
    expect(snap.monthlyUsedPercent).toBe(50);
    expect(snap.remainingPercent).toBe(50);
  });

  it("falls back to grpc-web when credits JSON fails", async () => {
    const resetEpoch = 1_800_000_000;
    const inner = concat(
      fixed32Field(1, 10),
      lengthDelimitedField(5, varintField(1, resetEpoch)),
    );
    const body = grpcWebFrame(lengthDelimitedField(1, inner));

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        return new Response("nope", { status: 500 });
      }
      expect(url).toContain("GetGrokCreditsConfig");
      expect((init as RequestInit).method).toBe("POST");
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get("authorization")).toMatch(/^Bearer /);
      expect(headers.get("content-type")).toBe("application/grpc-web+proto");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/grpc-web+proto" },
      });
    }) as typeof fetch;

    const snap = await fetchGrokBillingQuota("tok");
    expect(snap.monthlyUsedPercent).toBeCloseTo(10, 1);
    expect(snap.remainingPercent).toBe(90);
    expect(snap.source).toBe("grpc");
  });
});
