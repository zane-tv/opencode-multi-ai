import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isProviderAdapter } from "../lib/core/adapter.js";
import { xaiAdapter } from "../lib/providers/xai/index.js";
import {
  CLI_CLIENT_VERSION,
  CLI_PROXY_BASE,
  CLI_PROXY_HOST,
  CLI_TOKEN_AUTH_VALUE,
  getXaiCliProxyMode,
  resetXaiCliProxyForTests,
  setXaiCliProxy,
} from "../lib/providers/xai/cli-proxy.js";
import { fetchLiveXaiModelIds } from "../lib/providers/xai/models-sync.js";
import { probeAccountRateLimit } from "../lib/providers/xai/request/rate-limit.js";

const originalFetch = globalThis.fetch;
let tempDirs: string[] = [];
let isolatedSettingsPath = "";

function transport() {
  if (xaiAdapter.transport.kind !== "http") {
    throw new Error("xAI must use the HTTP transport");
  }
  return xaiAdapter.transport;
}

async function tempSettingsPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "multi-ai-xai-cli-proxy-"));
  tempDirs.push(dir);
  return path.join(dir, "multi-ai-settings.json");
}

beforeEach(async () => {
  // Hermetic settings file — the real one may carry xaiCliProxy: true.
  isolatedSettingsPath = await tempSettingsPath();
  process.env.MULTI_AI_SETTINGS_PATH = isolatedSettingsPath;
  delete process.env.MULTI_AI_XAI_CLI_PROXY;
  resetXaiCliProxyForTests();
});

afterEach(async () => {
  delete process.env.MULTI_AI_XAI_CLI_PROXY;
  delete process.env.MULTI_AI_SETTINGS_PATH;
  globalThis.fetch = originalFetch;
  resetXaiCliProxyForTests();
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true })),
  );
  tempDirs = [];
});

describe("xai CLI-proxy mode", () => {
  it("defaults to off and flips via env", () => {
    expect(getXaiCliProxyMode()).toBe(false);
    process.env.MULTI_AI_XAI_CLI_PROXY = "1";
    resetXaiCliProxyForTests();
    expect(getXaiCliProxyMode()).toBe(true);
  });

  it("persists to multi-ai-settings.json and reads it back", async () => {
    const p = await tempSettingsPath();
    process.env.MULTI_AI_SETTINGS_PATH = p;

    setXaiCliProxy(true, true);
    resetXaiCliProxyForTests();
    expect(getXaiCliProxyMode()).toBe(true);

    const raw = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
    expect(raw.xaiCliProxy).toBe(true);

    setXaiCliProxy(false, true);
    resetXaiCliProxyForTests();
    expect(getXaiCliProxyMode()).toBe(false);
  });

  it("env wins over settings file", async () => {
    const p = await tempSettingsPath();
    process.env.MULTI_AI_SETTINGS_PATH = p;
    setXaiCliProxy(false, true);
    resetXaiCliProxyForTests();

    process.env.MULTI_AI_XAI_CLI_PROXY = "1";
    resetXaiCliProxyForTests();
    expect(getXaiCliProxyMode()).toBe(true);
  });
});

