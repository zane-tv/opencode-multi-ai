import { describe, expect, it } from "vitest";

import {
  convertToolsToCodeWhisperer,
  normalizeKiroToolName,
  sanitizeKiroToolSchema,
} from "../lib/providers/kiro/transformers/tool-transformer.js";
import { parseBracketToolCalls } from "../lib/providers/kiro/transformers/tool-call-parser.js";

describe("Kiro tool protocol transforms", () => {
  it("normalizes invalid and duplicate tool names deterministically", () => {
    const used = new Set<string>();
    expect(normalizeKiroToolName("read file", used)).toMatch(/^read_file_[a-f0-9]{8}$/);
    expect(normalizeKiroToolName("read file", used)).not.toBe(
      normalizeKiroToolName("read file", used),
    );
  });

  it("removes Kiro-rejected schema keys without removing property names", () => {
    expect(
      sanitizeKiroToolSchema({
        type: "object",
        additionalProperties: false,
        properties: { format: { type: "string", pattern: "x" }, okay: { type: "number" } },
      }),
    ).toEqual({
      type: "object",
      properties: { format: { type: "string" }, okay: { type: "number" } },
    });
  });

  it("converts OpenCode tools and parses fallback bracket calls", () => {
    const tools = convertToolsToCodeWhisperer([
      { name: "read file", input_schema: { properties: { path: { type: "string" } } } },
    ]);
    expect(tools[0]?.toolSpecification.inputSchema.json).toMatchObject({ type: "object" });
    expect(
      parseBracketToolCalls('[TOOL_CALL] read_file {"path":"a.ts"} [/TOOL_CALL]'),
    ).toEqual([{ name: "read_file", input: { path: "a.ts" } }]);
  });
});
