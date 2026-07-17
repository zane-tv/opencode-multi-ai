import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { MODEL_MAPPING, defaultModelsCachePath } from "./constants.js";

export type KiroModelEntry = {
  name: string;
  limit?: { context: number; output: number };
  modalities?: { input: string[]; output: string[] };
  variants?: Record<string, { thinkingConfig: { thinkingBudget: number } }>;
};

export const THINKING_VARIANTS = {
  low: { thinkingConfig: { thinkingBudget: 8_192 } },
  medium: { thinkingConfig: { thinkingBudget: 16_384 } },
  high: { thinkingConfig: { thinkingBudget: 24_576 } },
  max: { thinkingConfig: { thinkingBudget: 32_768 } },
} as const;

function displayName(id: string): string {
  return id
    .replace(/-thinking$/i, " Thinking")
    .replace(/-1m/gi, " 1M")
    .replace(/claude-/gi, "Claude ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/1 M/g, "1M");
}

function contextLimit(id: string): number {
  if (id.includes("-1m") || id.includes("claude-sonnet-5")) return 1_000_000;
  return 200_000;
}

function buildDefaultEntry(id: string): KiroModelEntry {
  return {
    name: displayName(id),
    limit: { context: contextLimit(id), output: 64_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    variants: { ...THINKING_VARIANTS },
  };
}

export const KIRO_DEFAULT_MODELS: Record<string, KiroModelEntry> =
  Object.fromEntries(
    Object.keys(MODEL_MAPPING).map((id) => [id, buildDefaultEntry(id)]),
  );

type CacheFile = { updatedAt: number; models: Record<string, KiroModelEntry> };

async function readCache(
  cachePath: string,
): Promise<Record<string, KiroModelEntry> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    if (
      value !== null &&
      typeof value === "object" &&
      "models" in value &&
      value.models !== null &&
      typeof value.models === "object"
    ) {
      return value.models as Record<string, KiroModelEntry>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function writeKiroModelsCache(
  models: Record<string, KiroModelEntry>,
  cachePath = defaultModelsCachePath(),
): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const payload: CacheFile = { updatedAt: Date.now(), models };
  await writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function resolveKiroMultiModels(opts?: {
  userModels?: Record<string, unknown>;
  allowNetwork?: boolean;
  cachePath?: string;
}): Promise<Record<string, unknown>> {
  void opts?.allowNetwork;
  const cachePath = opts?.cachePath ?? defaultModelsCachePath();
  const cached = await readCache(cachePath);
  const user = opts?.userModels ?? {};
  const resolved: Record<string, unknown> = {};

  for (const id of Object.keys(MODEL_MAPPING)) {
    const defaultEntry = KIRO_DEFAULT_MODELS[id] ?? buildDefaultEntry(id);
    const cachedEntry = cached?.[id];
    const userEntry = user[id];

    let entry: Record<string, unknown> = { ...defaultEntry };
    if (cachedEntry && typeof cachedEntry === "object") {
      entry = { ...entry, ...cachedEntry };
    }
    if (
      userEntry !== null &&
      typeof userEntry === "object" &&
      !Array.isArray(userEntry)
    ) {
      entry = { ...entry, ...userEntry };
    }

    const existingVariants =
      entry.variants !== null &&
      typeof entry.variants === "object" &&
      !Array.isArray(entry.variants)
        ? (entry.variants as Record<string, unknown>)
        : {};
    entry.variants = { ...THINKING_VARIANTS, ...existingVariants };

    if (typeof entry.name !== "string" || !entry.name.trim()) {
      entry.name = displayName(id);
    }
    resolved[id] = entry;
  }

  return resolved;
}
