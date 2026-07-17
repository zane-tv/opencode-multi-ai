import type { StreamEvent } from "./types.js";

export type OpenAIChunkChoice = {
  readonly index: number;
  readonly delta:
    | { readonly content: string }
    | { readonly reasoning_content: string }
    | {
        readonly tool_calls: readonly {
          readonly index: number;
          readonly id?: string;
          readonly type?: "function";
          readonly function: { readonly name?: string; readonly arguments: string };
        }[];
      }
    | Record<string, never>;
  readonly finish_reason: "tool_calls" | "stop" | null;
};

export type OpenAIChatCompletionChunk = {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly OpenAIChunkChoice[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
};

export function convertToOpenAI(
  event: StreamEvent,
  id: string,
  model: string,
): OpenAIChatCompletionChunk | null {
  const choices: OpenAIChunkChoice[] = [];
  let usage: OpenAIChatCompletionChunk["usage"];

  if (event.type === "content_block_delta") {
    const delta = event.delta;
    if (!delta || !("type" in delta)) return null;
    if (delta.type === "text_delta" && delta.text) {
      choices.push({ index: 0, delta: { content: delta.text }, finish_reason: null });
    } else if (delta.type === "thinking_delta" && delta.thinking) {
      choices.push({
        index: 0,
        delta: { reasoning_content: delta.thinking },
        finish_reason: null,
      });
    } else if (delta.type === "input_json_delta") {
      choices.push({
        index: 0,
        delta: {
          tool_calls: [
            {
              index: event.index ?? 0,
              function: { arguments: delta.partial_json },
            },
          ],
        },
        finish_reason: null,
      });
    }
  } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    choices.push({
      index: 0,
      delta: {
        tool_calls: [
          {
            index: event.index ?? 0,
            id: event.content_block.id,
            type: "function",
            function: { name: event.content_block.name, arguments: "" },
          },
        ],
      },
      finish_reason: null,
    });
  } else if (event.type === "message_delta") {
    const stopReason = event.delta && "stop_reason" in event.delta
      ? event.delta.stop_reason
      : "end_turn";
    choices.push({
      index: 0,
      delta: {},
      finish_reason: stopReason === "tool_use" ? "tool_calls" : "stop",
    });
    const promptTokens = event.usage?.input_tokens ?? 0;
    const completionTokens = event.usage?.output_tokens ?? 0;
    usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  } else {
    return null;
  }

  if (choices.length === 0) return null;
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices,
    ...(usage ? { usage } : {}),
  };
}
