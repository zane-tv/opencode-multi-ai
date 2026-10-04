import { describe, expect, it } from "vitest";
import {
  transformOpenAiToGemini,
  type OpenAiRequestBody,
} from "../lib/providers/antigravity/request/transform.js";
import { cleanJSONSchemaForAntigravity, sanitizeFunctionName } from "../lib/providers/antigravity/request/clean-schema.js";

describe("Antigravity Schema Cleaning & Function Sanitizer", () => {
  it("sanitizes function names to Gemini format", () => {
    expect(sanitizeFunctionName("valid_name")).toBe("valid_name");
    expect(sanitizeFunctionName("invalid-name.v1:tool")).toBe("invalid-name.v1:tool");
    expect(sanitizeFunctionName("123startsWithNumber")).toBe("_123startsWithNumber");
    expect(sanitizeFunctionName("has spaces and @ symbols!")).toBe("has_spaces_and___symbols_");
  });

  it("removes unsupported schema constraints and ensures object type", () => {
    const rawSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 3,
          maxLength: 100,
          pattern: "^[a-z]+$",
          description: "Search query",
        },
        tags: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
      required: ["query", "nonExistentField"],
      additionalProperties: false,
    };

    const cleaned = cleanJSONSchemaForAntigravity(rawSchema);

    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.additionalProperties).toBeUndefined();
    expect(cleaned.type).toBe("object");

    const queryProp = (cleaned.properties as Record<string, unknown>).query as Record<string, unknown>;
    expect(queryProp.minLength).toBeUndefined();
    expect(queryProp.maxLength).toBeUndefined();
    expect(queryProp.pattern).toBeUndefined();
    expect(queryProp.description).toBe("Search query");

    // nonExistentField should be stripped from required
    expect(cleaned.required).toEqual(["query"]);
  });

  it("adds placeholder to empty object schemas as required by Antigravity", () => {
    const emptySchema = { type: "object", properties: {} };
    const cleaned = cleanJSONSchemaForAntigravity(emptySchema);

    expect(cleaned.properties).toBeDefined();
    expect((cleaned.properties as Record<string, unknown>).reason).toBeDefined();
    expect(cleaned.required).toEqual(["reason"]);
  });
});

