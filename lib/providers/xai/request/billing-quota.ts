/**
 * SuperGrok / Grok Build coding credits.
 *
 * Primary (Grok Build): GET cli-chat-proxy `/v1/billing?format=credits`
 *   → creditUsagePercent, currentPeriod { type, start, end }
 * Fallback: grok.com gRPC-web GetGrokCreditsConfig (protobuf scan).
 */

export const GROK_CREDITS_BILLING_URL =
  "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export const GROK_BILLING_ENDPOINT =
  "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

export type BillingPeriodType = "weekly" | "monthly" | "unknown";

export type BillingQuotaSnapshot = {
  /** Credit usage % for the active period (0–100+, Grok Build floor semantics). */
  monthlyUsedPercent: number;
  remainingPercent: number;
  /** Epoch ms when the active period ends (next reset). */
  resetsAtMs?: number;
  periodType?: BillingPeriodType;
  periodStartMs?: number;
  periodEndMs?: number;
  isUnifiedBillingUser?: boolean;
  source?: "credits-json" | "grpc";
  observedAt: number;
};

type VarintField = { path: number[]; value: number };
type Fixed32Field = { path: number[]; value: number; order: number };

function readVarint(
  buf: Uint8Array,
  offset: number,
): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let p = offset;
  while (p < buf.length) {
    const b = buf[p++]!;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value, next: p };
    shift += 7;
    if (shift > 53) return null;
  }
  return null;
}

function grpcWebDataFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 5 <= data.length) {
    const flags = data[i]!;
    const length =
      (data[i + 1]! << 24) |
      (data[i + 2]! << 16) |
      (data[i + 3]! << 8) |
      data[i + 4]!;
    const start = i + 5;
    const end = start + length;
    if (end > data.length) break;
    if ((flags & 0x80) === 0) {
      frames.push(data.subarray(start, end));
    }
    i = end;
  }
  return frames;
}

function pathEq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function scanProtobuf(
  buf: Uint8Array,
  path: number[],
  depth: number,
  order: { n: number },
  varints: VarintField[],
  fixed32: Fixed32Field[],
): void {
  if (depth > 8) return;
  let p = 0;
  while (p < buf.length) {
    const key = readVarint(buf, p);
    if (!key) return;
    p = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (field === 0) return;

    if (wire === 0) {
      const v = readVarint(buf, p);
      if (!v) return;
      p = v.next;
      varints.push({ path: [...path, field], value: v.value });
    } else if (wire === 1) {
      if (p + 8 > buf.length) return;
      p += 8;
    } else if (wire === 2) {
      const ln = readVarint(buf, p);
      if (!ln) return;
      p = ln.next;
      const end = p + ln.value;
      if (end > buf.length) return;
      scanProtobuf(buf.subarray(p, end), [...path, field], depth + 1, order, varints, fixed32);
      p = end;
    } else if (wire === 5) {
      if (p + 4 > buf.length) return;
      const view = new DataView(buf.buffer, buf.byteOffset + p, 4);
      const f = view.getFloat32(0, true);
      fixed32.push({ path: [...path, field], value: f, order: order.n++ });
      p += 4;
    } else {
      return;
    }
  }
}

function numVal(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "val" in (v as object)) {
    const n = Number((v as { val: unknown }).val);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function parseIsoMs(v: unknown): number | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

function coerceEpochMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 0 && v < 1e12) return v * 1000;
    return v;
  }
  if (typeof v === "string" && v.trim()) {
    const asNum = Number(v);
    if (Number.isFinite(asNum)) return coerceEpochMs(asNum);
    return parseIsoMs(v);
  }
  return undefined;
}

/** Map Grok Build proto enum / loose labels → weekly | monthly | unknown. */
export function normalizeBillingPeriodType(
  raw: unknown,
): BillingPeriodType | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Observed proto: 1 monthly-ish, 2 weekly (Heavy live shape).
    if (raw === 2) return "weekly";
    if (raw === 1 || raw === 3) return "monthly";
    return "unknown";
  }
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const u = raw.toUpperCase();
  if (u.includes("WEEKLY") || u === "WEEK" || u === "W") return "weekly";
  if (u.includes("MONTHLY") || u === "MONTH" || u === "M") return "monthly";
  return "unknown";
}

