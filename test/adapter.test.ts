import { describe, expect, it } from "vitest";
import {
  isProviderAdapter,
  type Classification,
  type ProviderAdapter,
} from "../lib/core/adapter.js";

const XAI_API_HOST = "api.x.ai";
const CODEX_API_HOST = "chatgpt.com";

/**
 * Minimal stubs that satisfy the TOTAL ProviderAdapter interface.
 * resolveUrl implements the divergent policies only enough for the contract test.
 */
function baseStub(
  partial: Pick<
    ProviderAdapter,
    | "id"
    | "provider"
    | "displayName"
    | "npmPackage"
    | "baseURL"
    | "dummyApiKey"
    | "resolveUrl"
  >,
): ProviderAdapter {
  return {
    ...partial,
    buildHeaders(ctx) {
      const h = new Headers(ctx.initHeaders);
      h.set("Authorization", `Bearer ${ctx.accessToken}`);
      return h;
    },
    transformBody(init) {
      return init;
    },
    classifyResponse(res): Classification {
      if (res.ok) return { kind: "ok" };
      return { kind: "unknown-client-error", status: res.status };
    },
    classifyThrownError(): Classification {
      return { kind: "network" };
    },
    async recordSuccess() {
      /* no-op stub */
    },
    async resolveModels() {
      return {};
    },
    providerDefaultOptions() {
      return {};
    },
    listSubtitle() {
      return "";
    },
    detailLines() {
      return [];
    },
  };
}

/** xAI: host-pin — throw if host is not api.x.ai. */
const xaiStub: ProviderAdapter = baseStub({
  id: "xai-multi",
  provider: "xai",
  displayName: "Grok Multi-Account",
  npmPackage: "@ai-sdk/xai",
  baseURL: "https://api.x.ai/v1",
  dummyApiKey: "xai-multi-dummy",
  resolveUrl(input: string | URL): string {
    const url = typeof input === "string" ? new URL(input) : new URL(input.href);
    if (url.host !== XAI_API_HOST) {
      throw new Error(
        `xai resolveUrl refusing non-xAI host "${url.host}" (expected ${XAI_API_HOST})`,
      );
    }
    return url.toString();
  },
});

/** Codex: rewrite host to chatgpt.com (never throw on foreign host). */
const codexStub: ProviderAdapter = baseStub({
  id: "codex-multi",
  provider: "codex",
  displayName: "Codex Multi-Account",
  npmPackage: "@ai-sdk/openai",
  baseURL: "https://chatgpt.com/backend-api",
  dummyApiKey: "codex-multi-dummy",
  resolveUrl(input: string | URL): string {
    const url = typeof input === "string" ? new URL(input) : new URL(input.href);
    url.protocol = "https:";
    url.username = "";
    url.password = "";
    url.host = CODEX_API_HOST;
    return url.toString();
  },
});

describe("ProviderAdapter interface", () => {
  it("accepts two stubs that satisfy the total interface", () => {
    // Compile-time: xaiStub/codexStub are typed as ProviderAdapter.
    // Runtime: guard confirms required surface is present.
    expect(isProviderAdapter(xaiStub)).toBe(true);
    expect(isProviderAdapter(codexStub)).toBe(true);
    expect(xaiStub.id).toBe("xai-multi");
    expect(xaiStub.provider).toBe("xai");
    expect(codexStub.id).toBe("codex-multi");
    expect(codexStub.provider).toBe("codex");
  });

  it("fails isProviderAdapter when resolveUrl is missing", () => {
    const incomplete: Partial<ProviderAdapter> = { ...xaiStub };
    delete incomplete.resolveUrl;
    expect(isProviderAdapter(incomplete)).toBe(false);
  });

  it("xai resolveUrl allows api.x.ai and throws on foreign host", () => {
    expect(xaiStub.resolveUrl("https://api.x.ai/v1/chat/completions")).toContain(
      "api.x.ai",
    );
    expect(() =>
      xaiStub.resolveUrl("https://api.openai.com/v1/chat/completions"),
    ).toThrow(/non-xAI host/);
  });

  it("codex resolveUrl rewrites foreign hosts to chatgpt.com", () => {
    const rewritten = codexStub.resolveUrl(
      "https://api.openai.com/v1/responses",
    );
    expect(rewritten).toContain("chatgpt.com");
    expect(rewritten).not.toContain("api.openai.com");
  });

  it("stubs share Classification kind shape", async () => {
    const okRes = new Response("{}", { status: 200 });
    const badRes = new Response("{}", { status: 400 });
    expect(await xaiStub.classifyResponse(okRes, "{}")).toEqual({ kind: "ok" });
    expect(await codexStub.classifyResponse(badRes, "{}")).toEqual({
      kind: "unknown-client-error",
      status: 400,
    });
    expect(xaiStub.classifyThrownError(new Error("boom"))).toEqual({
      kind: "network",
    });
  });
});