describe("xai adapter CLI-proxy routing", () => {
  it("keeps api.x.ai URLs untouched when mode is off", () => {
    const url = "https://api.x.ai/v1/responses";
    expect(transport().resolveUrl(url)).toBe(url);
  });

  it("rewrites api.x.ai to cli-chat-proxy when mode is on", () => {
    process.env.MULTI_AI_XAI_CLI_PROXY = "1";
    resetXaiCliProxyForTests();
    const url = "https://api.x.ai/v1/responses";
    expect(transport().resolveUrl(url)).toBe(
      `https://${CLI_PROXY_HOST}/v1/responses`,
    );
    // Same-host requests are passed through unchanged.
    const direct = `https://${CLI_PROXY_HOST}/v1/chat/completions`;
    expect(transport().resolveUrl(direct)).toBe(direct);
  });

  it("still rejects non-xAI hosts in CLI-proxy mode", () => {
    process.env.MULTI_AI_XAI_CLI_PROXY = "1";
    resetXaiCliProxyForTests();
    expect(() =>
      transport().resolveUrl("https://api.openai.com/v1/chat"),
    ).toThrow(/non-xAI host/);
  });

  it("sends grok CLI auth headers only to the CLI proxy host", () => {
    const apiHeaders = transport().buildHeaders({
      accessToken: "tok-abc",
      accountId: "a1",
      url: "https://api.x.ai/v1/responses",
      initHeaders: { Authorization: "Bearer dummy" },
    });
    expect(apiHeaders.get("Authorization")).toBe("Bearer tok-abc");
    expect(apiHeaders.get("x-xai-token-auth")).toBeNull();

    const proxyHeaders = transport().buildHeaders({
      accessToken: "tok-abc",
      accountId: "a1",
      url: `https://${CLI_PROXY_HOST}/v1/responses`,
      initHeaders: { Authorization: "Bearer dummy" },
    });
    expect(proxyHeaders.get("Authorization")).toBe("Bearer tok-abc");
    expect(proxyHeaders.get("x-xai-token-auth")).toBe(CLI_TOKEN_AUTH_VALUE);
    expect(proxyHeaders.get("x-grok-client-version")).toBe(CLI_CLIENT_VERSION);
    expect(proxyHeaders.get("origin")).toBe("https://grok.com");
    expect(proxyHeaders.get("referer")).toBe("https://grok.com/?_s=usage");
  });

  it("keeps the adapter contract and base URL surface", () => {
    expect(isProviderAdapter(xaiAdapter)).toBe(true);
    expect(xaiAdapter.baseURL).toBe("https://api.x.ai/v1");
    expect(CLI_PROXY_BASE).toBe(`https://${CLI_PROXY_HOST}/v1`);
  });
});

describe("xai CLI-proxy probes", () => {
  it("probes cli-chat-proxy with token-auth when mode is on", async () => {
    process.env.MULTI_AI_XAI_CLI_PROXY = "1";
    resetXaiCliProxyForTests();

    globalThis.fetch = vi.fn(
      async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        const url = String(input);
        expect(url).toBe(`${CLI_PROXY_BASE}/chat/completions`);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer tok");
        expect(headers.get("x-xai-token-auth")).toBe(CLI_TOKEN_AUTH_VALUE);
        expect(headers.get("x-grok-client-version")).toBe(CLI_CLIENT_VERSION);
        expect(headers.get("origin")).toBe("https://grok.com");
        return new Response("{}", {
          status: 200,
          headers: {
            "x-ratelimit-remaining-tokens": "1000",
            "x-ratelimit-limit-tokens": "2000",
          },
        });
      },
    ) as typeof fetch;

    const snap = await probeAccountRateLimit("tok");
    expect(snap.remainingTokens).toBe(1000);
  });

  it("probes api.x.ai without token-auth when mode is off", async () => {
    globalThis.fetch = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        expect(url).toBe("https://api.x.ai/v1/chat/completions");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-xai-token-auth")).toBeNull();
        return new Response("{}", { status: 200 });
      },
    ) as typeof fetch;

    await probeAccountRateLimit("tok");
  });

  it("fetches live model ids from cli-chat-proxy in CLI-proxy mode", async () => {
    process.env.MULTI_AI_XAI_CLI_PROXY = "1";
    resetXaiCliProxyForTests();

    globalThis.fetch = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        expect(url).toBe(`${CLI_PROXY_BASE}/models`);
        const headers = new Headers(init?.headers);
        expect(headers.get("x-xai-token-auth")).toBe(CLI_TOKEN_AUTH_VALUE);
        expect(headers.get("x-grok-client-version")).toBe(CLI_CLIENT_VERSION);
        return new Response(
          JSON.stringify({
            data: [{ id: "grok-4.6" }, { id: "grok-4.5" }],
          }),
          { status: 200 },
        );
      },
    ) as typeof fetch;

    const ids = await fetchLiveXaiModelIds("tok");
    expect(ids).toEqual(["grok-4.6", "grok-4.5"]);
  });
});
