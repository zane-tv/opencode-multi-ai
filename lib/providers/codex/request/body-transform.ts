/**
 * Native/minimal Codex Responses body transform.
 *
 * Intentionally NOT the oc-codex "legacy" full body-shaping path
 * (no Codex system-prompt injection, no tool remap, no developer-msg bridge).
 */

/** Always ensure this include entry is present for encrypted reasoning. */
export const CODEX_INCLUDE_ENCRYPTED_REASONING = "reasoning.encrypted_content";

/**
 * Optional model id aliases after stripping a `provider/` prefix.
 * Empty by default — extend only when the backend requires a remap.
 */
export const CODEX_MODEL_NORMALIZE: Readonly<Record<string, string>> = {
  // Example (kept off unless needed): "gpt-5.1-codex": "gpt-5-codex",
};

export type CodexBodyTransformOptions = {
  /** Maps to body.reasoning.effort when provided. */
  reasoningEffort?: string;
  /** Maps to body.reasoning.summary when provided. */
  reasoningSummary?: string;
  /** Maps to body.text.verbosity when provided. */
  textVerbosity?: string;
  /**
   * When true (default), strip `provider/` prefix and apply CODEX_MODEL_NORMALIZE.
   * Pass false to leave `model` untouched.
   */
  normalizeModel?: boolean;
};

export const CODEX_SUPPORTED_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CodexSupportedEffort = (typeof CODEX_SUPPORTED_EFFORTS)[number];

const CODEX_EFFORT_ALIASES: Readonly<Record<string, CodexSupportedEffort>> = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "max",
  "x-high": "xhigh",
  extreme: "max",
};

export function modelAcceptsMaxEffort(model: string | undefined): boolean {
  if (!model) return false;
  const bare = model.includes("/")
    ? model.slice(model.lastIndexOf("/") + 1)
    : model;
  return /^gpt-5\.6/i.test(bare);
}

export function normalizeCodexEffort(
  effort: string,
  model?: string,
): CodexSupportedEffort {
  const key = effort.trim().toLowerCase();
  let out: CodexSupportedEffort = CODEX_EFFORT_ALIASES[key] ?? "high";
  if (out === "max" && !modelAcceptsMaxEffort(model)) {
    out = "xhigh";
  }
  return out;
}

/**
 * Pure object transform for a Codex Responses JSON body.
 *
 * - force `store: false`
 * - ensure `include` contains `reasoning.encrypted_content`
 * - map reasoning effort/summary and text.verbosity from options when provided
 * - clamp reasoning.effort (ultra → max; keep max/xhigh as-is)
 * - remove Platform fields rejected by ChatGPT Codex
 * - optional model normalize (strip provider prefix + alias map)
 */
export function transformCodexBody(
  body: Record<string, unknown>,
  options?: CodexBodyTransformOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };

  out.store = false;

  const include = Array.isArray(out.include)
    ? [...(out.include as unknown[])]
    : [];
  if (!include.includes(CODEX_INCLUDE_ENCRYPTED_REASONING)) {
    include.push(CODEX_INCLUDE_ENCRYPTED_REASONING);
  }
  out.include = include;

  const modelForEffort =
    typeof out.model === "string" ? out.model : undefined;
  const effort = options?.reasoningEffort;
  const summary = options?.reasoningSummary;
  if (effort !== undefined || summary !== undefined) {
    const existing =
      out.reasoning &&
      typeof out.reasoning === "object" &&
      !Array.isArray(out.reasoning)
        ? { ...(out.reasoning as Record<string, unknown>) }
        : {};
    if (effort !== undefined) {
      existing.effort = normalizeCodexEffort(effort, modelForEffort);
    }
    if (summary !== undefined) existing.summary = summary;
    out.reasoning = existing;
  } else if (
    out.reasoning &&
    typeof out.reasoning === "object" &&
    !Array.isArray(out.reasoning)
  ) {
    const existing = { ...(out.reasoning as Record<string, unknown>) };
    if (typeof existing.effort === "string") {
      existing.effort = normalizeCodexEffort(existing.effort, modelForEffort);
      out.reasoning = existing;
    }
  }

  if (options?.textVerbosity !== undefined) {
    const existing =
      out.text && typeof out.text === "object" && !Array.isArray(out.text)
        ? { ...(out.text as Record<string, unknown>) }
        : {};
    existing.verbosity = options.textVerbosity;
    out.text = existing;
  }

  for (const key of [
    "max_completion_tokens",
    "max_output_tokens",
    "max_tokens",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "logit_bias",
    "logprobs",
    "top_logprobs",
    "n",
    "user",
    "service_tier",
  ] as const) {
    if (key in out) delete out[key];
  }

  if (options?.normalizeModel !== false && typeof out.model === "string") {
    out.model = normalizeCodexModel(out.model);
  }

  return out;
}

