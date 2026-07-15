/**
 * Codex provider barrel — constants, request adapters, auth, models, adapter.
 * Plugin entry lives in lib/plugin/codex.ts (not here).
 */

export {
  CLIENT_ID,
  AUTHORIZE_URL,
  TOKEN_URL,
  REDIRECT_URI,
  CALLBACK_HOST,
  CALLBACK_PORT,
  CALLBACK_PATH,
  OAUTH_SCOPE,
  OAUTH_EXTRA_PARAMS,
  DEVICE_USERCODE_URL,
  DEVICE_TOKEN_URL,
  DEVICE_VERIFY_URL,
  CODEX_BASE_URL,
  CODEX_API_HOST,
  CODEX_RESPONSES_PATH,
  DUMMY_API_KEY,
  PROVIDER_ID,
  JWT_CLAIM_PATH,
  TOKEN_REFRESH_SKEW_MS,
  AUTH_FETCH_TIMEOUT_MS,
  MAX_ACCOUNTS,
  AUTH_FAILURE_COOLDOWN_MS,
  MAX_AUTH_FAILURES_BEFORE_REMOVAL,
  DEFAULT_MODELS,
  defaultStoragePath,
  defaultModelsCachePath,
  defaultSettingsPath,
} from "./constants.js";

export { codexAdapter, default as default } from "./adapter.js";

export {
  CODEX_PROVIDER_DEFAULT_OPTIONS,
  resolveCodexMultiModels,
  fetchModelsDevOpenAi,
  fetchLiveCodexModelIds,
  buildEffortVariants,
  scrubCodexEffortVariants,
  readModelsCache,
  writeModelsCache,
  type OpenCodeModelEntry,
  type EffortVariantConfig,
} from "./models-sync.js";

export { rewriteUrlForCodex } from "./request/codex-url.js";
export { createCodexHeaders, type CreateCodexHeadersInput } from "./request/codex-headers.js";
export {
  transformCodexBody,
  transformCodexRequestInit,
  normalizeCodexModel,
  normalizeCodexEffort,
  modelAcceptsMaxEffort,
  forceEffortInBody,
  isUltraEffortRejected,
  bodyRequestsUltraEffort,
  sessionIdFromHeaders,
  CODEX_INCLUDE_ENCRYPTED_REASONING,
  CODEX_MODEL_NORMALIZE,
  CODEX_SUPPORTED_EFFORTS,
  type CodexBodyTransformOptions,
  type CodexSupportedEffort,
} from "./request/body-transform.js";
export {
  classifyResponse,
  classifyThrownError,
  parseRetryAfterMs,
  RATE_LIMIT_RE,
  QUOTA_EXHAUSTED_RE,
  ENTITLEMENT_RE,
  AUTH_DEAD_RE,
  AUTH_DEAD_CODE_RE,
  DEACTIVATED_WORKSPACE_RE,
  SERVER_OVERLOAD_RE,
  type Classification,
} from "./request/classify-error.js";
export {
  fetchCodexUsage,
  parseUsagePayload,
  parseUsageHeaders,
  leftPercent,
  windowLabel,
  isWindowDisabled,
  parseResetAt,
  type CodexUsageSummary,
} from "./request/usage.js";
export { convertSseToJson, extractJsonFromSse } from "./request/sse.js";

export {
  InvalidGrantError,
  TransientAuthError,
  refreshTokens,
  exchangeCode,
  buildAuthorizeUrl,
  identityFromTokens,
  extractIdentity,
  decodeJwt,
  selectBestWorkspace,
  isTrustedEndpoint,
  assertTrustedEndpoint,
  parseTokenResponse,
  type Tokens,
  type Identity,
  type WorkspaceCandidate,
} from "./auth/oauth.js";
export { generatePkce, generateState, type PkcePair } from "./auth/pkce.js";
export { waitForCallback, type CallbackResult } from "./auth/server.js";
export {
  deviceCodeLogin,
  LoginCancelledError,
  type DeviceCodePrompt,
} from "./auth/device-code.js";
export {
  browserLogin,
  deviceCodeLoginFlow,
  finalizeLoginToPool,
  openInBrowser,
  type LoginResult,
  type CodexLoginManager,
} from "./auth/login.js";
export { getFreshTokens, resetRefreshState } from "./auth/refresh.js";
export {
  bootstrapHostAuthIfNeeded,
  ensureHostAuthAfterLogin,
  openCodeAuthPath,
} from "./auth/host-auth.js";
export {
  tokensFromImportObject,
  importOneJsonAccount,
  importAccountsFromJsonText,
  importAccountsFromJsonFile,
  type ImportJsonResult,
  type ImportJsonItemResult,
} from "./auth/import-json.js";
