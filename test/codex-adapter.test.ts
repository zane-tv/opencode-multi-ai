import { describe, expect, it } from "vitest";

import { isProviderAdapter } from "../lib/core/adapter.js";
import { codexAdapter } from "../lib/providers/codex/adapter.js";
import {
  CLIENT_ID,
  CODEX_BASE_URL,
  DUMMY_API_KEY,
  OAUTH_EXTRA_PARAMS,
  PROVIDER_ID,
  REDIRECT_URI,
} from "../lib/providers/codex/constants.js";
import { CODEX_PROVIDER_DEFAULT_OPTIONS } from "../lib/providers/codex/models-sync.js";

describe("codexAdapter", () => {
  it("satisfies ProviderAdapter and wires codex identity", () => {
    expect(isProviderAdapter(codexAdapter)).toBe(true);
    expect(codexAdapter.id).toBe("codex-multi");
    expect(codexAdapter.provider).toBe("codex");
    expect(codexAdapter.displayName).toBe("Codex Multi-Account");
    expect(codexAdapter.npmPackage).toBe("@ai-sdk/openai");
    expect(codexAdapter.baseURL).toBe(CODEX_BASE_URL);
    expect(codexAdapter.dummyApiKey).toBe(DUMMY_API_KEY);
    expect(codexAdapter.hostAuth).toBeDefined();
  });

  it("resolveUrl rewrites to chatgpt.com (never throws on foreign host)", () => {
    const out = codexAdapter.resolveUrl(
      "https://api.openai.com/v1/responses",
    );
    expect(out).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("buildHeaders overwrites Authorization and drops x-api-key", () => {
    const h = codexAdapter.buildHeaders({
      accessToken: "live-token",
      accountId: "acct-1",
      initHeaders: {
        Authorization: "Bearer dummy",
        "x-api-key": "leak-me",
        "content-type": "application/json",
      },
    });
    expect(h.get("Authorization")).toBe("Bearer live-token");
    expect(h.has("x-api-key")).toBe(false);
    expect(h.get("chatgpt-account-id")).toBe("acct-1");
    expect(h.get("content-type")).toBe("application/json");
  });

  it("transformBody forces store:false + encrypted reasoning", () => {
    const next = codexAdapter.transformBody(
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5-codex", store: true }),
      },
      { url: "https://chatgpt.com/backend-api/codex/responses" },
    );
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.store).toBe(false);
    expect(body.include).toContain("reasoning.encrypted_content");
  });

  it("providerDefaultOptions match CODEX_PROVIDER_DEFAULT_OPTIONS", () => {
    expect(codexAdapter.providerDefaultOptions()).toMatchObject({
      store: false,
      reasoningEffort: CODEX_PROVIDER_DEFAULT_OPTIONS.reasoningEffort,
    });
  });

  it("keeps public OAuth constants exact", () => {
    expect(CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(REDIRECT_URI).toBe("http://localhost:1455/auth/callback");
    expect(PROVIDER_ID).toBe("codex-multi");
    expect(OAUTH_EXTRA_PARAMS).toEqual({
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    });
  });

  it("classifyResponse maps usage_limit and deactivated_workspace", async () => {
    const usage = await codexAdapter.classifyResponse(
      new Response("{}", { status: 429 }),
      JSON.stringify({
        error: {
          type: "usage_limit_reached",
          message: "You have reached your usage limit",
          resets_at: 1_712_345_678,
        },
      }),
    );
    expect(usage.kind).toBe("quota-exhausted");

    const dead = await codexAdapter.classifyResponse(
      new Response("{}", { status: 402 }),
      JSON.stringify({
        detail: { code: "deactivated_workspace", message: "gone" },
      }),
    );
    expect(dead.kind).toBe("auth-dead");
  });
});
