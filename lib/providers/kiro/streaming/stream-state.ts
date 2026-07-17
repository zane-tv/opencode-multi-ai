import type { StreamEvent, StreamState } from "./types.js";

export function ensureBlockStart(
  blockType: "thinking" | "text",
  streamState: StreamState,
): StreamEvent[] {
  if (blockType === "thinking") {
    if (streamState.thinkingBlockIndex !== null) return [];
    const index = streamState.nextBlockIndex++;
    streamState.thinkingBlockIndex = index;
    return [
      {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      },
    ];
  }
  if (streamState.textBlockIndex !== null) return [];
  const index = streamState.nextBlockIndex++;
  streamState.textBlockIndex = index;
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
  ];
}

export function stopBlock(index: number | null, streamState: StreamState): StreamEvent[] {
  if (index === null || streamState.stoppedBlocks.has(index)) return [];
  streamState.stoppedBlocks.add(index);
  return [{ type: "content_block_stop", index }];
}

export function createTextDeltaEvents(
  text: string,
  streamState: StreamState,
): StreamEvent[] {
  if (!text) return [];
  const events = ensureBlockStart("text", streamState);
  const index = streamState.textBlockIndex;
  if (index === null) return events;
  events.push({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
  return events;
}

export function createThinkingDeltaEvents(
  thinking: string,
  streamState: StreamState,
): StreamEvent[] {
  const events = ensureBlockStart("thinking", streamState);
  const index = streamState.thinkingBlockIndex;
  if (index === null) return events;
  events.push({
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  });
  return events;
}
