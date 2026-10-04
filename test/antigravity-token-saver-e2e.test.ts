import { describe, expect, it } from "vitest";
import { transformOpenAiToGemini } from "../lib/providers/antigravity/request/transform.js";
import { cleanJSONSchemaForAntigravity, sanitizeFunctionName } from "../lib/providers/antigravity/request/clean-schema.js";

describe("Antigravity Token Saver E2E Simulation", () => {
  it("Scenario A: Zero-thinking fast edit mode completely disables thinking", () => {
    const payload = transformOpenAiToGemini(
      {
        model: "claude-opus-4-6-thinking",
        reasoningEffort: "none",
        messages: [{ role: "user", content: "Fix typo on line 12" }],
      },
      { projectId: "ag-test-proj" },
    );

    expect(payload.model).toBe("claude-opus-4-6-thinking");
    expect(payload.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
    // When thinkingBudget is 0, includeThoughts must not be true
    expect(payload.request.generationConfig?.thinkingConfig?.includeThoughts).toBeUndefined();
  });

  it("Scenario B: Variant low provides a tight 1024 token budget", () => {
    const payload = transformOpenAiToGemini(
      {
        model: "claude-opus-4-6-thinking",
        reasoningEffort: "low",
        messages: [{ role: "user", content: "Refactor this method to use GetxController" }],
      },
      { projectId: "ag-test-proj" },
    );

    expect(payload.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1024);
    expect(payload.request.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
  });

  it("Scenario C: Multi-turn agent loop automatically caps intermediate tool follow-up steps", () => {
    // Turn 1: Initial user prompt -> gets calibrated default (2048)
    const turn1 = transformOpenAiToGemini(
      {
        model: "claude-opus-4-6-thinking",
        messages: [
          { role: "user", content: "Find why login button is not triggering" },
        ],
      },
      { projectId: "ag-test-proj" },
    );
    expect(turn1.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(2048);

    // Turn 2: Model calls view_file, tool returns file content -> intermediate follow-up automatically caps to 1024
    const turn2 = transformOpenAiToGemini(
      {
        model: "claude-opus-4-6-thinking",
        messages: [
          { role: "user", content: "Find why login button is not triggering" },
          {
            role: "assistant",
            content: "I will view the permission controller file.",
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "view_file",
                  arguments: JSON.stringify({ AbsolutePath: "/app/controller.dart" }),
                },
              },
            ],
          },
          {
            role: "tool",
            name: "view_file",
            tool_call_id: "call_123",
            content: JSON.stringify({ content: "class PermissionController extends GetxController {}" }),
          },
        ],
      },
      { projectId: "ag-test-proj" },
    );
    expect(turn2.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1024);
  });

  it("Scenario D: Explicit user variant (high) is respected even on tool follow-up turns", () => {
    const turnWithExplicitHigh = transformOpenAiToGemini(
      {
        model: "claude-opus-4-6-thinking",
        reasoningEffort: "high",
        messages: [
          { role: "user", content: "Analyze entire system architecture" },
          {
            role: "assistant",
            content: "Checking controller.",
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: { name: "view_file", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            name: "view_file",
            tool_call_id: "call_123",
            content: "{}",
          },
        ],
      },
      { projectId: "ag-test-proj" },
    );
    // Explicit user choice wins over adaptive 1024
    expect(turnWithExplicitHigh.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(8192);
  });

  it("Scenario E: Clean schema correctly strips unsupported constraints before sending to Google", () => {
    const rawToolSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description: "Shell command line",
        },
        timeout: {
          type: "number",
          minimum: 100,
        },
      },
      required: ["command", "unknownField"],
      additionalProperties: false,
    };

    const cleaned = cleanJSONSchemaForAntigravity(rawToolSchema);
    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.additionalProperties).toBeUndefined();
    expect((cleaned.properties as Record<string, unknown>).command).toBeDefined();
    expect(((cleaned.properties as Record<string, unknown>).command as Record<string, unknown>).minLength).toBeUndefined();
    expect(cleaned.required).toEqual(["command"]);
    expect(sanitizeFunctionName("run-command.v1")).toBe("run-command.v1");
  });

  it("Scenario F: Claude Sonnet calibrated default is 1024 tokens", () => {
    const sonnet = transformOpenAiToGemini(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Write a unit test" }],
      },
      { projectId: "ag-test-proj" },
    );
    expect(sonnet.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1024);
  });
});
