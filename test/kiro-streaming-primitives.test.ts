import { describe, expect, it } from "vitest";

import { estimateTokens } from "../lib/providers/kiro/request/token-estimation.js";
import { convertToOpenAI } from "../lib/providers/kiro/streaming/openai-converter.js";
import { findRealTag } from "../lib/providers/kiro/streaming/stream-parser.js";
import {
  createTextDeltaEvents,
  createThinkingDeltaEvents,
  stopBlock,
} from "../lib/providers/kiro/streaming/stream-state.js";
import {
  THINKING_END_TAG,
  THINKING_START_TAG,
  type StreamEvent,
  type StreamState,
} from "../lib/providers/kiro/streaming/types.js";

function streamState(): StreamState {
  return {
    thinkingRequested: true,
    buffer: "",
    inThinking: false,
    thinkingExtracted: false,
    thinkingBlockIndex: null,
    textBlockIndex: null,
    nextBlockIndex: 0,
    stoppedBlocks: new Set<number>(),
  };
}

describe("Kiro streaming primitives", () => {
  it("converts a text delta to an OpenAI content chunk", () => {
    const chunk = convertToOpenAI(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      "conversation-1",
      "claude-opus-4.8",
    );

    expect(chunk).toMatchObject({
      id: "conversation-1",
      object: "chat.completion.chunk",
      model: "claude-opus-4.8",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    });
  });

  it("converts a thinking delta to OpenAI reasoning content", () => {
    const chunk = convertToOpenAI(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "plan" },
      },
      "conversation-1",
      "claude-opus-4.8",
    );

    expect(chunk?.choices[0]?.delta).toEqual({ reasoning_content: "plan" });
  });

  it("does not emit chunks for empty text or thinking deltas", () => {
    const events: StreamEvent[] = [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "" },
      },
    ];

    expect(events.map((event) => convertToOpenAI(event, "conversation-1", "model"))).toEqual([
      null,
      null,
    ]);
  });

  it("ignores Anthropic-only stop events", () => {
    expect(
      convertToOpenAI({ type: "content_block_stop", index: 0 }, "conversation-1", "model"),
    ).toBeNull();
    expect(convertToOpenAI({ type: "message_stop" }, "conversation-1", "model")).toBeNull();
  });

  it("orders thinking before text when tags arrive across buffer splits", () => {
    const state = streamState();
    const events: StreamEvent[] = [];

    for (const part of ["<thin", "king>plan", "</thinking>answer"]) {
      state.buffer += part;
    }
    const start = findRealTag(state.buffer, THINKING_START_TAG);
    const afterStart = state.buffer.slice(start + THINKING_START_TAG.length);
    const end = findRealTag(afterStart, THINKING_END_TAG);
    events.push(...createThinkingDeltaEvents(afterStart.slice(0, end), state));
    events.push(...stopBlock(state.thinkingBlockIndex, state));
    events.push(...createTextDeltaEvents(afterStart.slice(end + THINKING_END_TAG.length), state));

    expect(events.map((event) => event.type)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
    ]);
    expect(events[1]?.delta).toEqual({ type: "thinking_delta", thinking: "plan" });
    expect(events[4]?.delta).toEqual({ type: "text_delta", text: "answer" });
  });

  it("estimates zero tokens for empty text and grows with input length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a longer response")).toBeGreaterThan(estimateTokens("short"));
  });
});
