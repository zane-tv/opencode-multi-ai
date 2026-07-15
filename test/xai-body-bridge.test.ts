import { afterEach, describe, expect, it } from "vitest";

import {
  injectXaiReasoningBody,
  sessionIdFromHeaders,
} from "../lib/providers/xai/request/body-bridge.js";
import {
  clearSessionOptions,
  getSessionOptions,
  rememberSessionOptions,
} from "../lib/core/session-options.js";

afterEach(() => {
  clearSessionOptions();
});

describe("injectXaiReasoningBody", () => {
  it("injects reasoning.effort into Responses bodies", () => {
    const url = new URL("https://api.x.ai/v1/responses");
    const init = {
      method: "POST",
      body: JSON.stringify({ model: "grok-4.5", input: [] }),
    };
    const next = injectXaiReasoningBody(url, init, {
      reasoningEffort: "high",
      reasoningSummary: "auto",
    });
    expect(next).toBeTruthy();
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("does not overwrite an existing reasoning.effort on non-forced models", () => {
    const url = new URL("https://api.x.ai/v1/responses");
    const init = {
      body: JSON.stringify({
        model: "grok-4.3",
        reasoning: { effort: "low" },
      }),
    };
    const next = injectXaiReasoningBody(url, init, {
      reasoningEffort: "high",
    });
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.reasoning.effort).toBe("low");
  });

  it("force-pins grok-4.5 effort to high even when body already has lower effort", () => {
    const url = new URL("https://api.x.ai/v1/responses");
    const init = {
      body: JSON.stringify({
        model: "grok-4.5",
        reasoning: { effort: "low" },
      }),
    };
    const next = injectXaiReasoningBody(url, init, {
      reasoningEffort: "medium",
    });
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.reasoning.effort).toBe("high");
  });

  it("force-pins grok-4.5 effort to high when session options are missing", () => {
    const url = new URL("https://api.x.ai/v1/responses");
    const init = {
      body: JSON.stringify({ model: "xai-multi/grok-4.5", input: [] }),
    };
    const next = injectXaiReasoningBody(url, init, undefined);
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("injects reasoning_effort into chat completions as fallback", () => {
    const url = new URL("https://api.x.ai/v1/chat/completions");
    const init = {
      body: JSON.stringify({ model: "grok-4.3", messages: [] }),
    };
    const next = injectXaiReasoningBody(url, init, {
      reasoningEffort: "medium",
    });
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.reasoning_effort).toBe("medium");
  });

  it("force-pins grok-4.5 chat completions reasoning_effort to high", () => {
    const url = new URL("https://api.x.ai/v1/chat/completions");
    const init = {
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [],
        reasoning_effort: "low",
      }),
    };
    const next = injectXaiReasoningBody(url, init, {
      reasoningEffort: "medium",
    });
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.reasoning_effort).toBe("high");
  });

  it("leaves non-json bodies untouched", () => {
    const url = new URL("https://api.x.ai/v1/responses");
    const init = { body: "not-json" };
    expect(injectXaiReasoningBody(url, init, { reasoningEffort: "high" })).toBe(
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
    expect(
      sessionIdFromHeaders({ "x-session-id": "abc" }),
    ).toBe("abc");
    expect(
      sessionIdFromHeaders({ "X-Session-Id": "def" }),
    ).toBe("def");
  });
});
