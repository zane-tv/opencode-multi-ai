import { describe, expect, it } from "vitest";
import {
  convertGeminiStreamToOpenAi,
  parseGeminiSseLine,
  type OpenAiChatCompletionChunk,
} from "../lib/providers/antigravity/streaming/sse-converter.js";

function createReadableStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
}

describe("Antigravity SSE Stream Converter", () => {
  it("parses data lines correctly", () => {
    expect(parseGeminiSseLine("")).toBeNull();
    expect(parseGeminiSseLine(": keep-alive")).toBeNull();
    expect(parseGeminiSseLine("data: [DONE]")).toBeNull();

    const line = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]},"index":0}]}}';
    const parsed = parseGeminiSseLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.response?.candidates?.[0]?.content?.parts?.[0]?.text).toBe("hello");
  });

  it("converts text parts to OpenAI content chunks", async () => {
    const rawEvents = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}}',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"world!"}]}}]}}',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}}',
    ];

    const stream = createReadableStream(rawEvents);
    const generator = convertGeminiStreamToOpenAi(stream, "gemini-3.8-flash");

    const chunks: OpenAiChatCompletionChunk[] = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.content).toBe("Hello ");
    expect(chunks[0].choices[0].finish_reason).toBeNull();

    expect(chunks[1].choices[0].delta.content).toBe("world!");
    expect(chunks[1].choices[0].finish_reason).toBeNull();

    expect(chunks[2].choices[0].finish_reason).toBe("stop");
    expect(chunks[2].usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("converts thought parts to reasoning_content chunks", async () => {
    const rawEvents = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking about solution..."}]}}]}}',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Here is the code."}]}}]}}',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}',
    ];

    const stream = createReadableStream(rawEvents);
    const generator = convertGeminiStreamToOpenAi(stream, "gemini-3.8-flash");

    const chunks: OpenAiChatCompletionChunk[] = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.reasoning_content).toBe("Thinking about solution...");
    expect(chunks[1].choices[0].delta.content).toBe("Here is the code.");
    expect(chunks[2].choices[0].finish_reason).toBe("stop");
  });

  it("converts functionCall parts to tool_calls chunks", async () => {
    const rawEvents = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"write_to_file","args":{"TargetFile":"main.dart","CodeContent":"void main() {}"}}}]}}]}}',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}',
    ];

    const stream = createReadableStream(rawEvents);
    const generator = convertGeminiStreamToOpenAi(stream, "gemini-3.8-flash");

    const chunks: OpenAiChatCompletionChunk[] = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    const toolCall = chunks[0].choices[0].delta.tool_calls?.[0];
    expect(toolCall).toBeDefined();
    expect(toolCall?.function.name).toBe("write_to_file");
    expect(JSON.parse(toolCall?.function.arguments || "{}")).toEqual({
      TargetFile: "main.dart",
      CodeContent: "void main() {}",
    });
    // finish_reason should reflect tool_calls
    expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
  });

  it("throws on in-stream error from Google SSE", async () => {
    const rawEvents = [
      'data: {"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}',
    ];

    const stream = createReadableStream(rawEvents);
    const generator = convertGeminiStreamToOpenAi(stream, "gemini-3.8-flash");

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of generator) {
        // should throw
      }
    }).rejects.toThrow("Antigravity in-stream error 429: Resource has been exhausted");
  });

  it("processes buffer tail when stream ends without trailing newline", async () => {
    // Create a stream where the last chunk has no newline
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Tail chunk"}]},"finishReason":"STOP"}]}}',
          ),
        );
        controller.close();
      },
    });

    const generator = convertGeminiStreamToOpenAi(stream, "gemini-3.8-flash");
    const chunks: OpenAiChatCompletionChunk[] = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].choices[0].delta.content).toBe("Tail chunk");
  });

  it("handles multi-tool calling in a single turn", async () => {
    const rawEvents = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"tool_a","args":{"x":1}}},{"functionCall":{"name":"tool_b","args":{"y":2}}}]},"finishReason":"STOP"}]}}',
    ];

    const stream = createReadableStream(rawEvents);
    const generator = convertGeminiStreamToOpenAi(stream, "gemini-3.8-flash");
    const chunks: OpenAiChatCompletionChunk[] = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // Should yield tool_a, tool_b, then finish chunk with tool_calls
    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.tool_calls?.[0]?.function.name).toBe("tool_a");
    expect(chunks[1].choices[0].delta.tool_calls?.[0]?.function.name).toBe("tool_b");
    expect(chunks[2].choices[0].finish_reason).toBe("tool_calls");
  });

  it("informs user when response is blocked by safety policy with zero text", async () => {
    const rawEvents = [
      'data: {"response":{"candidates":[{"finishReason":"SAFETY"}]}}',
    ];

    const stream = createReadableStream(rawEvents);
    const generator = convertGeminiStreamToOpenAi(stream, "gemini-3.8-flash");
    const chunks: OpenAiChatCompletionChunk[] = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe("[Response blocked by safety policy]");
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
  });
});

