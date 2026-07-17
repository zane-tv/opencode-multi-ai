import { getContextWindowSize } from "../models.js";
import { estimateTokens } from "../request/token-estimation.js";
import { parseBracketToolCalls } from "../transformers/tool-call-parser.js";
import { normalizeKiroToolUseId } from "../transformers/tool-transformer.js";
import {
  convertToOpenAI,
  type OpenAIChatCompletionChunk,
} from "./openai-converter.js";
import { findRealTag } from "./stream-parser.js";
import {
  createTextDeltaEvents,
  createThinkingDeltaEvents,
  stopBlock,
} from "./stream-state.js";
import {
  THINKING_END_TAG,
  THINKING_START_TAG,
  type StreamEvent,
  type StreamState,
  type ToolCallState,
} from "./types.js";

export type SdkStreamEvent = {
  readonly assistantResponseEvent?: { readonly content?: string };
  readonly toolUseEvent?: {
    readonly name?: string;
    readonly toolUseId?: string;
    readonly input?: string;
    readonly stop?: boolean;
  };
  readonly metadataEvent?: { readonly contextUsagePercentage?: number };
  readonly contextUsageEvent?: { readonly contextUsagePercentage?: number };
};

export type SdkStreamResponse = {
  readonly generateAssistantResponseResponse?: AsyncIterable<SdkStreamEvent>;
};

function initialState(thinkingRequested: boolean): StreamState {
  return {
    thinkingRequested,
    buffer: "",
    inThinking: false,
    thinkingExtracted: false,
    thinkingBlockIndex: null,
    textBlockIndex: null,
    nextBlockIndex: 0,
    stoppedBlocks: new Set<number>(),
  };
}

function* convertedEvents(
  events: readonly StreamEvent[],
  conversationId: string,
  model: string,
): Generator<OpenAIChatCompletionChunk> {
  for (const event of events) {
    const chunk = convertToOpenAI(event, conversationId, model);
    if (chunk) yield chunk;
  }
}

function appendText(text: string, state: StreamState): StreamEvent[] {
  if (!state.thinkingRequested) return createTextDeltaEvents(text, state);
  state.buffer += text;
  const events: StreamEvent[] = [];
  while (state.buffer.length > 0) {
    if (!state.inThinking && !state.thinkingExtracted) {
      const start = findRealTag(state.buffer, THINKING_START_TAG);
      if (start !== -1) {
        events.push(...createTextDeltaEvents(state.buffer.slice(0, start), state));
        state.buffer = state.buffer.slice(start + THINKING_START_TAG.length);
        state.inThinking = true;
        continue;
      }
      const safeLength = Math.max(0, state.buffer.length - THINKING_START_TAG.length);
      if (safeLength > 0) {
        events.push(...createTextDeltaEvents(state.buffer.slice(0, safeLength), state));
        state.buffer = state.buffer.slice(safeLength);
      }
      break;
    }
    if (state.inThinking) {
      const end = findRealTag(state.buffer, THINKING_END_TAG);
      if (end !== -1) {
        events.push(...createThinkingDeltaEvents(state.buffer.slice(0, end), state));
        state.buffer = state.buffer.slice(end + THINKING_END_TAG.length);
        state.inThinking = false;
        state.thinkingExtracted = true;
        events.push(...stopBlock(state.thinkingBlockIndex, state));
        if (state.buffer.startsWith("\n\n")) state.buffer = state.buffer.slice(2);
        continue;
      }
      const safeLength = Math.max(0, state.buffer.length - THINKING_END_TAG.length);
      if (safeLength > 0) {
        events.push(...createThinkingDeltaEvents(state.buffer.slice(0, safeLength), state));
        state.buffer = state.buffer.slice(safeLength);
      }
      break;
    }
    events.push(...createTextDeltaEvents(state.buffer, state));
    state.buffer = "";
  }
  return events;
}

