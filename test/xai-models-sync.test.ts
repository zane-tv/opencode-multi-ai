import { afterEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildEffortVariants,
  fetchModelsDevXai,
  resolveXaiMultiModels,
} from "../lib/providers/xai/models-sync.js";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "multi-ai-models-xai-"));
  tempDirs.push(dir);
  return path.join(dir, "multi-ai-models-xai.json");
}

describe("fetchModelsDevXai", () => {
  it("maps models.dev xai catalog and skips imagine/image/video", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          xai: {
            models: {
              "grok-4.5": {
                name: "Grok 4.5",
                limit: { context: 500000, output: 500000 },
              },
              "grok-imagine-image": { name: "Grok Imagine Image" },
              "grok-4.3": {
                name: "Grok 4.3",
                limit: { context: 1000000, output: 30000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const models = await fetchModelsDevXai();
    expect(Object.keys(models).sort()).toEqual(["grok-4.3", "grok-4.5"]);
    expect(models["grok-4.5"].limit?.context).toBe(500000);
    expect(models["grok-imagine-image"]).toBeUndefined();
  });

  it("preserves reasoning and other supported metadata fields from models.dev", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          xai: {
            models: {
              "grok-4.5": {
                name: "Grok 4.5",
                family: "grok",
                attachment: true,
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["low", "medium", "high"] },
                ],
                tool_call: true,
                temperature: true,
                release_date: "2026-07-08",
                limit: { context: 500000, output: 500000 },
                modalities: { input: ["text", "image"], output: ["text"] },
                cost: { input: 2, output: 6, cache_read: 0.5 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const models = await fetchModelsDevXai();
    const grok = models["grok-4.5"];
    expect(grok.reasoning).toBe(true);
    expect(grok.family).toBe("grok");
    expect(grok.attachment).toBe(true);
    expect(grok.tool_call).toBe(true);
    expect(grok.temperature).toBe(true);
    expect(grok.release_date).toBe("2026-07-08");
    expect(grok.cost?.input).toBe(2);
    expect((grok as Record<string, unknown>).reasoning_options).toBeUndefined();
    expect(grok.variants).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    });
  });

  it("materializes exact effort sets and disables unsupported auto tiers", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          xai: {
            models: {
              "grok-4.3": {
                name: "Grok 4.3",
                reasoning: true,
                reasoning_options: [
                  {
                    type: "effort",
                    values: ["none", "low", "medium", "high"],
                  },
                ],
              },
              "grok-4.20-multi-agent-0309": {
                name: "Grok 4.20 Multi-Agent",
                reasoning: true,
                reasoning_options: [
                  {
                    type: "effort",
                    values: ["low", "medium", "high", "xhigh"],
                  },
                ],
              },
              "grok-4.20-0309-reasoning": {
                name: "Grok 4.20 (Reasoning)",
                reasoning: true,
                reasoning_options: [],
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const models = await fetchModelsDevXai();
    expect(models["grok-4.3"].variants).toEqual({
      none: { reasoningEffort: "none" },
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    });
    expect(models["grok-4.20-multi-agent-0309"].variants).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
    });
    expect(models["grok-4.20-0309-reasoning"].variants).toEqual({
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    });
  });
});

describe("buildEffortVariants", () => {
  it("returns undefined when reasoning is false or options are missing", () => {
    expect(buildEffortVariants(false, [{ type: "effort", values: ["low"] }])).toBeUndefined();
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

describe("resolveXaiMultiModels", () => {
  it("cold start does not hit network and uses DEFAULT_MODELS", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network should not be called");
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const cachePath = await tempCachePath();
    const models = await resolveXaiMultiModels({
      allowNetwork: false,
      cachePath,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(models["grok-4.5"]).toBeTruthy();
    expect((models["grok-4.5"] as { name: string }).name).toBe("Grok 4.5");
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
          "grok-4.5": {
            name: "Cached Grok",
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

    const models = await resolveXaiMultiModels({
      allowNetwork: false,
      cachePath,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((models["grok-4.5"] as { name: string }).name).toBe("Cached Grok");
  });

  it("allowNetwork syncs models.dev, writes cache, and merges live ids", async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("models.dev")) {
        return new Response(
          JSON.stringify({
            xai: {
              models: {
                "grok-4.5": {
                  name: "Grok 4.5",
                  reasoning: true,
                  reasoning_options: [
                    { type: "effort", values: ["low", "medium", "high"] },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "grok-4.5" }, { id: "grok-brand-new" }],
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveXaiMultiModels({
      allowNetwork: true,
      accessToken: "tok",
      cachePath,
    });
    expect(models["grok-4.5"]).toBeTruthy();
    expect((models["grok-brand-new"] as { name: string }).name).toBe(
      "grok-brand-new",
    );
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    expect(cached.models["grok-4.5"]).toBeTruthy();
    expect(cached.models["grok-brand-new"]).toBeTruthy();
  });

  it("preserves catalog variants when user only overrides name/limit", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          xai: {
            models: {
              "grok-4.3": {
                name: "Grok 4.3",
                reasoning: true,
                reasoning_options: [
                  {
                    type: "effort",
                    values: ["none", "low", "medium", "high"],
                  },
                ],
                limit: { context: 1000000, output: 30000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveXaiMultiModels({
      allowNetwork: true,
      cachePath,
      userModels: {
        "grok-4.3": {
          name: "Grok 4.3",
          limit: { context: 1000000, output: 30000 },
        },
      },
    });
    const grok = models["grok-4.3"] as {
      reasoning?: boolean;
      variants?: Record<string, unknown>;
    };
    expect(grok.reasoning).toBe(true);
    expect(grok.variants).toMatchObject({
      none: { reasoningEffort: "none" },
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    });
  });

  it("lets userModels override catalog entries", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          xai: {
            models: {
              "grok-4.5": {
                name: "Grok 4.5",
                limit: { context: 500000, output: 500000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveXaiMultiModels({
      allowNetwork: true,
      cachePath,
      userModels: { "grok-4.5": { name: "My Grok" }, "custom-x": { name: "X" } },
    });
    expect((models["grok-4.5"] as { name: string }).name).toBe("My Grok");
    expect((models["custom-x"] as { name: string }).name).toBe("X");
  });

  it("a partial {name, limit} user override does NOT erase models.dev reasoning", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          xai: {
            models: {
              "grok-4.5": {
                name: "Grok 4.5",
                reasoning: true,
                limit: { context: 500000, output: 500000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveXaiMultiModels({
      allowNetwork: true,
      cachePath,
      userModels: {
        "grok-4.5": {
          name: "Grok 4.5",
          limit: { context: 500000, output: 500000 },
        },
      },
    });
    const grok = models["grok-4.5"] as {
      name: string;
      reasoning?: boolean;
      limit?: { context: number; output: number };
    };
    expect(grok.reasoning).toBe(true);
    expect(grok.name).toBe("Grok 4.5");
    expect(grok.limit?.context).toBe(500000);
  });

  it("deep-merges a partial nested limit override without dropping sibling fields", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          xai: {
            models: {
              "grok-4.5": {
                name: "Grok 4.5",
                reasoning: true,
                limit: { context: 500000, output: 500000 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const cachePath = await tempCachePath();
    const models = await resolveXaiMultiModels({
      allowNetwork: true,
      cachePath,
      userModels: {
        "grok-4.5": { limit: { output: 999000 } },
      },
    });
    const grok = models["grok-4.5"] as {
      reasoning?: boolean;
      limit?: { context: number; output: number };
    };
    expect(grok.reasoning).toBe(true);
    expect(grok.limit?.context).toBe(500000);
    expect(grok.limit?.output).toBe(999000);
  });
});
