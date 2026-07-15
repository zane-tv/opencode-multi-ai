/**
 * xAI SuperGrok multi-account provider surface.
 * Plugin entry wires this adapter; CLI/TUI import auth + tools separately.
 */

export { xaiAdapter } from "./adapter.js";
export {
  CLIENT_ID,
  OAUTH_ISSUER,
  OAUTH_DISCOVERY_URL,
  REDIRECT_URI,
  CALLBACK_HOST,
  CALLBACK_PORT,
  CALLBACK_PATH,
  OAUTH_SCOPE,
  OAUTH_EXTRA_PARAMS,
  DEVICE_GRANT_TYPE,
  FALLBACK_AUTHORIZE_URL,
  FALLBACK_TOKEN_URL,
  FALLBACK_DEVICE_CODE_URL,
  XAI_API_BASE,
  XAI_API_HOST,
  PROVIDER_ID,
  TOKEN_REFRESH_SKEW_MS,
  AUTH_FETCH_TIMEOUT_MS,
  MAX_ACCOUNTS,
  DEFAULT_MODELS,
  defaultModelsCachePath,
} from "./constants.js";
export {
  resolveXaiMultiModels,
  fetchModelsDevXai,
  fetchLiveXaiModelIds,
  buildEffortVariants,
  readModelsCache,
  writeModelsCache,
  type OpenCodeModelEntry,
  type EffortVariantConfig,
} from "./models-sync.js";
export {
  browserLogin,
  deviceCodeLoginFlow,
  finalizeLoginToPool,
  openInBrowser,
  LoginCancelledError,
  type LoginResult,
  type DeviceCodePromptHandler,
  type XaiLoginTarget,
} from "./auth/login.js";
export {
  refreshTokens,
  discoverEndpoints,
  exchangeCode,
  decodeJwt,
  extractIdentity,
  InvalidGrantError,
  TransientAuthError,
  type Tokens,
  type OAuthEndpoints,
  type Identity,
} from "./auth/oauth.js";
export { getFreshTokens, resetRefreshState } from "./auth/refresh.js";
export {
  classifyResponse,
  classifyThrownError,
  parseRetryAfterMs,
  RATE_LIMIT_RE,
  QUOTA_EXHAUSTED_RE,
  ENTITLEMENT_RE,
  AUTH_DEAD_RE,
  type Classification,
} from "./request/classify-error.js";
export {
  parseRateLimitHeaders,
  hasRateLimitData,
  formatRemaining,
  formatCostUsd,
  probeAccountRateLimit,
  type RateLimitSnapshot,
} from "./request/rate-limit.js";
export {
  planFromAccessToken,
  fetchGrokPlan,
  planNameFromTier,
  inferPlanNameFromLimit,
  deriveRemainingFromPlanUsage,
  formatPlanLimit,
  type PlanSnapshot,
} from "./request/plan.js";
export {
  fetchGrokBillingQuota,
  parseGrpcWebBillingResponse,
  type BillingQuotaSnapshot,
} from "./request/billing-quota.js";
export { fetchGrokUserProfile, type GrokUserProfile } from "./request/user-profile.js";
export { injectXaiReasoningBody } from "./request/body-bridge.js";
