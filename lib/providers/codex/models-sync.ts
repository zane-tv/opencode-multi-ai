import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CODEX_BASE_URL,
  DEFAULT_MODELS,
  defaultModelsCachePath,
} from "./constants.js";
import { logger } from "../../core/logger.js";

/**
 * Model discovery for codex-multi.
 *
 * Network fetch (models.dev openai catalog + optional live model ids) only runs
 * when `allowNetwork: true` — used after successful OAuth login. Normal OpenCode
 * startups use the disk cache + bundled DEFAULT_MODELS only.
 *
 * DEFAULT_MODELS lives in constants.ts — do not redefine the seed catalog here.
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

/**
 * Provider-level default options for Codex Responses (native/minimal).
 * Plugin config / body transform can reuse these so store/include/reasoning
 * defaults stay consistent.
 */
export const CODEX_PROVIDER_DEFAULT_OPTIONS = {
  store: false,
  include: ["reasoning.encrypted_content"] as string[],
  reasoningEffort: "medium",
  reasoningSummary: "auto",
  textVerbosity: "medium",
} as const;

/** Skip image/video-only models for the coding agent picker by default. */
const SKIP_MODEL_RE = /imagine|image|video|dall-e|tts|whisper|embedding|moderation|realtime|transcribe|search-api/i;

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

  const allowed = new Set([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const drop = new Set(["ultra", "extreme", "x-high"]);

  const out: Record<string, EffortVariantConfig> = {};
  for (const id of values) {
    if (drop.has(id)) continue;
    if (!allowed.has(id)) continue;
    if (!(id in out)) out[id] = { reasoningEffort: id };
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

type ModelsDevModelRaw = {
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
};

/**
 * Pull the OpenAI model catalog from models.dev (same source OpenCode uses for
 * the built-in `openai` provider). Prefer chat/reasoning models; skip media-only.
 */
export async function fetchModelsDevOpenAi(): Promise<
  Record<string, OpenCodeModelEntry>
> {
  const data = (await fetchJson(MODELS_DEV_URL)) as {
    openai?: {
      models?: Record<string, ModelsDevModelRaw>;
    };
  };
  const raw = data.openai?.models;
  if (!raw || typeof raw !== "object") {
    throw new Error("models.dev response missing openai.models");
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
    throw new Error("models.dev openai catalog produced zero chat models");
  }
  return out;
}

/**
 * Optional live model-id probe against the ChatGPT backend.
 * Best-effort only — chatgpt.com/backend-api may not expose a standard
 * OpenAI-compatible /models list. Callers must tolerate failure.
 */
export async function fetchLiveCodexModelIds(
  accessToken: string,
): Promise<string[]> {
  // Prefer OpenAI-compatible shape if the backend ever serves it under base URL.
  const data = (await fetchJson(`${CODEX_BASE_URL}/models`, {
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

const CODEX_EFFORT_VARIANT_ALLOWED = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const CODEX_EFFORT_VARIANT_DROP = new Set(["ultra", "extreme", "x-high"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function scrubCodexEffortVariants(
  variants: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!variants) return variants;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variants)) {
    if (CODEX_EFFORT_VARIANT_DROP.has(key)) continue;
    if (
      isPlainObject(value) &&
      typeof value.reasoningEffort === "string"
    ) {
      const raw = value.reasoningEffort;
      if (CODEX_EFFORT_VARIANT_DROP.has(raw)) continue;
      if (!CODEX_EFFORT_VARIANT_ALLOWED.has(raw)) continue;
      const canon = raw;
      if (!(canon in out)) {
        out[canon] = { ...value, reasoningEffort: canon };
      }
      continue;
    }
    if (CODEX_EFFORT_VARIANT_ALLOWED.has(key)) {
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}

/**
 * Merge a base model config with a partial user override without mutating
 * either input. Top-level fields the user set explicitly win; fields the
 * user did NOT set fall back to the base (catalog/default) value. Select
 * nested plain-object keys are merged one level deep.
 */
function mergeModelEntry(
  base: Record<string, unknown> | undefined,
  user: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  if (!user) {
    if (isPlainObject(merged.variants)) {
      merged.variants = scrubCodexEffortVariants(
        merged.variants as Record<string, unknown>,
      );
    }
    return merged;
  }

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
  if (isPlainObject(merged.variants)) {
    merged.variants = scrubCodexEffortVariants(
      merged.variants as Record<string, unknown>,
    );
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
 * Resolve the model map for codex-multi.
 *
 * - `allowNetwork: false` (default, normal OpenCode start): cache → DEFAULT_MODELS
 * - `allowNetwork: true` (after auth login): models.dev openai catalog
 *   (+ optional live model ids), then write cache for subsequent cold starts
 *
 * Network failures never throw — fall back to cache then DEFAULT_MODELS.
 * `userModels` always win on fields they explicitly set.
 */
export async function resolveCodexMultiModels(opts?: {
  accessToken?: string;
  userModels?: Record<string, unknown>;
  allowNetwork?: boolean;
  cachePath?: string;
}): Promise<Record<string, unknown>> {
  const cachePath = opts?.cachePath ?? defaultModelsCachePath();
  let catalog: Record<string, OpenCodeModelEntry> = {
    ...(DEFAULT_MODELS as Record<string, OpenCodeModelEntry>),
  };

  if (opts?.allowNetwork) {
    try {
      catalog = await fetchModelsDevOpenAi();
      logger.debug(
        `multi-codex models: synced ${Object.keys(catalog).length} from models.dev openai`,
      );
    } catch (err) {
      logger.debug(
        `multi-codex models: models.dev sync failed (${(err as Error).message}); using cache/defaults`,
      );
      const cached = await readModelsCache(cachePath);
      if (cached) catalog = cached;
    }

    // Live /models is optional and often unavailable on chatgpt backend-api.
    if (opts.accessToken) {
      try {
        const liveIds = await fetchLiveCodexModelIds(opts.accessToken);
        let added = 0;
        for (const id of liveIds) {
          if (!(id in catalog)) {
            catalog[id] = { name: id };
            added++;
          }
        }
        if (added > 0) {
          logger.debug(
            `multi-codex models: added ${added} live id(s) from backend-api/models`,
          );
        }
      } catch (err) {
        logger.debug(
          `multi-codex models: live models probe failed (${(err as Error).message}); keeping catalog`,
        );
      }
    }

    try {
      await writeModelsCache(catalog, cachePath);
    } catch (err) {
      logger.debug(
        `multi-codex models: cache write failed (${(err as Error).message})`,
      );
    }
  } else {
    const cached = await readModelsCache(cachePath);
    if (cached) {
      catalog = cached;
      logger.debug(
        `multi-codex models: loaded ${Object.keys(catalog).length} from cache`,
      );
    }
  }

  // Always layer DEFAULT_MODELS under catalog so seed entries remain present
  // even when cache/network returns a partial set.
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
