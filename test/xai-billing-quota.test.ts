import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseGrpcWebBillingResponse,
  fetchGrokBillingQuota,
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
    expect(parsed.remainingPercent).toBe(57); // 100 - Math.round(42.5)
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
});

describe("fetchGrokBillingQuota", () => {
  it("posts empty grpc-web frame and parses body", async () => {
    const resetEpoch = 1_800_000_000;
    const inner = concat(
      fixed32Field(1, 10),
      lengthDelimitedField(5, varintField(1, resetEpoch)),
    );
    const body = grpcWebFrame(lengthDelimitedField(1, inner));

    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toContain("GetGrokCreditsConfig");
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
  });
});
