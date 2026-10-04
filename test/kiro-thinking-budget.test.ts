import { describe, expect, it } from "vitest";
import { parseOpenAiBody } from "../lib/providers/kiro/request/kiro-fetch.js";

describe("Kiro thinking budget & effort resolution", () => {
  it("defaults thinking budget to 2048 for thinking models when unspecified", () => {
    const parsed = parseOpenAiBody({
      body: JSON.stringify({
        model: "claude-opus-5-thinking",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(parsed.thinking).toBe(true);
    expect(parsed.thinkingBudget).toBe(2048);
  });

  it("disables thinking when thinking is false or type is disabled", () => {
    const disabled1 = parseOpenAiBody({
      body: JSON.stringify({
        model: "claude-opus-5-thinking",
        thinking: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(disabled1.thinking).toBe(false);
    expect(disabled1.thinkingBudget).toBe(0);

    const disabled2 = parseOpenAiBody({
      body: JSON.stringify({
        model: "claude-opus-5-thinking",
        thinkingConfig: { type: "disabled" },
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(disabled2.thinking).toBe(false);
    expect(disabled2.thinkingBudget).toBe(0);

    const disabled3 = parseOpenAiBody({
      body: JSON.stringify({
        model: "claude-opus-5-thinking",
        thinkingConfig: { thinkingBudget: 0 },
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(disabled3.thinking).toBe(false);
    expect(disabled3.thinkingBudget).toBe(0);
  });

  it("handles reasoningEffort: none, low, medium, high", () => {
    const none = parseOpenAiBody({
      body: JSON.stringify({
        model: "claude-opus-5-thinking",
        reasoningEffort: "none",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(none.thinking).toBe(false);
    expect(none.thinkingBudget).toBe(0);

    const low = parseOpenAiBody({
      body: JSON.stringify({
        model: "claude-opus-5-thinking",
        reasoningEffort: "low",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(low.thinking).toBe(true);
    expect(low.thinkingBudget).toBe(2048);

    const medium = parseOpenAiBody({
      body: JSON.stringify({
        model: "claude-opus-5-thinking",
        reasoning_effort: "medium",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(medium.thinking).toBe(true);
    expect(medium.thinkingBudget).toBe(4096);

    const high = parseOpenAiBody({
      body: JSON.stringify({
        model: "claude-opus-5-thinking",
        reasoningEffort: "high",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(high.thinking).toBe(true);
    expect(high.thinkingBudget).toBe(8192);
  });

  it("honors explicit thinkingBudget from thinkingConfig", () => {
    const explicit = parseOpenAiBody({
      body: JSON.stringify({
        model: "claude-opus-5-thinking",
        thinkingConfig: { thinkingBudget: 1234 },
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(explicit.thinking).toBe(true);
    expect(explicit.thinkingBudget).toBe(1234);
  });
});
