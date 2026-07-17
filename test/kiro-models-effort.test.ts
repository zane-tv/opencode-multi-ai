import { describe, expect, it } from "vitest";

import {
  extractRegionFromArn,
  kiroCodeWhispererEndpoint,
  normalizeKiroRegion,
  PROVIDER_ID,
} from "../lib/providers/kiro/constants.js";
import {
  budgetToEffort,
  getEffectiveEffort,
  supportsEffort,
} from "../lib/providers/kiro/effort.js";
import {
  getContextWindowSize,
  normalizeOpenCodeModelSlug,
  resolveKiroModel,
} from "../lib/providers/kiro/models.js";

describe("Kiro model and effort foundation", () => {
  it("resolves thinking catalog ids and non-thinking aliases", () => {
    expect(PROVIDER_ID).toBe("kiro-multi");
    expect(normalizeOpenCodeModelSlug("kiro/claude-opus-4-8-thinking")).toBe(
      "claude-opus-4-8",
    );
    expect(resolveKiroModel("claude-opus-4-8-thinking")).toBe(
      "claude-opus-4.8",
    );
    expect(resolveKiroModel("kiro-multi/claude-sonnet-5-thinking")).toBe(
      "claude-sonnet-5",
    );
    expect(resolveKiroModel("claude-opus-4-8")).toBe("claude-opus-4.8");
    expect(resolveKiroModel("claude-opus-4-8-thinking-high")).toBe(
      "claude-opus-4.8",
    );
    expect(() => resolveKiroModel("gpt-5.6-sol")).toThrow(/Unsupported Kiro model/);
    expect(() => resolveKiroModel("unknown-model")).toThrow(/Unsupported Kiro model/);
  });

  it("maps reasoning budgets only for effort-capable models", () => {
    expect(supportsEffort("claude-opus-4.8")).toBe(true);
    expect(budgetToEffort(8_000, "claude-opus-4.8")).toBe("low");
    expect(budgetToEffort(30_000, "claude-opus-4.8")).toBe("max");
    expect(budgetToEffort(30_000, "gpt-5.6-terra")).toBe("xhigh");
    expect(getEffectiveEffort("claude-opus-4.8", false, 20_000)).toBeUndefined();
    expect(getEffectiveEffort("claude-opus-4.8", true, 20_000)).toBe("medium");
  });

  it("uses valid AWS regions and source-compatible context limits", () => {
    expect(normalizeKiroRegion("eu-central-1")).toBe("eu-central-1");
    expect(normalizeKiroRegion("not-a-region")).toBe("us-east-1");
    expect(kiroCodeWhispererEndpoint("us-east-1")).toBe(
      "https://q.us-east-1.amazonaws.com",
    );
    expect(
      extractRegionFromArn("arn:aws:codewhisperer:eu-central-1:123:profile/x"),
    ).toBe("eu-central-1");
    expect(extractRegionFromArn("not-an-arn")).toBeUndefined();
    expect(getContextWindowSize("claude-sonnet-5")).toBe(1_000_000);
    expect(getContextWindowSize("gpt-5.6-terra")).toBe(272_000);
  });
});
