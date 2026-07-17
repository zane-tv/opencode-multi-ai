import { MODEL_MAPPING, SUPPORTED_MODELS } from "./constants.js";

const VARIANT_SUFFIXES = [
  "-thinking",
  "-ultra",
  "-xhigh",
  "-max",
  "-high",
  "-medium",
  "-low",
  ":ultra",
  ":xhigh",
  ":max",
  ":high",
  ":medium",
  ":low",
] as const;

const EFFORT_SUFFIXES = [
  "-ultra",
  "-xhigh",
  "-max",
  "-high",
  "-medium",
  "-low",
  ":ultra",
  ":xhigh",
  ":max",
  ":high",
  ":medium",
  ":low",
] as const;

function stripProvider(model: string): string {
  let slug = model.trim();
  if (slug.includes("/")) slug = slug.split("/").pop() ?? slug;
  return slug;
}

export function normalizeOpenCodeModelSlug(model: string): string {
  let slug = stripProvider(model);
  for (const suffix of VARIANT_SUFFIXES) {
    if (slug.endsWith(suffix) && slug.length > suffix.length) {
      return slug.slice(0, -suffix.length);
    }
  }
  return slug;
}

export function resolveKiroModel(model: string): string {
  const slug = stripProvider(model);
  if (MODEL_MAPPING[slug]) return MODEL_MAPPING[slug];

  let candidate = slug;
  for (const suffix of EFFORT_SUFFIXES) {
    if (candidate.endsWith(suffix) && candidate.length > suffix.length) {
      candidate = candidate.slice(0, -suffix.length);
      break;
    }
  }
  if (MODEL_MAPPING[candidate]) return MODEL_MAPPING[candidate];

  if (
    !candidate.endsWith("-thinking") &&
    MODEL_MAPPING[`${candidate}-thinking`]
  ) {
    return MODEL_MAPPING[`${candidate}-thinking`];
  }

  const bare = normalizeOpenCodeModelSlug(candidate);
  if (MODEL_MAPPING[bare]) return MODEL_MAPPING[bare];
  if (MODEL_MAPPING[`${bare}-thinking`]) return MODEL_MAPPING[`${bare}-thinking`];
  if (Object.values(MODEL_MAPPING).includes(bare)) return bare;
  if (Object.values(MODEL_MAPPING).includes(candidate)) return candidate;

  throw new Error(
    `Unsupported Kiro model: ${model}. Supported: ${SUPPORTED_MODELS.join(", ")}`,
  );
}

export function supportsKiroThinkingMode(model: string): boolean {
  return !model.startsWith("gpt-5.6") && model !== "auto";
}

export function getContextWindowSize(model: string): number {
  if (model.includes("gpt-5.6")) return 272_000;
  return model.includes("-1m") || model.includes("claude-sonnet-5")
    ? 1_000_000
    : 200_000;
}
