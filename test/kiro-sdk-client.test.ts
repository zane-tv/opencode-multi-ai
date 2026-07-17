import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearSdkClientCache,
  createGenerateAssistantResponseRequest,
  createSdkClient,
} from "../lib/providers/kiro/request/sdk-client.js";
import type { KiroAuthDetails } from "../lib/providers/kiro/types.js";

const modulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../lib/providers/kiro/request/sdk-client.ts",
);

function auth(method: KiroAuthDetails["authMethod"]): KiroAuthDetails {
  return {
    refresh: method === "api-key" ? "ksk_test" : "rt-test",
    access: "access-token",
    expires: Date.now() + 60_000,
    authMethod: method,
    region: "us-east-1",
    email: "user@example.com",
    profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/x",
  };
}

afterEach(() => {
  clearSdkClientCache();
});

describe("Kiro SDK client", () => {
  it("loads AWS packages only via dynamic import", () => {
    const source = fs.readFileSync(modulePath, "utf8");
    expect(source).toContain('await Promise.all([');
    expect(source).toContain('import("@aws/codewhisperer-streaming-client")');
    expect(source).toContain('import("@smithy/node-http-handler")');
    expect(source).not.toMatch(
      /^import\s+.*from\s+["']@aws\/codewhisperer-streaming-client["']/m,
    );
    expect(source).not.toMatch(
      /^import\s+.*from\s+["']@smithy\/node-http-handler["']/m,
    );
  });

  it("keeps maxAttempts at 3 even when AWS_MAX_ATTEMPTS is set", async () => {
    const previous = process.env.AWS_MAX_ATTEMPTS;
    process.env.AWS_MAX_ATTEMPTS = "9";
    try {
      const client = (await createSdkClient(
        auth("idc"),
        "us-east-1",
        "medium",
        30_000,
        "claude-opus-4.8",
        20_000,
      )) as { config?: { maxAttempts?: number | (() => Promise<number>) } };
      const configured = client.config?.maxAttempts;
      const value =
        typeof configured === "function" ? await configured() : configured;
      expect(value).toBe(3);
    } finally {
      if (previous === undefined) delete process.env.AWS_MAX_ATTEMPTS;
      else process.env.AWS_MAX_ATTEMPTS = previous;
    }
  });

  it("builds a generate request and strips profileArn for api-key auth", async () => {
    const prepared = await createGenerateAssistantResponseRequest(
      auth("api-key"),
      "us-east-1",
      {
        conversationState: {
          chatTriggerType: "MANUAL",
          conversationId: "conv-1",
          currentMessage: {
            userInputMessage: {
              content: "hi",
              modelId: "claude-opus-4.8",
              origin: "AI_EDITOR",
            },
          },
        },
        profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/x",
      },
      30_000,
      "high",
      "claude-opus-4.8",
      24_000,
    );

    expect(prepared.runtime).toBe("codewhisperer");
    expect(prepared.client).toBeTruthy();
    expect(prepared.command).toBeTruthy();
    const input = (prepared.command as { input?: Record<string, unknown> }).input;
    expect(input?.profileArn).toBeUndefined();
  });
});
