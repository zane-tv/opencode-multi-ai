import { afterEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_MODELS } from "../lib/providers/codex/constants.js";
import {
  buildEffortVariants,
  CODEX_PROVIDER_DEFAULT_OPTIONS,
  fetchModelsDevOpenAi,
  resolveCodexMultiModels,
} from "../lib/providers/codex/models-sync.js";

const originalFetch = globalThis.fetch;
let tempDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function tempCachePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "multi-ai-models-codex-"));
  tempDirs.push(dir);
  return path.join(dir, "multi-ai-models-codex.json");
}

describe("DEFAULT_MODELS seed (constants)", () => {
  it("includes gpt-5-codex, gpt-5.1-codex, gpt-5.5", () => {
    expect(DEFAULT_MODELS["gpt-5-codex"]).toBeTruthy();
    expect(DEFAULT_MODELS["gpt-5.1-codex"]).toBeTruthy();
    expect(DEFAULT_MODELS["gpt-5.5"]).toBeTruthy();
    expect(DEFAULT_MODELS["gpt-5-codex"].name).toBe("GPT-5 Codex");
    expect(DEFAULT_MODELS["gpt-5.1-codex"].reasoning).toBe(true);
    expect(DEFAULT_MODELS["gpt-5.5"].limit?.context).toBe(1_050_000);
  });
});

describe("CODEX_PROVIDER_DEFAULT_OPTIONS", () => {
  it("matches Codex Responses native defaults", () => {
    expect(CODEX_PROVIDER_DEFAULT_OPTIONS.store).toBe(false);
    expect(CODEX_PROVIDER_DEFAULT_OPTIONS.include).toContain(
      "reasoning.encrypted_content",
    );
    expect(CODEX_PROVIDER_DEFAULT_OPTIONS.reasoningEffort).toBe("medium");
    expect(CODEX_PROVIDER_DEFAULT_OPTIONS.reasoningSummary).toBe("auto");
    expect(CODEX_PROVIDER_DEFAULT_OPTIONS.textVerbosity).toBe("medium");
  });
});

describe("fetchModelsDevOpenAi", () => {
  it("maps models.dev openai catalog and skips image/video", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5.5": {
                name: "GPT-5.5",
                limit: { context: 1050000, output: 128000 },
              },
              "dall-e-3": { name: "DALL·E 3" },
              "gpt-5-codex": {
                name: "GPT-5 Codex",
                limit: { context: 400000, output: 128000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const models = await fetchModelsDevOpenAi();
    expect(Object.keys(models).sort()).toEqual(["gpt-5-codex", "gpt-5.5"]);
    expect(models["gpt-5.5"].limit?.context).toBe(1050000);
    expect(models["dall-e-3"]).toBeUndefined();
  });

  it("preserves reasoning and other supported metadata fields from models.dev", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5.5": {
                name: "GPT-5.5",
                family: "gpt",
                attachment: true,
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["low", "medium", "high", "xhigh"] },
                ],
                tool_call: true,
                temperature: true,
                release_date: "2026-07-08",
                limit: { context: 1050000, output: 128000 },
                modalities: { input: ["text", "image"], output: ["text"] },
                cost: { input: 2, output: 6, cache_read: 0.5 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const models = await fetchModelsDevOpenAi();
    const m = models["gpt-5.5"];
    expect(m.reasoning).toBe(true);
    expect(m.family).toBe("gpt");
    expect(m.attachment).toBe(true);
    expect(m.tool_call).toBe(true);
    expect(m.temperature).toBe(true);
    expect(m.release_date).toBe("2026-07-08");
    expect(m.cost?.input).toBe(2);
    expect((m as Record<string, unknown>).reasoning_options).toBeUndefined();
    expect(m.variants).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
    });
  });

  it("materializes exact effort sets and disables unsupported auto tiers", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5.1-codex": {
                name: "GPT-5.1 Codex",
                reasoning: true,
                reasoning_options: [
                  {
                    type: "effort",
                    values: ["low", "medium", "high", "xhigh"],
                  },
                ],
              },
              "gpt-5.6-sol": {
                name: "GPT-5.6 Sol",
                reasoning: true,
                reasoning_options: [
                  {
                    type: "effort",
                    values: ["low", "medium", "high", "xhigh", "max", "ultra"],
                  },
                ],
              },
              "o-series-fixed": {
                name: "O Fixed",
                reasoning: true,
                reasoning_options: [],
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const models = await fetchModelsDevOpenAi();
    expect(models["gpt-5.1-codex"].variants).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
    });
    // max is a real wire effort on 5.6 family; ultra is dropped (not accepted).
    expect(models["gpt-5.6-sol"].variants).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
      max: { reasoningEffort: "max" },
    });
    expect(models["o-series-fixed"].variants).toEqual({
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    });
  });
});

describe("buildEffortVariants", () => {
  it("returns undefined when reasoning is false or options are missing", () => {
    expect(
      buildEffortVariants(false, [{ type: "effort", values: ["low"] }]),
    ).toBeUndefined();
    expect(buildEffortVariants(true, undefined)).toBeUndefined();
  });

  it("disables auto low/medium/high when reasoning_options is empty", () => {
    expect(buildEffortVariants(true, [])).toEqual({
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    });
  });
});

