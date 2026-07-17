import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenAIChatCompletionChunk } from "../lib/providers/kiro/streaming/openai-converter.js";
import {
  transformSdkStream,
  type SdkStreamEvent,
  type SdkStreamResponse,
} from "../lib/providers/kiro/streaming/sdk-stream-transformer.js";
import { createSseResponse } from "../lib/providers/kiro/streaming/sse-response.js";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/kiro/${name}`, import.meta.url), "utf8");
}

function sdkResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event;
    })(),
  };
}

async function collect(
  chunks: AsyncIterable<OpenAIChatCompletionChunk>,
): Promise<OpenAIChatCompletionChunk[]> {
  const values: OpenAIChatCompletionChunk[] = [];
  for await (const chunk of chunks) values.push(chunk);
  return values;
}

function reader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  const value = response.body?.getReader();
  if (!value) throw new Error("Response has no body");
  return value;
}

const TEST_CHUNK: OpenAIChatCompletionChunk = {
  id: "conversation-1",
  object: "chat.completion.chunk",
  created: 1_700_000_000,
  model: "claude-opus-4.8",
  choices: [{ index: 0, delta: { content: "ready" }, finish_reason: null }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Kiro SDK stream SSE", () => {
  it("matches the text SSE fixture and emits one DONE frame", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const chunks = transformSdkStream(
      sdkResponse([
        { assistantResponseEvent: { content: "Hello" } },
        { metadataEvent: { contextUsagePercentage: 10 } },
      ]),
      "claude-opus-4.8",
      "conversation-1",
      false,
    );
    const response = createSseResponse(chunks);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(await fixture("stream-text.sse"));
  });

  it("matches the tool SSE fixture", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const chunks = transformSdkStream(
      sdkResponse([
        {
          toolUseEvent: {
            name: "read_file",
            toolUseId: "tool-1",
            input: '{"path":',
          },
        },
        {
          toolUseEvent: {
            name: "read_file",
            toolUseId: "tool-1",
            input: '"a.ts"}',
            stop: true,
          },
        },
      ]),
      "claude-opus-4.8",
      "conversation-1",
      false,
    );

    expect(await createSseResponse(chunks).text()).toBe(await fixture("stream-tool.sse"));
  });

  it("synthesizes deterministic ids for bracket tool calls", async () => {
    const events: SdkStreamEvent[] = [
      {
        assistantResponseEvent: {
          content: '[TOOL_CALL] read_file {"path":"a.ts"} [/TOOL_CALL]',
        },
      },
    ];

    const first = await collect(
      transformSdkStream(sdkResponse(events), "claude-opus-4.8", "conversation-1", false),
    );
    const second = await collect(
      transformSdkStream(sdkResponse(events), "claude-opus-4.8", "conversation-1", false),
    );

    expect(JSON.stringify(first)).toContain('"id":"read_file_1"');
    expect(JSON.stringify(second)).toContain('"id":"read_file_1"');
  });

  it("propagates iterator errors to the response consumer", async () => {
    async function* failing(): AsyncGenerator<OpenAIChatCompletionChunk> {
      throw new Error("iterator failed");
    }

    await expect(createSseResponse(failing()).text()).rejects.toThrow("iterator failed");
  });

  it("finalizes exactly once when the response is cancelled twice", async () => {
    async function* stalled(): AsyncGenerator<OpenAIChatCompletionChunk> {
      yield TEST_CHUNK;
      await new Promise<void>(() => undefined);
    }
    const onClose = vi.fn();
    const streamReader = reader(createSseResponse(stalled(), { onClose }));
    await streamReader.read();

    await streamReader.cancel();
    await streamReader.cancel();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("finalizes exactly once when abort and cancel both occur", async () => {
    async function* stalled(): AsyncGenerator<OpenAIChatCompletionChunk> {
      yield TEST_CHUNK;
      await new Promise<void>(() => undefined);
    }
    const controller = new AbortController();
    const onClose = vi.fn();
    const streamReader = reader(
      createSseResponse(stalled(), { onClose, signal: controller.signal }),
    );
    await streamReader.read();

    controller.abort();
    await streamReader.cancel();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
