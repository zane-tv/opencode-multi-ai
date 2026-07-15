import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_MODELS,
  defaultModelsCachePath,
  XAI_API_BASE,
} from "./constants.js";
import { logger } from "../../core/logger.js";

/**
 * Model discovery for xai-multi.
 *
 * Network fetch (models.dev + optional /v1/models) only runs when
 * `allowNetwork: true` — used after `opencode auth login`. Normal OpenCode
 * startups use the disk cache + bundled DEFAULT_MODELS only.
 */

export type EffortVariantConfig =
  | { reasoningEffort: string }
  | { disabled: true };

export type OpenCodeModelEntry = {
  name: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  interleaved?:
    | true
    | { field: "reasoning" | "reasoning_content" | "reasoning_details" };
  status?: "alpha" | "beta" | "deprecated" | "active";
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    context_over_200k?: {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
    };
  };
  limit?: { context: number; output: number };
  modalities?: { input?: string[]; output?: string[] };
  // Custom provider ids skip models.dev reasoningVariants; materialize effort here.
  variants?: Record<string, EffortVariantConfig>;
};

type ModelsDevReasoningOption = {
  type: string;
  values?: Array<string | null>;
  min?: number;
  max?: number;
};

const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 8_000;

/** Skip image/video-only models for the coding agent picker by default. */
const SKIP_MODEL_RE = /imagine|image|video/i;

// OpenCode auto-generates these for openai-compatible when reasoning=true.
const AUTO_EFFORT_TIERS = ["low", "medium", "high"] as const;

// models.dev reasoning_options → OpenCode variants ({ reasoningEffort } / disabled).
export function buildEffortVariants(
  reasoning: boolean | undefined,
  reasoningOptions: ModelsDevReasoningOption[] | undefined,
): Record<string, EffortVariantConfig> | undefined {
  if (!reasoning) return undefined;
  if (reasoningOptions === undefined) return undefined;

  if (reasoningOptions.length === 0) {
    return Object.fromEntries(
      AUTO_EFFORT_TIERS.map((tier) => [tier, { disabled: true as const }]),
    );
  }

  const effort = reasoningOptions.find((opt) => opt.type === "effort");
  if (!effort || !Array.isArray(effort.values)) return undefined;

  const values: string[] = [];
  for (const raw of effort.values) {
    if (raw === null) values.push("none");
    else if (typeof raw === "string" && raw.length > 0) values.push(raw);
  }
  if (values.length === 0) return undefined;

  const out: Record<string, EffortVariantConfig> = {};
  for (const id of values) {
    out[id] = { reasoningEffort: id };
  }
  for (const auto of AUTO_EFFORT_TIERS) {
    if (!(auto in out)) out[auto] = { disabled: true };
  }
  return out;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the official xAI model catalog from models.dev (same source OpenCode
 * uses for the built-in `xai` provider).
 */
export async function fetchModelsDevXai(): Promise<
  Record<string, OpenCodeModelEntry>
> {
  const data = (await fetchJson(MODELS_DEV_URL)) as {
    xai?: {
      models?: Record<
        string,
        {
          name?: string;
          family?: string;
          release_date?: string;
          attachment?: boolean;
          reasoning?: boolean;
          reasoning_options?: ModelsDevReasoningOption[];
          temperature?: boolean;
          tool_call?: boolean;
          interleaved?:
            | true
            | {
                field: "reasoning" | "reasoning_content" | "reasoning_details";
              };
          status?: "alpha" | "beta" | "deprecated" | "active";
          cost?: {
            input: number;
            output: number;
            cache_read?: number;
            cache_write?: number;
            context_over_200k?: {
              input: number;
              output: number;
              cache_read?: number;
              cache_write?: number;
            };
          };
          limit?: { context?: number; output?: number };
          modalities?: { input?: string[]; output?: string[] };
        }
      >;
    };
  };
  const raw = data.xai?.models;
  if (!raw || typeof raw !== "object") {
    throw new Error("models.dev response missing xai.models");
  }

  const out: Record<string, OpenCodeModelEntry> = {};
  for (const [id, m] of Object.entries(raw)) {
    if (SKIP_MODEL_RE.test(id) || SKIP_MODEL_RE.test(m.name ?? "")) continue;
    const entry: OpenCodeModelEntry = {
      name: m.name ?? id,
    };
    if (m.limit?.context || m.limit?.output) {
      entry.limit = {
        context: m.limit.context ?? 128_000,
        output: m.limit.output ?? 32_000,
      };
    }
    if (m.modalities) entry.modalities = m.modalities;
    if (m.family !== undefined) entry.family = m.family;
    if (m.release_date !== undefined) entry.release_date = m.release_date;
    if (m.attachment !== undefined) entry.attachment = m.attachment;
    if (m.reasoning !== undefined) entry.reasoning = m.reasoning;
    if (m.temperature !== undefined) entry.temperature = m.temperature;
    if (m.tool_call !== undefined) entry.tool_call = m.tool_call;
    if (m.interleaved !== undefined) entry.interleaved = m.interleaved;
    if (m.status !== undefined) entry.status = m.status;
    if (m.cost !== undefined) entry.cost = m.cost;
    const variants = buildEffortVariants(m.reasoning, m.reasoning_options);
    if (variants) entry.variants = variants;
    out[id] = entry;
  }
  if (Object.keys(out).length === 0) {
    throw new Error("models.dev xai catalog produced zero chat models");
  }
  return out;
}

/**
 * List model ids from a live xAI API token (OpenAI-compatible /v1/models).
 * Returns only ids — metadata still comes from models.dev when available.
 */
export async function fetchLiveXaiModelIds(
  accessToken: string,
): Promise<string[]> {
  const data = (await fetchJson(`${XAI_API_BASE}/models`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  })) as { data?: Array<{ id?: string }> };

  const ids = (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id) => !SKIP_MODEL_RE.test(id));
  return [...new Set(ids)];
}