function flushText(state: StreamState): StreamEvent[] {
  const events: StreamEvent[] = [];
  if (state.buffer) {
    if (state.inThinking) {
      events.push(...createThinkingDeltaEvents(state.buffer, state));
      events.push(...stopBlock(state.thinkingBlockIndex, state));
    } else {
      events.push(...createTextDeltaEvents(state.buffer, state));
    }
    state.buffer = "";
  }
  events.push(...stopBlock(state.textBlockIndex, state));
  return events;
}

function appendToolEvent(
  event: NonNullable<SdkStreamEvent["toolUseEvent"]>,
  current: ToolCallState | null,
  completed: ToolCallState[],
): ToolCallState | null {
  if (!event.name || !event.toolUseId) return current;
  let next = current;
  if (next?.toolUseId === event.toolUseId) {
    next.input += event.input ?? "";
  } else {
    if (next) completed.push(next);
    next = {
      toolUseId: event.toolUseId,
      name: event.name,
      input: event.input ?? "",
    };
  }
  if (event.stop) {
    completed.push(next);
    return null;
  }
  return next;
}

function stringifyToolInput(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input);
    return JSON.stringify(parsed);
  } catch {
    return input;
  }
}

function toolStreamEvents(
  toolCalls: readonly ToolCallState[],
  startIndex: number,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  toolCalls.forEach((toolCall, offset) => {
    const index = startIndex + offset;
    events.push({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: toolCall.toolUseId,
        name: toolCall.name,
        input: {},
      },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: stringifyToolInput(toolCall.input) },
    });
    events.push({ type: "content_block_stop", index });
  });
  return events;
}

export async function* transformSdkStream(
  sdkResponse: SdkStreamResponse,
  model: string,
  conversationId: string,
  thinkingRequested = false,
): AsyncGenerator<OpenAIChatCompletionChunk> {
  const eventStream = sdkResponse.generateAssistantResponseResponse;
  if (!eventStream) throw new Error("SDK response has no event stream");
  const state = initialState(thinkingRequested);
  const toolCalls: ToolCallState[] = [];
  let currentToolCall: ToolCallState | null = null;
  let totalContent = "";
  let textOnlyContent = "";
  let contextUsagePercentage: number | null = null;

  for await (const event of eventStream) {
    const content = event.assistantResponseEvent?.content;
    if (content) {
      totalContent += content;
      textOnlyContent += content;
      yield* convertedEvents(appendText(content, state), conversationId, model);
      continue;
    }
    if (event.toolUseEvent) {
      totalContent += `${event.toolUseEvent.name ?? ""}${event.toolUseEvent.input ?? ""}`;
      currentToolCall = appendToolEvent(event.toolUseEvent, currentToolCall, toolCalls);
      continue;
    }
    const usage = event.metadataEvent?.contextUsagePercentage
      ?? event.contextUsageEvent?.contextUsagePercentage;
    if (usage) contextUsagePercentage = usage;
  }

  if (currentToolCall) toolCalls.push(currentToolCall);
  yield* convertedEvents(flushText(state), conversationId, model);
  parseBracketToolCalls(totalContent).forEach((call, index) => {
    toolCalls.push({
      toolUseId: normalizeKiroToolUseId(`${call.name}_${index + 1}`),
      name: call.name,
      input: JSON.stringify(call.input),
    });
  });
  yield* convertedEvents(
    toolStreamEvents(toolCalls, state.nextBlockIndex),
    conversationId,
    model,
  );

  const outputTokens = estimateTokens(textOnlyContent);
  const totalTokens = contextUsagePercentage
    ? Math.round((getContextWindowSize(model) * contextUsagePercentage) / 100)
    : outputTokens;
  const inputTokens = Math.max(0, totalTokens - outputTokens);
  yield* convertedEvents(
    [
      {
        type: "message_delta",
        delta: { stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn" },
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      { type: "message_stop" },
    ],
    conversationId,
    model,
  );
}
