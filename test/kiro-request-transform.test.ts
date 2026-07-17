import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildCodeWhispererRequest } from "../lib/providers/kiro/request/transform.js";

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/kiro/${name}`, import.meta.url), "utf8"),
  );
}

function normalizeRequest(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, child: unknown) =>
      child instanceof Uint8Array ? Array.from(child) : child,
    ),
  );
}

describe("Kiro CodeWhisperer request transform", () => {
  it("matches the basic golden request and omits an API-key profile", async () => {
    const request = buildCodeWhispererRequest({
      messages: [
        { role: "system", content: "System message" },
        { role: "user", content: "First" },
        { role: "assistant", content: "Second" },
        { role: "user", content: "Final" },
      ],
      system: "Global instructions",
      modelId: "claude-opus-4-8-thinking",
      thinking: true,
      thinkingBudget: 12_000,
      authMethod: "api-key",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/ignored",
      conversationId: "conversation-fixture",
    });

    expect(normalizeRequest(request)).toEqual(await loadFixture("request-basic.json"));
    expect(request).not.toHaveProperty("profileArn");
  });

  it("matches the tool-history golden request and includes an IDC profile", async () => {
    const request = buildCodeWhispererRequest({
      messages: [
        { role: "user", content: "Use a tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call.1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call.1", content: "contents" },
        { role: "user", content: "Continue" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
      modelId: "claude-opus-4.8",
      thinking: false,
      authMethod: "idc",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/demo",
      conversationId: "conversation-fixture",
    });

    expect(normalizeRequest(request)).toEqual(await loadFixture("request-tools.json"));
    expect(request.profileArn).toBe("arn:aws:codewhisperer:us-east-1:123:profile/demo");
  });

  it("matches the image golden request", async () => {
    const request = buildCodeWhispererRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
          ],
        },
      ],
      modelId: "claude-opus-4.8",
      thinking: false,
      authMethod: "api-key",
      conversationId: "conversation-fixture",
    });

    expect(normalizeRequest(request)).toEqual(await loadFixture("request-images.json"));
  });

  it("rejects an unsupported model without mutating messages", () => {
    const messages = [{ role: "user", content: "unchanged" }];
    const snapshot = structuredClone(messages);

    expect(() =>
      buildCodeWhispererRequest({
        messages,
        modelId: "unsupported-model",
        thinking: false,
        authMethod: "idc",
        conversationId: "conversation-fixture",
      }),
    ).toThrow(/Unsupported Kiro model/);
    expect(messages).toEqual(snapshot);
  });
});
