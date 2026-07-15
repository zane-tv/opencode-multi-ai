import { afterEach, describe, expect, it } from "vitest";

import {
  sessionIdFromHeaders,
  transformCodexRequestInit,
} from "../lib/providers/codex/request/body-bridge.js";
import {
  clearSessionOptions,
  getSessionOptions,
  rememberSessionOptions,
} from "../lib/core/session-options.js";

afterEach(() => {
  clearSessionOptions();
});

describe("transformCodexRequestInit (body-bridge re-export)", () => {
  it("injects reasoning.effort and forces store:false + encrypted include", () => {
    const init = {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input: [], store: true }),
    };
    const next = transformCodexRequestInit(init, {
      reasoningEffort: "high",
      reasoningSummary: "auto",
    });
    expect(next).toBeTruthy();
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.store).toBe(false);
    expect(body.include).toContain("reasoning.encrypted_content");
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("overwrites reasoning.effort from session options", () => {
    const init = {
      body: JSON.stringify({
        model: "gpt-5-codex",
        reasoning: { effort: "low" },
      }),
    };
    const next = transformCodexRequestInit(init, {
      reasoningEffort: "high",
    });
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.reasoning.effort).toBe("high");
  });

  it("leaves non-json bodies untouched", () => {
    const init = { body: "not-json" };
    expect(transformCodexRequestInit(init, { reasoningEffort: "high" })).toBe(
      init,
    );
  });
});

describe("session options bridge", () => {
  it("remembers and returns per-session options", () => {
    rememberSessionOptions("s1", { reasoningEffort: "high" });
    rememberSessionOptions("s2", { reasoningEffort: "low" });
    expect(getSessionOptions("s1")?.reasoningEffort).toBe("high");
    expect(getSessionOptions("s2")?.reasoningEffort).toBe("low");
  });

  it("reads session id from OpenCode headers", () => {
    expect(sessionIdFromHeaders({ "x-session-id": "abc" })).toBe("abc");
    expect(sessionIdFromHeaders({ "X-Session-Id": "def" })).toBe("def");
  });
});
