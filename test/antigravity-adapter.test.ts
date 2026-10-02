import { describe, expect, it } from "vitest";
import { antigravityAdapter } from "../lib/providers/antigravity/adapter.js";
import { resolveAntigravityMultiModels } from "../lib/providers/antigravity/models-sync.js";

describe("Antigravity Adapter", () => {
  it("has correct provider descriptor fields", () => {
    expect(antigravityAdapter.id).toBe("antigravity-multi");
    expect(antigravityAdapter.provider).toBe("antigravity");
    expect(antigravityAdapter.displayName).toContain("Antigravity");
    expect(antigravityAdapter.npmPackage).toBe("@ai-sdk/openai-compatible");
    expect(antigravityAdapter.baseURL).toBe("https://daily-cloudcode-pa.googleapis.com");
    expect(antigravityAdapter.transport.kind).toBe("custom");
  });

  it("resolves default models correctly", async () => {
    const models = (await resolveAntigravityMultiModels({})) as Record<
      string,
      { name: string; limit?: { context: number; output: number } }
    >;

    expect(models["gemini-3.8-flash-high"]).toBeDefined();
    expect(models["gemini-3.7-flash"]).toBeDefined();
    expect(models["gemini-3.6-flash"]).toBeDefined();
    expect(models["gemini-3.1-pro"]).toBeDefined();
    expect(models["gemini-3-flash"]).toBeDefined();

    expect(models["gemini-3.8-flash-high"].limit?.context).toBe(1_048_576);
    expect(models["gemini-3.1-pro"].limit?.context).toBe(2_097_152);
  });

  it("formats listSubtitle and detailLines correctly", () => {
    const account = {
      accountId: "ag-test-1",
      email: "engineer@gmail.com",
      projectId: "project-12345",
      accountType: "tier-1",
    };

    const subtitle = antigravityAdapter.listSubtitle(account, Date.now());
    expect(subtitle).toBe("tier-1");

    const details = antigravityAdapter.detailLines(account, Date.now());
    expect(details).toContain("engineer@gmail.com");
    expect(details).toContain("project: project-12345");
  });

  it("indicates recovering status when quotaResetAt is in the future", () => {
    const now = Date.now();
    const account = {
      accountId: "ag-test-2",
      quotaResetAt: now + 45 * 60 * 1000, // 45 mins left
    };

    const subtitle = antigravityAdapter.listSubtitle(account, now);
    expect(subtitle).toBe("recovering · 45m left");
  });
});
