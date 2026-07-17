export type StreamDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly thinking: string }
  | { readonly type: "input_json_delta"; readonly partial_json: string }
  | { readonly stop_reason: "tool_use" | "end_turn" | string };

export type StreamContentBlock =
  | { readonly type: "thinking"; readonly thinking: string }
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

export type StreamUsage = {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
};

export interface StreamEvent {
  readonly type: string;
  readonly message?: unknown;
  readonly content_block?: StreamContentBlock;
  readonly delta?: StreamDelta;
  readonly index?: number;
  readonly usage?: StreamUsage;
}

export interface StreamState {
  thinkingRequested: boolean;
  buffer: string;
  inThinking: boolean;
  thinkingExtracted: boolean;
  thinkingBlockIndex: number | null;
  textBlockIndex: number | null;
  nextBlockIndex: number;
  stoppedBlocks: Set<number>;
}

export interface ToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

export const THINKING_START_TAG = "<thinking>";
export const THINKING_END_TAG = "</thinking>";
