import type { SessionRequestOptions } from "../../../core/session-options.js";

/** Models hard-pinned to API max effort (`high`). grok-4.5 has no `xhigh`. */
const FORCE_HIGH_EFFORT_MODELS = new Set(["grok-4.5"]);

function modelIdFromBody(body: Record<string, unknown>): string | undefined {
  const raw = body.model;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const slash = raw.lastIndexOf("/");
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

function shouldForceHighEffort(modelId: string | undefined): boolean {
  return modelId !== undefined && FORCE_HIGH_EFFORT_MODELS.has(modelId);
}

/**
 * Inject xAI Responses reasoning fields that `@ai-sdk/xai` would have written
 * if OpenCode had passed providerOptions under the key `xai`.
 *
 * Only mutates JSON bodies for /v1/responses. Chat-completions bodies get
 * reasoning_effort as a safe fallback. Never touches non-JSON / non-string bodies.
 * FORCE_HIGH_EFFORT_MODELS always pin effort to `high` (overwrite lower values).
 */
export function injectXaiReasoningBody(
  url: URL,
  init: RequestInit | undefined,
  options: SessionRequestOptions | undefined,
): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  if (!init.body.trim()) return init;

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(init.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return init;
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return init;
  }

  const forceHigh = shouldForceHighEffort(modelIdFromBody(body));
  if (!options && !forceHigh) return init;

  const path = url.pathname;
  let changed = false;
  const effort = forceHigh
    ? "high"
    : options?.reasoningEffort;
  const summary = options?.reasoningSummary;

  if (path.endsWith("/responses") || path.includes("/responses")) {
    if (effort || summary) {
      const existing =
        body.reasoning &&
        typeof body.reasoning === "object" &&
        !Array.isArray(body.reasoning)
          ? { ...(body.reasoning as Record<string, unknown>) }
          : {};
      if (effort) {
        if (forceHigh) {
          if (existing.effort !== effort) {
            existing.effort = effort;
            changed = true;
          }
        } else if (existing.effort === undefined) {
          existing.effort = effort;
          changed = true;
        }
      }
      if (summary && existing.summary === undefined) {
        existing.summary = summary;
        changed = true;
      }
      if (changed) body.reasoning = existing;
    }
    if (options?.store === false && body.store === undefined) {
      body.store = false;
      changed = true;
    }
    if (options?.include?.length) {
      const cur = Array.isArray(body.include) ? [...(body.include as unknown[])] : [];
      for (const item of options.include) {
        if (!cur.includes(item)) {
          cur.push(item);
          changed = true;
        }
      }
      if (changed) body.include = cur;
    }
    if (options?.promptCacheKey && body.prompt_cache_key === undefined) {
      body.prompt_cache_key = options.promptCacheKey;
      changed = true;
    }
  } else if (
    path.endsWith("/chat/completions") ||
    path.includes("/chat/completions")
  ) {
    if (effort) {
      if (forceHigh) {
        if (body.reasoning_effort !== effort) {
          body.reasoning_effort = effort;
          changed = true;
        }
      } else if (body.reasoning_effort === undefined) {
        body.reasoning_effort = effort;
        changed = true;
      }
    }
  }

  if (!changed) return init;
  return { ...init, body: JSON.stringify(body) };
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