/** Grok Build credit_bar.usage_label equivalent. */
export function billingPeriodLabel(
  periodType: BillingPeriodType | string | undefined,
): string {
  const t =
    typeof periodType === "string" &&
    (periodType === "weekly" ||
      periodType === "monthly" ||
      periodType === "unknown")
      ? periodType
      : normalizeBillingPeriodType(periodType);
  if (t === "weekly") return "Weekly limit";
  if (t === "monthly") return "Monthly limit";
  return "Credits";
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Parse Grok Build `GET …/billing?format=credits` JSON
 * (BillingConfigResponse / nested config).
 */
export function parseCreditsBillingJson(
  json: unknown,
  nowMs: number = Date.now(),
): BillingQuotaSnapshot {
  const root = asRecord(json) ?? {};
  const config = asRecord(root.config) ?? root;

  const usageRaw =
    numVal(config.creditUsagePercent) ??
    numVal(config.credit_usage_percent) ??
    numVal(root.creditUsagePercent) ??
    numVal(root.credit_usage_percent);

  const period =
    asRecord(config.currentPeriod) ??
    asRecord(config.current_period) ??
    asRecord(root.currentPeriod) ??
    asRecord(root.current_period);

  const periodType = normalizeBillingPeriodType(
    period?.type ?? period?.periodType ?? period?.period_type,
  );

  const periodStartMs =
    parseIsoMs(period?.start) ??
    coerceEpochMs(period?.start) ??
    parseIsoMs(config.billingPeriodStart) ??
    parseIsoMs(config.billing_period_start);

  const periodEndMs =
    parseIsoMs(period?.end) ??
    coerceEpochMs(period?.end) ??
    parseIsoMs(config.billingPeriodEnd) ??
    parseIsoMs(config.billing_period_end);

  let monthlyUsedPercent = usageRaw;
  if (monthlyUsedPercent === undefined) {
    const limit =
      numVal(config.monthlyLimit) ?? numVal(config.monthly_limit);
    const used = numVal(config.used) ?? numVal(config.totalUsed);
    if (
      limit !== undefined &&
      used !== undefined &&
      Number.isFinite(limit) &&
      limit > 0
    ) {
      monthlyUsedPercent = Math.min(999, Math.max(0, (used / limit) * 100));
    }
  }

  if (monthlyUsedPercent === undefined) {
    if (periodEndMs !== undefined) {
      monthlyUsedPercent = 0;
    } else {
      throw new Error("credits billing JSON missing creditUsagePercent");
    }
  }

  const used = Math.min(Math.max(monthlyUsedPercent, 0), 999);
  const remainingPercent = Math.max(0, 100 - Math.round(used));

  const unified =
    typeof config.isUnifiedBillingUser === "boolean"
      ? config.isUnifiedBillingUser
      : typeof config.is_unified_billing_user === "boolean"
        ? config.is_unified_billing_user
        : typeof root.isUnifiedBillingUser === "boolean"
          ? root.isUnifiedBillingUser
          : undefined;

  return {
    monthlyUsedPercent: used,
    remainingPercent,
    resetsAtMs: periodEndMs,
    periodType: periodType ?? (periodEndMs !== undefined ? "unknown" : undefined),
    periodStartMs,
    periodEndMs,
    isUnifiedBillingUser: unified,
    source: "credits-json",
    observedAt: nowMs,
  };
}

export function parseGrpcWebBillingResponse(
  data: Uint8Array,
  nowMs: number = Date.now(),
): BillingQuotaSnapshot {
  const frames = grpcWebDataFrames(data);
  if (frames.length === 0) {
    throw new Error("Grok billing response contained no protobuf data frames");
  }

  const varints: VarintField[] = [];
  const fixed32: Fixed32Field[] = [];
  const order = { n: 0 };
  for (const frame of frames) {
    scanProtobuf(frame, [], 0, order, varints, fixed32);
  }

  const usageCandidates = fixed32
    .filter((f) => f.path[f.path.length - 1] === 1 && f.value >= 0 && f.value <= 100)
    .sort((a, b) => {
      if (a.path.length !== b.path.length) return a.path.length - b.path.length;
      return a.order - b.order;
    });
  const preferredUsage = usageCandidates.filter((f) => pathEq(f.path, [1, 1]));
  const orderedUsage = preferredUsage.length > 0 ? preferredUsage : usageCandidates;

  const nowSec = nowMs / 1000;
  const resetCandidates = varints
    .filter((f) => f.value >= 1_700_000_000 && f.value <= 2_100_000_000 && f.value > nowSec)
    .map((f) => ({ path: f.path, dateMs: f.value * 1000 }));
  const preferredResets = resetCandidates.filter((r) => pathEq(r.path, [1, 5, 1]));
  const resetsAtMs =
    (preferredResets.length > 0 ? preferredResets : resetCandidates)
      .map((r) => r.dateMs)
      .sort((a, b) => a - b)[0];

  const periodTypeVar = varints.find(
    (f) => pathEq(f.path, [1, 8, 1]) || pathEq(f.path, [1, 8]),
  );
  const periodType = normalizeBillingPeriodType(periodTypeVar?.value);

  const hasCreditsShape = varints.some(
    (f) =>
      f.path.length >= 2 &&
      f.path[0] === 1 &&
      (f.path[1] === 6 || f.path[1] === 8 || f.path[1] === 5),
  );

  let monthlyUsedPercent: number | undefined;
  if (orderedUsage[0]) {
    monthlyUsedPercent = orderedUsage[0].value;
  } else if (fixed32.length === 0 && resetsAtMs !== undefined && hasCreditsShape) {
    monthlyUsedPercent = 0;
  }

  if (monthlyUsedPercent === undefined) {
    throw new Error("Could not parse Grok billing usage percent");
  }

  const used = Math.min(Math.max(monthlyUsedPercent, 0), 999);
  const remainingPercent = Math.max(0, 100 - Math.round(used));

  return {
    monthlyUsedPercent: used,
    remainingPercent,
    resetsAtMs,
    periodType,
    periodEndMs: resetsAtMs,
    source: "grpc",
    observedAt: nowMs,
  };
}

async function fetchCreditsJsonBilling(
  accessToken: string,
): Promise<BillingQuotaSnapshot> {
  const res = await fetch(GROK_CREDITS_BILLING_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-xai-token-auth": "xai-grok-cli",
      accept: "application/json",
      "user-agent": "opencode-multi-ai",
    },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `credits billing HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`,
    );
  }
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`credits billing non-JSON: ${text.slice(0, 80)}`);
    }
  }
  return parseCreditsBillingJson(json);
}