describe("Antigravity Request Transformer", () => {
  it("transforms user and assistant messages with system prompt prepended", () => {
    const body: OpenAiRequestBody = {
      model: "gemini-3.8-flash",
      messages: [
        { role: "system", content: "You are an expert Flutter engineer." },
        { role: "user", content: "Explain StateNotifier in GetX." },
        { role: "assistant", content: "GetX uses GetxController." },
      ],
    };

    const payload = transformOpenAiToGemini(body, {
      projectId: "my-ag-project",
      sessionId: "session-123",
    });

    expect(payload.project).toBe("my-ag-project");
    expect(payload.model).toBe("gemini-3.6-flash-high");
    expect(payload.userAgent).toBe("antigravity");
    expect(payload.request.sessionId).toBe("session-123");
    expect(payload.request.systemInstruction?.parts[0].text).toContain("You are an expert Flutter engineer.");

    const contents = payload.request.contents;
    expect(contents).toHaveLength(2);

    expect(contents[0].role).toBe("user");
    expect(contents[0].parts[0].text).toBe("Explain StateNotifier in GetX.");

    expect(contents[1].role).toBe("model");
    expect(contents[1].parts[0].text).toBe("GetX uses GetxController.");
  });

  it("correctly formats tool calls and tool responses", () => {
    const body: OpenAiRequestBody = {
      model: "gemini-3.8-flash",
      messages: [
        { role: "user", content: "List current directory" },
        {
          role: "assistant",
          content: "Let me check the files.",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "list_dir",
                arguments: JSON.stringify({ DirectoryPath: "/app" }),
              },
            },
          ],
        },
        {
          role: "tool",
          name: "list_dir",
          tool_call_id: "call_abc",
          content: JSON.stringify({ files: ["main.dart", "pubspec.yaml"] }),
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "list_dir",
            description: "List directory files",
            parameters: {
              type: "object",
              properties: { DirectoryPath: { type: "string" } },
              required: ["DirectoryPath"],
            },
          },
        },
      ],
    };

    const payload = transformOpenAiToGemini(body, {
      projectId: "test-proj",
    });

    const contents = payload.request.contents;
    expect(contents).toHaveLength(3);

    // Assistant with tool call
    expect(contents[1].role).toBe("model");
    expect(contents[1].parts[0].text).toBe("Let me check the files.");
    expect(contents[1].parts[1].functionCall).toEqual({
      id: "call_abc",
      name: "list_dir",
      args: { DirectoryPath: "/app" },
    });

    // Tool response (Gemini role: user)
    expect(contents[2].role).toBe("user");
    expect(contents[2].parts[0].functionResponse).toEqual({
      id: "call_abc",
      name: "list_dir",
      response: { files: ["main.dart", "pubspec.yaml"] },
    });

    // Tools converted
    expect(payload.request.tools).toBeDefined();
    expect(payload.request.tools![0].functionDeclarations).toHaveLength(1);
    expect(payload.request.tools![0].functionDeclarations[0].name).toBe("list_dir");
  });

  it("configures thinkingBudget 0 for gemini-3-flash for instant responses", () => {
    const body: OpenAiRequestBody = {
      model: "gemini-3-flash",
      messages: [{ role: "user", content: "Hi" }],
    };

    const payload = transformOpenAiToGemini(body, { projectId: "test-proj" });
    expect(payload.model).toBe("gemini-3-flash");
    expect(payload.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
  });

  it("configures thinkingBudget for low and high thinking models", () => {
    const lowPayload = transformOpenAiToGemini(
      { model: "gemini-3.8-flash-low", messages: [{ role: "user", content: "Hi" }] },
      { projectId: "test-proj" },
    );
    expect(lowPayload.model).toBe("gemini-3.6-flash-low");
    expect(lowPayload.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(2048);

    const highPayload = transformOpenAiToGemini(
      { model: "gemini-3.8-flash-high", messages: [{ role: "user", content: "Hi" }] },
      { projectId: "test-proj" },
    );
    expect(highPayload.model).toBe("gemini-3.6-flash-high");
    expect(highPayload.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(8192);

    const effortPayload = transformOpenAiToGemini(
      { model: "gemini-3.8-flash", reasoning_effort: "high", messages: [{ role: "user", content: "Hi" }] },
      { projectId: "test-proj" },
    );
    expect(effortPayload.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(8192);
  });

  it("correctly routes Claude Opus, Claude Sonnet, Gemini Pro, and Flash without falling through", () => {
    // Opus variants
    const opus1 = transformOpenAiToGemini({ model: "opus" }, { projectId: "p" });
    expect(opus1.model).toBe("claude-opus-4-6-thinking");

    const opus2 = transformOpenAiToGemini({ model: "antigravity-multi/claude-opus-4-6-thinking" }, { projectId: "p" });
    expect(opus2.model).toBe("claude-opus-4-6-thinking");

    // Sonnet variants
    const sonnet1 = transformOpenAiToGemini({ model: "sonnet" }, { projectId: "p" });
    expect(sonnet1.model).toBe("claude-sonnet-4-6");

    const sonnet2 = transformOpenAiToGemini({ model: "claude-3-5-sonnet" }, { projectId: "p" });
    expect(sonnet2.model).toBe("claude-sonnet-4-6");

    // Pro variants
    const pro1 = transformOpenAiToGemini({ model: "gemini-3.1-pro" }, { projectId: "p" });
    expect(pro1.model).toBe("gemini-3.1-pro-low");

    // Flash zero
    const flash1 = transformOpenAiToGemini({ model: "gemini-3-flash" }, { projectId: "p" });
    expect(flash1.model).toBe("gemini-3-flash");
    expect(flash1.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
  });

  it("calibrates Claude Opus and Sonnet thinking budgets for token efficiency", () => {
    // Opus default without explicit effort is calibrated to 2048 (not 8192)
    const opusDefault = transformOpenAiToGemini(
      { model: "claude-opus-4-6-thinking", messages: [{ role: "user", content: "hello" }] },
      { projectId: "p" },
    );
    expect(opusDefault.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(2048);

    // Sonnet default without explicit effort is calibrated to 1024 (not 4096)
    const sonnetDefault = transformOpenAiToGemini(
      { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hello" }] },
      { projectId: "p" },
    );
    expect(sonnetDefault.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1024);

    // Zero thinking (effort === "none") disables thinking completely
    const opusNone = transformOpenAiToGemini(
      { model: "claude-opus-4-6-thinking", reasoning_effort: "none", messages: [{ role: "user", content: "hello" }] },
      { projectId: "p" },
    );
    expect(opusNone.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);

    // CamelCase reasoningEffort is recognized
    const opusLowCamel = transformOpenAiToGemini(
      { model: "claude-opus-4-6-thinking", reasoningEffort: "low", messages: [{ role: "user", content: "hello" }] },
      { projectId: "p" },
    );
    expect(opusLowCamel.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1024);

    // Explicit thinkingConfig object is recognized
    const opusExplicit = transformOpenAiToGemini(
      {
        model: "claude-opus-4-6-thinking",
        thinkingConfig: { thinkingBudget: 512 },
        messages: [{ role: "user", content: "hello" }],
      },
      { projectId: "p" },
    );
    expect(opusExplicit.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(512);

    // Adaptive tool follow-up step caps thinking budget to 1024 for Opus
    const opusToolFollowUp = transformOpenAiToGemini(
      {
        model: "claude-opus-4-6-thinking",
        messages: [
          { role: "user", content: "List dir" },
          { role: "assistant", content: "Checking" },
          { role: "tool", name: "list_dir", content: '{"files":[]}' },
        ],
      },
      { projectId: "p" },
    );
    expect(opusToolFollowUp.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1024);

    // Explicit effort overrides adaptive tool-turn capping
    const opusToolExplicitHigh = transformOpenAiToGemini(
      {
        model: "claude-opus-4-6-thinking",
        reasoningEffort: "high",
        messages: [
          { role: "user", content: "List dir" },
          { role: "assistant", content: "Checking" },
          { role: "tool", name: "list_dir", content: '{"files":[]}' },
        ],
      },
      { projectId: "p" },
    );
    expect(opusToolExplicitHigh.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(8192);

    // Disabled thinking via type: disabled
    const opusTypeDisabled = transformOpenAiToGemini(
      {
        model: "claude-opus-4-6-thinking",
        thinkingConfig: { type: "disabled" },
        messages: [{ role: "user", content: "hello" }],
      },
      { projectId: "p" },
    );
    expect(opusTypeDisabled.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);

    // reasoningEffort: off and disabled variants
    const opusOff = transformOpenAiToGemini(
      { model: "claude-opus-4-6-thinking", reasoningEffort: "off" },
      { projectId: "p" },
    );
    expect(opusOff.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);

    const opusDisabled = transformOpenAiToGemini(
      { model: "claude-opus-4-6-thinking", reasoning_effort: "disabled" },
      { projectId: "p" },
    );
    expect(opusDisabled.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);

    // Explicit snake_case thinking_budget
    const opusSnakeBudget = transformOpenAiToGemini(
      { model: "claude-opus-4-6-thinking", thinking_budget: 3500 },
      { projectId: "p" },
    );
    expect(opusSnakeBudget.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(3500);

    // Empty messages array handled safely
    const emptyMessages = transformOpenAiToGemini(
      { model: "claude-opus-4-6-thinking", messages: [] },
      { projectId: "p" },
    );
    expect(emptyMessages.request.contents).toEqual([]);
    expect(emptyMessages.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(2048);
  });
});


