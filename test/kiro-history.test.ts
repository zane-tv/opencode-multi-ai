import { describe, expect, it } from "vitest";

import {
  findOriginalToolCall,
  getContentText,
  mergeAdjacentMessages,
  repairToolPairs,
  sanitizeHistory,
} from "../lib/providers/kiro/transformers/message-transformer.js";

describe("Kiro message transforms", () => {
  it("merges adjacent OpenCode messages without losing tool calls", () => {
    const messages = mergeAdjacentMessages([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "assistant", content: "call", tool_calls: [{ id: "tool-1", name: "read" }] },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("first\nsecond");
    expect(findOriginalToolCall(messages, "tool-1")).toMatchObject({ name: "read" });
  });

  it("extracts text from strings and structured content", () => {
    expect(getContentText("plain")).toBe("plain");
    expect(getContentText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("ab");
  });

  it("repairs assistant tool_use without following tool_result", () => {
    const repaired = repairToolPairs([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "bash" }],
      },
      { role: "user", content: "continue" },
    ]);
    expect(repaired).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "bash" }],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: "Tool was interrupted or result missing.",
      },
      { role: "user", content: "continue" },
    ]);
  });

  it("sanitizes mid-history unpaired toolUses but keeps trailing ones", () => {
    const history = sanitizeHistory([
      {
        userInputMessage: {
          content: "hi",
          modelId: "claude-sonnet-5",
          origin: "AI_EDITOR",
        },
      },
      {
        assistantResponseMessage: {
          content: "calling",
          toolUses: [{ name: "bash", toolUseId: "t1", input: {} }],
        },
      },
      {
        userInputMessage: {
          content: "more",
          modelId: "claude-sonnet-5",
          origin: "AI_EDITOR",
        },
      },
      {
        assistantResponseMessage: {
          content: "calling again",
          toolUses: [{ name: "bash", toolUseId: "t2", input: {} }],
        },
      },
    ]);
    expect(history).toHaveLength(4);
    expect(history[1]?.assistantResponseMessage?.toolUses).toBeUndefined();
    expect(history[1]?.assistantResponseMessage?.content).toBe("calling");
    expect(history[2]?.userInputMessage?.content).toBe("more");
    expect(history[3]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId).toBe(
      "t2",
    );
  });
});
