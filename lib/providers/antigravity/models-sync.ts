import { ANTIGRAVITY_DEFAULT_MODELS } from "./constants.js";

export interface AntigravityModelEntry {
  name: string;
  attachment?: boolean;
  reasoning?: boolean;
  limit?: { context: number; output: number };
  modalities?: { input: string[]; output: string[] };
  description?: string;
  variants?: Record<string, unknown>;
}

export function buildAntigravityModels(): Record<string, AntigravityModelEntry> {
  const result: Record<string, AntigravityModelEntry> = {};

  for (const [id, meta] of Object.entries(ANTIGRAVITY_DEFAULT_MODELS)) {
    const isZeroThinking = meta.thinkingBudget === 0 || id === "gemini-3-flash";
    result[id] = {
      name: meta.name,
      description: meta.description,
      attachment: true,
      reasoning: !isZeroThinking,
      limit: {
        context: id.includes("pro") ? 2_097_152 : 1_048_576, // 2M or 1M context
        output: 65_536,
      },
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      ...(isZeroThinking
        ? {}
        : {
            variants: {
              low: { reasoningEffort: "low" },
              medium: { reasoningEffort: "medium" },
              high: { reasoningEffort: "high" },
            },
          }),
    };
  }

  return result;
}

export async function resolveAntigravityMultiModels(options?: {
  userModels?: Record<string, unknown>;
  allowNetwork?: boolean;
}): Promise<Record<string, unknown>> {
  const defaults = buildAntigravityModels();
  const user = options?.userModels || {};
  const result: Record<string, unknown> = {};

  const allKeys = new Set([...Object.keys(defaults), ...Object.keys(user)]);
  for (const id of allKeys) {
    const defaultEntry = defaults[id];
    const userEntry = user[id] as Record<string, unknown> | undefined;
    if (defaultEntry && userEntry && typeof userEntry === "object") {
      result[id] = {
        ...userEntry,
        ...defaultEntry,
        reasoning: defaultEntry.reasoning,
        attachment: defaultEntry.attachment,
        variants: defaultEntry.variants ?? userEntry.variants,
      };
    } else if (defaultEntry) {
      result[id] = defaultEntry;
    } else if (userEntry) {
      result[id] = userEntry;
    }
  }

  return result;
}