/** Nested config keys that get a safe deep merge instead of full replacement. */
const DEEP_MERGE_KEYS = [
  "limit",
  "modalities",
  "cost",
  "options",
  "headers",
  "variants",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Merge a base model config with a partial user override without mutating
 * either input. Top-level fields the user set explicitly win; fields the
 * user did NOT set (e.g. a partial `{ name, limit }` override) fall back to
 * the base (catalog/default) value — this is what preserves `reasoning`,
 * `cost`, etc. across a partial user entry. Select nested plain-object keys
 * (limit, modalities, cost, options, headers, variants) are merged one level
 * deep so a user overriding e.g. `limit.output` doesn't erase `limit.context`.
 */
function mergeModelEntry(
  base: Record<string, unknown> | undefined,
  user: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  if (!user) return merged;

  for (const [key, value] of Object.entries(user)) {
    if (
      (DEEP_MERGE_KEYS as readonly string[]).includes(key) &&
      isPlainObject(value) &&
      isPlainObject(merged[key])
    ) {
      merged[key] = { ...(merged[key] as Record<string, unknown>), ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

type ModelsCacheFile = {
  updatedAt: number;
  models: Record<string, OpenCodeModelEntry>;
};

export async function readModelsCache(
  cachePath: string = defaultModelsCachePath(),
): Promise<Record<string, OpenCodeModelEntry> | undefined> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as ModelsCacheFile;
    if (!parsed?.models || typeof parsed.models !== "object") return undefined;
    return parsed.models;
  } catch {
    return undefined;
  }
}

export async function writeModelsCache(
  models: Record<string, OpenCodeModelEntry>,
  cachePath: string = defaultModelsCachePath(),
): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const payload: ModelsCacheFile = {
    updatedAt: Date.now(),
    models,
  };
  await writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Resolve the model map for xai-multi.
 *
 * - `allowNetwork: false` (default, normal OpenCode start): cache → DEFAULT_MODELS
 * - `allowNetwork: true` (after auth login): models.dev (+ optional /v1/models),
 *   then write cache for subsequent cold starts
 *
 * `userModels` always win on fields they explicitly set; catalog/default fields
 * the user did not set (e.g. `reasoning`) are preserved.
 */
export async function resolveXaiMultiModels(opts?: {
  accessToken?: string;
  userModels?: Record<string, unknown>;
  allowNetwork?: boolean;
  cachePath?: string;
}): Promise<Record<string, unknown>> {
  const cachePath = opts?.cachePath ?? defaultModelsCachePath();
  let catalog: Record<string, OpenCodeModelEntry> = { ...DEFAULT_MODELS };

  if (opts?.allowNetwork) {
    try {
      catalog = await fetchModelsDevXai();
      logger.debug(
        `multi-xai models: synced ${Object.keys(catalog).length} from models.dev`,
      );
    } catch (err) {
      logger.debug(
        `multi-xai models: models.dev sync failed (${(err as Error).message}); using cache/defaults`,
      );
      const cached = await readModelsCache(cachePath);
      if (cached) catalog = cached;
    }

    if (opts.accessToken) {
      try {
        const liveIds = await fetchLiveXaiModelIds(opts.accessToken);
        let added = 0;
        for (const id of liveIds) {
          if (!(id in catalog)) {
            catalog[id] = { name: id };
            added++;
          }
        }
        if (added > 0) {
          logger.debug(
            `multi-xai models: added ${added} live id(s) from api.x.ai/v1/models`,
          );
        }
      } catch (err) {
        logger.debug(
          `multi-xai models: live /v1/models failed (${(err as Error).message})`,
        );
      }
    }

    try {
      await writeModelsCache(catalog, cachePath);
    } catch (err) {
      logger.debug(
        `multi-xai models: cache write failed (${(err as Error).message})`,
      );
    }
  } else {
    const cached = await readModelsCache(cachePath);
    if (cached) {
      catalog = cached;
      logger.debug(
        `multi-xai models: loaded ${Object.keys(catalog).length} from cache`,
      );
    }
  }

  const base: Record<string, Record<string, unknown>> = {
    ...(DEFAULT_MODELS as Record<string, Record<string, unknown>>),
    ...(catalog as Record<string, Record<string, unknown>>),
  };
  const userModels = opts?.userModels ?? {};

  const result: Record<string, unknown> = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(userModels)])) {
    const userEntry = userModels[id];
    result[id] = mergeModelEntry(
      base[id],
      isPlainObject(userEntry) ? userEntry : undefined,
    );
    if (userEntry !== undefined && !isPlainObject(userEntry)) {
      result[id] = userEntry;
    }
  }
  return result;
}
