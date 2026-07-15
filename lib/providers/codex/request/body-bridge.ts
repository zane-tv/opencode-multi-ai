/**
 * Compatibility re-export.
 *
 * Codex native transform lives in `body-transform.ts`. This module remains so
 * existing imports (fetch.ts, body-bridge tests) keep resolving. Prefer
 * importing from body-transform directly.
 */

export {
  sessionIdFromHeaders,
  transformCodexBody,
  transformCodexRequestInit,
  normalizeCodexModel,
  CODEX_INCLUDE_ENCRYPTED_REASONING,
  CODEX_MODEL_NORMALIZE,
  type CodexBodyTransformOptions,
} from "./body-transform.js";
