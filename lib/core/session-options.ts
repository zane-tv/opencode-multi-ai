/**
 * Bridges OpenCode variant options into provider Responses requests.
 *
 * Built-in providers use SDK-native providerOptions keys (`xai` / `openai`).
 * Our custom ids (`xai-multi` / `codex-multi`) wrap options under those keys,
 * so the SDK ignores them. We stash selected session options here and re-apply
 * them in the rotation fetch via each adapter's `transformBody`.
 */

export type SessionRequestOptions = {
  reasoningEffort?: string;
  reasoningSummary?: string;
  store?: boolean;
  include?: string[];
  promptCacheKey?: string;
};

// sessionID → last options observed by chat.params for that session.
const bySession = new Map<string, SessionRequestOptions>();
// Fallback when the outbound request has no session header.
let lastOptions: SessionRequestOptions | undefined;

export function rememberSessionOptions(
  sessionID: string | undefined,
  options: Record<string, unknown>,
): void {
  const next = pickOptions(options);
  if (!next) return;
  lastOptions = next;
  if (sessionID) bySession.set(sessionID, next);
}

export function getSessionOptions(
  sessionID: string | undefined,
): SessionRequestOptions | undefined {
  if (sessionID) {
    const hit = bySession.get(sessionID);
    if (hit) return hit;
  }
  return lastOptions;
}

export function clearSessionOptions(sessionID?: string): void {
  if (sessionID) bySession.delete(sessionID);
  else {
    bySession.clear();
    lastOptions = undefined;
  }
}

/**
 * Extract a session id from common OpenCode / chat header names.
 * Pure: no I/O.
 */
export function sessionIdFromHeaders(
  headers: Headers | Record<string, string> | Array<[string, string]> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const h = headers instanceof Headers ? headers : new Headers(headers);
  const raw =
    h.get("x-session-id") ??
    h.get("x-opencode-session") ??
    h.get("session-id") ??
    h.get("session_id") ??
    undefined;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function pickOptions(
  options: Record<string, unknown>,
): SessionRequestOptions | undefined {
  const out: SessionRequestOptions = {};
  if (typeof options.reasoningEffort === "string") {
    out.reasoningEffort = options.reasoningEffort;
  }
  if (typeof options.reasoningSummary === "string") {
    out.reasoningSummary = options.reasoningSummary;
  }
  if (typeof options.store === "boolean") out.store = options.store;
  if (Array.isArray(options.include)) {
    out.include = options.include.filter(
      (v): v is string => typeof v === "string",
    );
  }
  if (typeof options.promptCacheKey === "string") {
    out.promptCacheKey = options.promptCacheKey;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
