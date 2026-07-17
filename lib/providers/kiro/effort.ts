import type { Effort } from "./types.js";

const GPT56_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const XHIGH_CAPABLE_MODELS = new Set([
  "claude-opus-4.7",
  "claude-opus-4.8",
  ...GPT56_MODELS,
]);
const EFFORT_CAPABLE_MODELS = new Set([
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.6-1m",
  "claude-sonnet-4.5",
  "claude-sonnet-4.5-1m",
  "claude-sonnet-4.6",
  "claude-sonnet-4.6-1m",
  ...XHIGH_CAPABLE_MODELS,
]);

export function isGpt56Model(model: string): boolean {
  return model.startsWith("gpt-5.6");
}

export function supportsEffort(model: string): boolean {
  return EFFORT_CAPABLE_MODELS.has(model) || isGpt56Model(model);
}

export function budgetToEffort(budget: number, model: string): Effort | undefined {
  if (!supportsEffort(model)) return undefined;
  if (budget <= 10_000) return "low";
  if (budget <= 20_000) return "medium";
  if (budget <= 28_000) return "high";
  if (isGpt56Model(model) && budget <= 40_000) return "xhigh";
  return "max";
}

export function getEffectiveEffort(
  model: string,
  thinking: boolean,
  budget: number,
  configured?: Effort,
  autoMap = true,
): Effort | undefined {
  if (!supportsEffort(model)) return undefined;
  if (configured) {
    return configured === "xhigh" && !XHIGH_CAPABLE_MODELS.has(model)
      ? "max"
      : configured;
  }
  if (!thinking) return undefined;
  return autoMap ? budgetToEffort(budget, model) : "medium";
}

export type EffortWireFields =
  | { output_config: { effort: Effort } }
  | { reasoning: { mode: "standard" | "pro"; effort: Effort } };

export function buildAdditionalModelRequestFields(
  kiroModel: string,
  effort?: Effort,
  budget = 20_000,
): EffortWireFields | undefined {
  if (!effort) return undefined;
  if (isGpt56Model(kiroModel)) {
    return {
      reasoning: {
        mode: budget >= 64_000 ? "pro" : "standard",
        effort,
      },
    };
  }
  return { output_config: { effort } };
}