async function fetchGrpcBilling(
  accessToken: string,
): Promise<BillingQuotaSnapshot> {
  const emptyFrame = new Uint8Array([0, 0, 0, 0, 0]);
  const res = await fetch(GROK_BILLING_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-xai-token-auth": "xai-grok-cli",
      origin: "https://grok.com",
      referer: "https://grok.com/?_s=usage",
      accept: "*/*",
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      "x-user-agent": "connect-es/2.1.1",
      "user-agent": "Grok Build",
    },
    body: emptyFrame,
  });

  const bytes = new Uint8Array(await res.arrayBuffer());
  const grpcStatus = res.headers.get("grpc-status");
  if (grpcStatus && grpcStatus !== "0") {
    const msg =
      decodeURIComponent(res.headers.get("grpc-message") ?? "") ||
      `grpc-status ${grpcStatus}`;
    throw new Error(msg);
  }
  if (!res.ok) {
    const text = new TextDecoder().decode(bytes.subarray(0, 200));
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        text.trim() || `billing auth failed HTTP ${res.status}`,
      );
    }
    throw new Error(
      `billing HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`,
    );
  }

  return parseGrpcWebBillingResponse(bytes);
}

/**
 * Live credits probe. Prefer Grok Build JSON (`?format=credits`) for
 * weekly/monthly period type; fall back to gRPC-web protobuf scan.
 */
export async function fetchGrokBillingQuota(
  accessToken: string,
): Promise<BillingQuotaSnapshot> {
  try {
    return await fetchCreditsJsonBilling(accessToken);
  } catch {
    return fetchGrpcBilling(accessToken);
  }
}