/**
 * Strip a leading `provider/` segment and apply CODEX_MODEL_NORMALIZE aliases.
 */
export function normalizeCodexModel(model: string): string {
  const bare =
    model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return CODEX_MODEL_NORMALIZE[bare] ?? bare;
}

/**
 * Best-effort transform of a fetch RequestInit body string.
 * Non-JSON / empty / non-object bodies are returned unchanged.
 */
export function transformCodexRequestInit(
  init: RequestInit | undefined,
  options?: CodexBodyTransformOptions,
): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  if (!init.body.trim()) return init;

  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return init;
  }

  const next = transformCodexBody(
    parsed as Record<string, unknown>,
    options,
  );
  return { ...init, body: JSON.stringify(next) };
}

/** True when body still asks for reasoning.effort=ultra (should not after normalize). */
export function bodyRequestsUltraEffort(body: unknown): boolean {
  if (typeof body !== "string" || !body.trim()) return false;
  try {
    const parsed = JSON.parse(body) as { reasoning?: { effort?: unknown } };
    const effort = parsed?.reasoning?.effort;
    return typeof effort === "string" && effort.trim().toLowerCase() === "ultra";
  } catch {
    return /"effort"\s*:\s*"ultra"/i.test(body);
  }
}

/**
 * ChatGPT Codex rejects effort "ultra" on codex/responses.
 * Detect that 400 so fetch can retry once with max (or xhigh on non-5.6).
 */
export function isUltraEffortRejected(
  status: number,
  bodyText: string,
): boolean {
  if (status !== 400) return false;
  const t = bodyText.toLowerCase();
  if (!t.includes("ultra")) return false;
  return (
    t.includes("invalid value") ||
    t.includes("unsupported value") ||
    t.includes("supported values are") ||
    t.includes("reasoning") ||
    t.includes("effort")
  );
}

/**
 * Rewrite a JSON body string so reasoning.effort becomes max (or xhigh if
 * the model cannot take max). Returns null when body is not rewritable JSON.
 */
export function forceEffortInBody(
  body: string,
  effort: CodexSupportedEffort,
): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const model =
      typeof parsed.model === "string" ? parsed.model : undefined;
    const wire = normalizeCodexEffort(effort, model);
    const reasoning =
      parsed.reasoning &&
      typeof parsed.reasoning === "object" &&
      !Array.isArray(parsed.reasoning)
        ? { ...(parsed.reasoning as Record<string, unknown>) }
        : {};
    reasoning.effort = wire;
    if (reasoning.summary === undefined) reasoning.summary = "auto";
    parsed.reasoning = reasoning;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

/** Best-effort session id extraction from OpenCode request headers. */
export function sessionIdFromHeaders(
  headers: Headers | Record<string, string> | Array<[string, string]> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const h = headers instanceof Headers ? headers : new Headers(headers);
  return (
    h.get("x-session-id") ??
    h.get("X-Session-Id") ??
    h.get("x-session-affinity") ??
    undefined
  ) || undefined;
}