describe("resolveCodexMultiModels", () => {
  it("cold start does not hit network and uses DEFAULT_MODELS", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network should not be called");
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const cachePath = await tempCachePath();
    const models = await resolveCodexMultiModels({
      allowNetwork: false,
      cachePath,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(models["gpt-5-codex"]).toBeTruthy();
    expect((models["gpt-5-codex"] as { name: string }).name).toBe(
      "GPT-5 Codex",
    );
    expect(models["gpt-5.1-codex"]).toBeTruthy();
    expect(models["gpt-5.5"]).toBeTruthy();
  });

  it("cold start loads disk cache without network", async () => {
    const fetchMock = vi.fn() as typeof fetch;
    globalThis.fetch = fetchMock;
    const cachePath = await tempCachePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        updatedAt: Date.now(),
        models: {
          "gpt-5.5": {
            name: "Cached GPT-5.5",
            reasoning: true,
            variants: {
              low: { reasoningEffort: "low" },
              medium: { reasoningEffort: "medium" },
              high: { reasoningEffort: "high" },
            },
          },
        },
      }),
      "utf8",
    );

    const models = await resolveCodexMultiModels({
      allowNetwork: false,
      cachePath,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((models["gpt-5.5"] as { name: string }).name).toBe("Cached GPT-5.5");
    // Seed defaults still layered under cache.
    expect(models["gpt-5-codex"]).toBeTruthy();
  });

  it("allowNetwork syncs models.dev openai, writes cache, and merges live ids", async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("models.dev")) {
        return new Response(
          JSON.stringify({
            openai: {
              models: {
                "gpt-5.5": {
                  name: "GPT-5.5",
                  reasoning: true,
                  reasoning_options: [
                    {
                      type: "effort",
                      values: ["low", "medium", "high", "xhigh"],
                    },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "gpt-5.5" }, { id: "gpt-brand-new" }],
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveCodexMultiModels({
      allowNetwork: true,
      accessToken: "tok",
      cachePath,
    });
    expect(models["gpt-5.5"]).toBeTruthy();
    expect((models["gpt-brand-new"] as { name: string }).name).toBe(
      "gpt-brand-new",
    );
    // DEFAULT_MODELS still present under network catalog.
    expect(models["gpt-5-codex"]).toBeTruthy();
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    expect(cached.models["gpt-5.5"]).toBeTruthy();
    expect(cached.models["gpt-brand-new"]).toBeTruthy();
  });

  it("network failure falls back to cache/defaults without throwing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as typeof fetch;

    const cachePath = await tempCachePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        updatedAt: Date.now(),
        models: {
          "gpt-5.5": { name: "From Cache" },
        },
      }),
      "utf8",
    );

    const models = await resolveCodexMultiModels({
      allowNetwork: true,
      accessToken: "tok",
      cachePath,
    });
    expect((models["gpt-5.5"] as { name: string }).name).toBe("From Cache");
    expect(models["gpt-5-codex"]).toBeTruthy();
  });

  it("preserves catalog variants when user only overrides name/limit", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5.1-codex": {
                name: "GPT-5.1 Codex",
                reasoning: true,
                reasoning_options: [
                  {
                    type: "effort",
                    values: ["low", "medium", "high", "xhigh"],
                  },
                ],
                limit: { context: 400000, output: 128000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveCodexMultiModels({
      allowNetwork: true,
      cachePath,
      userModels: {
        "gpt-5.1-codex": {
          name: "GPT-5.1 Codex",
          limit: { context: 400000, output: 128000 },
        },
      },
    });
    const m = models["gpt-5.1-codex"] as {
      reasoning?: boolean;
      variants?: Record<string, unknown>;
    };
    expect(m.reasoning).toBe(true);
    expect(m.variants).toMatchObject({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
    });
  });

  it("lets userModels override catalog entries", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5.5": {
                name: "GPT-5.5",
                limit: { context: 1050000, output: 128000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveCodexMultiModels({
      allowNetwork: true,
      cachePath,
      userModels: {
        "gpt-5.5": { name: "My GPT" },
        "custom-x": { name: "X" },
      },
    });
    expect((models["gpt-5.5"] as { name: string }).name).toBe("My GPT");
    expect((models["custom-x"] as { name: string }).name).toBe("X");
  });

  it("a partial {name, limit} user override does NOT erase models.dev reasoning", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5.5": {
                name: "GPT-5.5",
                reasoning: true,
                limit: { context: 1050000, output: 128000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveCodexMultiModels({
      allowNetwork: true,
      cachePath,
      userModels: {
        "gpt-5.5": {
          name: "GPT-5.5",
          limit: { context: 1050000, output: 128000 },
        },
      },
    });
    const m = models["gpt-5.5"] as {
      name: string;
      reasoning?: boolean;
      limit?: { context: number; output: number };
    };
    expect(m.reasoning).toBe(true);
    expect(m.name).toBe("GPT-5.5");
    expect(m.limit?.context).toBe(1050000);
  });

  it("deep-merges a partial nested limit override without dropping sibling fields", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-5.5": {
                name: "GPT-5.5",
                reasoning: true,
                limit: { context: 1050000, output: 128000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveCodexMultiModels({
      allowNetwork: true,
      cachePath,
      userModels: {
        "gpt-5.5": { limit: { output: 999000 } },
      },
    });
    const m = models["gpt-5.5"] as {
      reasoning?: boolean;
      limit?: { context: number; output: number };
    };
    expect(m.reasoning).toBe(true);
    expect(m.limit?.context).toBe(1050000);
    expect(m.limit?.output).toBe(999000);
  });
});
