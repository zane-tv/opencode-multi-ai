import type { Classification } from "../../../core/adapter.js";

export function classifyKiroSdkError(err: unknown): Classification {
  if (err && typeof err === "object") {
    const e = err as {
      name?: string;
      message?: string;
      $metadata?: { httpStatusCode?: number };
      Code?: string;
      code?: string;
    };
    if (e.name === "AbortError") {
      return { kind: "unknown-client-error", status: 499 };
    }
    const status = e.$metadata?.httpStatusCode;
    const message = `${e.message ?? ""} ${e.Code ?? ""} ${e.code ?? ""}`;
    if (status === 400) {
      return { kind: "unknown-client-error", status: 400 };
    }
    if (status === 401) {
      return { kind: "auth-dead" };
    }
    if (status === 402 || /quota|credit|limit/i.test(message)) {
      return { kind: "quota-exhausted" };
    }
    if (status === 403) {
      return { kind: "entitlement-blocked" };
    }
    if (status === 429) {
      return { kind: "transient", retryAfterMs: 5_000 };
    }
    if (typeof status === "number" && status >= 500) {
      return { kind: "server" };
    }
    if (
      /timeout|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(message) ||
      e.name === "TimeoutError"
    ) {
      return { kind: "network" };
    }
    if (typeof status === "number" && status >= 400) {
      return { kind: "unknown-client-error", status };
    }
  }
  return { kind: "network" };
}
