import { describe, expect, it } from "vitest";

import { rewriteUrlForCodex } from "../lib/providers/codex/request/codex-url.js";
import { createCodexHeaders } from "../lib/providers/codex/request/codex-headers.js";
import {
  CODEX_INCLUDE_ENCRYPTED_REASONING,
  forceEffortInBody,
  isUltraEffortRejected,
  normalizeCodexEffort,
  normalizeCodexModel,
  transformCodexBody,
  transformCodexRequestInit,
} from "../lib/providers/codex/request/body-transform.js";
import { DEFAULT_MODELS } from "../lib/providers/codex/constants.js";

describe("rewriteUrlForCodex", () => {
  it("rewrites api.openai.com /v1/responses to chatgpt backend codex path", () => {
    expect(rewriteUrlForCodex("https://api.openai.com/v1/responses")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });

  it("forces https and chatgpt.com host", () => {
    expect(rewriteUrlForCodex("http://example.com/v1/responses")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });

  it("strips userinfo credentials from the URL", () => {
    const out = rewriteUrlForCodex(
      "https://user:secret@api.openai.com/v1/responses",
    );
    expect(out).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(out).not.toContain("user");
    expect(out).not.toContain("secret");
  });

  it("is idempotent for already-rewritten codex URLs", () => {
    const once = rewriteUrlForCodex(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const twice = rewriteUrlForCodex(once);
    expect(once).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(twice).toBe(once);
  });

  it("preserves query string", () => {
    expect(
      rewriteUrlForCodex("https://api.openai.com/v1/responses?foo=bar"),
    ).toBe("https://chatgpt.com/backend-api/codex/responses?foo=bar");
  });

  it("accepts a URL object", () => {
    expect(
      rewriteUrlForCodex(new URL("https://api.openai.com/v1/responses")),
    ).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("rewrites bare /responses without /v1", () => {
    expect(rewriteUrlForCodex("https://api.openai.com/responses")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });

  it("strips nested /v1 when baseURL is already chatgpt backend-api", () => {
    expect(
      rewriteUrlForCodex(
        "https://chatgpt.com/backend-api/v1/responses",
      ),
    ).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(
      rewriteUrlForCodex(
        "https://chatgpt.com/backend-api/v1/codex/responses",
      ),
    ).toBe("https://chatgpt.com/backend-api/codex/responses");
  });
});

describe("createCodexHeaders", () => {
  it("sets required Codex headers with exact strings", () => {
    const h = createCodexHeaders({
      accessToken: "tok-abc",
      accountId: "acct-1",
    });
    expect(h.get("Authorization")).toBe("Bearer tok-abc");
    expect(h.get("chatgpt-account-id")).toBe("acct-1");
    expect(h.get("OpenAI-Beta")).toBe("responses=experimental");
    expect(h.get("originator")).toBe("codex_cli_rs");
    expect(h.get("accept")).toBe("text/event-stream");
  });

  it("sets conversation_id and session_id from promptCacheKey", () => {
    const h = createCodexHeaders({
      accessToken: "t",
      accountId: "a",
      promptCacheKey: "cache-key-9",
    });
    expect(h.get("conversation_id")).toBe("cache-key-9");
    expect(h.get("session_id")).toBe("cache-key-9");
  });

  it("omits conversation_id/session_id when promptCacheKey is absent", () => {
    const h = createCodexHeaders({ accessToken: "t", accountId: "a" });
    expect(h.has("conversation_id")).toBe(false);
    expect(h.has("session_id")).toBe(false);
  });

  it("sets openai-organization when organizationId is provided", () => {
    const h = createCodexHeaders({
      accessToken: "t",
      accountId: "a",
      organizationId: "org-xyz",
    });
    expect(h.get("openai-organization")).toBe("org-xyz");
  });

  it("deletes x-api-key", () => {
    const h = createCodexHeaders({ accessToken: "t", accountId: "a" });
    expect(h.has("x-api-key")).toBe(false);
  });
});

describe("transformCodexBody", () => {
  it("forces store false and includes reasoning.encrypted_content", () => {
    const out = transformCodexBody({
      model: "gpt-5-codex",
      store: true,
      input: [],
    });
    expect(out.store).toBe(false);
    expect(out.include).toEqual(
      expect.arrayContaining([CODEX_INCLUDE_ENCRYPTED_REASONING]),
    );
  });

  it("does not duplicate encrypted reasoning include", () => {
    const out = transformCodexBody({
      include: [CODEX_INCLUDE_ENCRYPTED_REASONING, "file_search_call.results"],
    });
    const include = out.include as string[];
    expect(
      include.filter((x) => x === CODEX_INCLUDE_ENCRYPTED_REASONING),
    ).toHaveLength(1);
    expect(include).toContain("file_search_call.results");
  });

  it("maps reasoning effort/summary and text verbosity from options", () => {
    const out = transformCodexBody(
      { model: "gpt-5-codex" },
      {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        textVerbosity: "medium",
      },
    );
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.text).toEqual({ verbosity: "medium" });
  });

  it("keeps max on 5.6; maps ultra→max; clamps max→xhigh on 5.5", () => {
    expect(normalizeCodexEffort("max", "gpt-5.6-sol")).toBe("max");
    expect(normalizeCodexEffort("ultra", "gpt-5.6-sol")).toBe("max");
    expect(normalizeCodexEffort("max", "gpt-5.5")).toBe("xhigh");
    expect(normalizeCodexEffort("ultra", "gpt-5.5")).toBe("xhigh");
    expect(
      transformCodexBody(
        { model: "gpt-5.6-sol" },
        { reasoningEffort: "ultra" },
      ).reasoning,
    ).toEqual({ effort: "max" });
    expect(
      transformCodexBody(
        { model: "gpt-5.6-sol", reasoning: { effort: "max" } },
      ).reasoning,
    ).toEqual({ effort: "max" });
    expect(
      transformCodexBody(
        { model: "gpt-5.5" },
        { reasoningEffort: "max" },
      ).reasoning,
    ).toEqual({ effort: "xhigh" });
  });

  it("detects ultra effort rejection and rewrites body to max", () => {
    expect(
      isUltraEffortRejected(
        400,
        JSON.stringify({
          error: {
            message:
              "Invalid value: 'ultra'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', and 'xhigh'.",
          },
        }),
      ),
    ).toBe(true);
    expect(isUltraEffortRejected(400, "Unsupported parameter: agents")).toBe(
      false,
    );
    const body = JSON.stringify({
      model: "gpt-5.6-sol",
      reasoning: { effort: "ultra", summary: "auto" },
    });
    const next = forceEffortInBody(body, "max");
    expect(next).not.toBeNull();
    expect(JSON.parse(next!).reasoning.effort).toBe("max");
    const body55 = JSON.stringify({
      model: "gpt-5.5",
      reasoning: { effort: "ultra" },
    });
    expect(JSON.parse(forceEffortInBody(body55, "max")!).reasoning.effort).toBe(
      "xhigh",
    );
  });

  it("DEFAULT_MODELS: 5.6 family has max; never ultra", () => {
    for (const [id, meta] of Object.entries(DEFAULT_MODELS)) {
      const variants = meta.variants ?? {};
      for (const [vk, vv] of Object.entries(variants)) {
        expect(vk).not.toBe("ultra");
        if (vv && typeof vv === "object" && "reasoningEffort" in vv) {
          const effort = (vv as { reasoningEffort: string }).reasoningEffort;
          expect(effort).not.toBe("ultra");
          const is56 = id.startsWith("gpt-5.6-");
          const allowed = [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            ...(is56 ? (["max"] as const) : []),
          ];
          expect(allowed).toContain(effort);
        }
      }
    }
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const) {
      expect(DEFAULT_MODELS[id]?.variants).toMatchObject({
        max: { reasoningEffort: "max" },
        xhigh: { reasoningEffort: "xhigh" },
      });
    }
  });

  it("removes Platform/AI-SDK fields rejected by ChatGPT Codex", () => {
    const out = transformCodexBody({
      model: "gpt-5-codex",
      max_completion_tokens: 1024,
      max_output_tokens: 512,
      max_tokens: 256,
      temperature: 0.2,
    });
    expect(out).not.toHaveProperty("max_completion_tokens");
    expect(out).not.toHaveProperty("max_output_tokens");
    expect(out).not.toHaveProperty("max_tokens");
    expect(out).not.toHaveProperty("temperature");
  });

  it("strips provider prefix from model", () => {
    const out = transformCodexBody({ model: "codex-multi/gpt-5-codex" });
    expect(out.model).toBe("gpt-5-codex");
  });

  it("normalizeCodexModel strips provider prefix", () => {
    expect(normalizeCodexModel("codex-multi/gpt-5.1-codex")).toBe(
      "gpt-5.1-codex",
    );
    expect(normalizeCodexModel("gpt-5-codex")).toBe("gpt-5-codex");
  });
});

describe("transformCodexRequestInit", () => {
  it("rewrites a JSON body string", () => {
    const init = {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", store: true }),
    };
    const next = transformCodexRequestInit(init, {
      reasoningEffort: "medium",
    });
    expect(next).toBeTruthy();
    const body = JSON.parse((next as RequestInit).body as string);
    expect(body.store).toBe(false);
    expect(body.include).toContain(CODEX_INCLUDE_ENCRYPTED_REASONING);
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  it("leaves non-json bodies untouched", () => {
    const init = { body: "not-json" };
    expect(transformCodexRequestInit(init)).toBe(init);
  });
});
