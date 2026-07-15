import { describe, expect, it, beforeEach } from "vitest";
import {
  clearSessionOptions,
  getSessionOptions,
  rememberSessionOptions,
  sessionIdFromHeaders,
} from "../lib/core/session-options.js";

describe("session-options", () => {
  beforeEach(() => {
    clearSessionOptions();
  });

  it("remembers options by session id and falls back to last", () => {
    rememberSessionOptions("s1", {
      reasoningEffort: "high",
      store: false,
    });
    expect(getSessionOptions("s1")).toEqual({
      reasoningEffort: "high",
      store: false,
    });
    expect(getSessionOptions("missing")).toEqual({
      reasoningEffort: "high",
      store: false,
    });
  });

  it("ignores empty option bags", () => {
    rememberSessionOptions("s1", { unrelated: 1 });
    expect(getSessionOptions("s1")).toBeUndefined();
  });

  it("filters include to strings only", () => {
    rememberSessionOptions("s1", {
      include: ["reasoning.encrypted_content", 42, "x"],
    });
    expect(getSessionOptions("s1")).toEqual({
      include: ["reasoning.encrypted_content", "x"],
    });
  });

  it("clears one session or all", () => {
    rememberSessionOptions("s1", { reasoningEffort: "low" });
    rememberSessionOptions("s2", { reasoningEffort: "high" });
    clearSessionOptions("s1");
    expect(getSessionOptions("s1")?.reasoningEffort).toBe("high"); // last fallback
    clearSessionOptions();
    expect(getSessionOptions("s2")).toBeUndefined();
  });

  it("sessionIdFromHeaders reads common header names", () => {
    expect(sessionIdFromHeaders({ "x-session-id": "abc" })).toBe("abc");
    expect(
      sessionIdFromHeaders(new Headers({ "session-id": " def " })),
    ).toBe("def");
    expect(sessionIdFromHeaders(undefined)).toBeUndefined();
  });
});
