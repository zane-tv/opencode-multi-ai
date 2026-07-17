import { describe, expect, it } from "vitest";

import { classifyKiroSdkError } from "../lib/providers/kiro/request/classify-error.js";

describe("classifyKiroSdkError", () => {
  it("maps SDK metadata statuses to the shared taxonomy", () => {
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 400 }, message: "bad model" }),
    ).toEqual({ kind: "unknown-client-error", status: 400 });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 401 } }),
    ).toEqual({ kind: "auth-dead" });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 402 } }),
    ).toEqual({ kind: "quota-exhausted" });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 403 } }),
    ).toEqual({ kind: "entitlement-blocked" });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 429 } }),
    ).toMatchObject({ kind: "transient" });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 503 } }),
    ).toEqual({ kind: "server" });
    expect(classifyKiroSdkError(new Error("fetch failed"))).toEqual({
      kind: "network",
    });
  });
});
