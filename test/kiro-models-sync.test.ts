import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveKiroMultiModels,
  writeKiroModelsCache,
} from "../lib/providers/kiro/models-sync.js";

const paths: string[] = [];

function cachePath(): string {
  const file = path.join(
    os.tmpdir(),
    `kiro-models-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
  paths.push(file);
  return file;
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((file) => fs.rm(file, { force: true })));
});

describe("resolveKiroMultiModels", () => {
  it("exposes only thinking models with budget variants", async () => {
    const models = await resolveKiroMultiModels({ cachePath: cachePath() });

    expect(Object.keys(models).every((id) => id.endsWith("-thinking"))).toBe(
      true,
    );
    expect(models["claude-opus-4-8"]).toBeUndefined();
    expect(models["auto"]).toBeUndefined();
    expect(models["gpt-5.6-sol"]).toBeUndefined();
    expect(models["deepseek-3.2"]).toBeUndefined();

    expect(models["claude-opus-4-8-thinking"]).toMatchObject({
      limit: { context: 200_000, output: 64_000 },
      variants: {
        low: { thinkingConfig: { thinkingBudget: 8_192 } },
        medium: { thinkingConfig: { thinkingBudget: 16_384 } },
        high: { thinkingConfig: { thinkingBudget: 24_576 } },
        max: { thinkingConfig: { thinkingBudget: 32_768 } },
      },
    });
    expect(models["claude-sonnet-5-thinking"]).toMatchObject({
      limit: { context: 1_000_000, output: 64_000 },
      variants: {
        max: { thinkingConfig: { thinkingBudget: 32_768 } },
      },
    });
  });

  it("drops non-thinking / Chinese models and keeps user overrides on thinking ids", async () => {
    const file = cachePath();
    await writeKiroModelsCache(
      {
        "claude-opus-4-8-thinking": {
          name: "Cached Opus Thinking",
          limit: { context: 123, output: 456 },
          modalities: { input: ["text"], output: ["text"] },
        },
        "claude-opus-4-8": {
          name: "Non-thinking should drop",
          modalities: { input: ["text"], output: ["text"] },
        },
        "deepseek-3.2": {
          name: "DeepSeek",
          modalities: { input: ["text"], output: ["text"] },
        },
      },
      file,
    );

    const models = await resolveKiroMultiModels({
      cachePath: file,
      userModels: {
        "claude-opus-4-8-thinking": { name: "User Opus Thinking" },
        "claude-opus-4-8": { name: "User Non-thinking" },
        "glm-5": { name: "GLM" },
        "qwen3-coder-next": { name: "Qwen" },
      },
    });

    expect(models["claude-opus-4-8"]).toBeUndefined();
    expect(models["deepseek-3.2"]).toBeUndefined();
    expect(models["glm-5"]).toBeUndefined();
    expect(models["qwen3-coder-next"]).toBeUndefined();
    expect(models["minimax-m2.5"]).toBeUndefined();
    expect(models["claude-opus-4-8-thinking"]).toMatchObject({
      name: "User Opus Thinking",
      limit: { context: 123, output: 456 },
      variants: {
        low: { thinkingConfig: { thinkingBudget: 8_192 } },
      },
    });
  });
});
