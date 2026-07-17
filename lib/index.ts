/**
 * Public barrel for the multi-ai shared library.
 *
 * Plugin entries live under `lib/plugin/{xai,codex}.ts` and are NOT re-exported
 * here (OpenCode must load them as dedicated modules with only a default
 * `{ id, server }` export).
 */

export type {
  ProviderKind,
  ProviderId,
  AdapterHeadersInit,
  Classification,
  SuccessRecordSink,
  BuildHeadersContext,
  TransformBodyContext,
  RecordSuccessContext,
  ResolveModelsOptions,
  ProviderAdapter,
  ProviderDescriptor,
  HttpTransportAdapter,
  ProviderTransport,
  TransportProviderAdapter,
  AnyProviderAdapter,
  ProviderFetchContext,
  FetchLike,
} from "./core/adapter.js";
export { assertNever, isProviderAdapter } from "./core/adapter.js";
export { createProviderFetch } from "./core/provider-fetch.js";

export type { SessionRequestOptions } from "./core/session-options.js";
export {
  rememberSessionOptions,
  getSessionOptions,
  clearSessionOptions,
  sessionIdFromHeaders,
} from "./core/session-options.js";

export { logger, type Logger } from "./core/logger.js";

export type { Locale } from "./core/i18n.js";
export {
  ensureLocaleLoaded,
  getLocale,
  setLocale,
  toggleLocale,
  t,
  localeLabel,
  settingsPath,
  defaultSettingsPath,
} from "./core/i18n.js";

export {
  formatDateTime,
  formatDate,
  formatAge,
  formatUntil,
  formatPeriodEnd,
} from "./core/format-time.js";

export type {
  StatusAccount,
  PoolStatusSummary,
  RenderStatusOptions,
} from "./core/tui-status.js";
export {
  isSelectableAccount,
  shortAccountId,
  accountDisplayName,
  summarizePool,
  renderStatusLine,
} from "./core/tui-status.js";

export type {
  RotationAccount,
  RotationManager,
} from "./core/rotation-fetch.js";
export {
  TRANSIENT_BACKOFF_MS,
  NETWORK_BACKOFF_MS,
  QUOTA_FALLBACK_MS,
  AUTH_COOLDOWN_MS,
  InvalidGrantError,
  isInvalidGrantError,
  buildExhaustedResponse,
  createRotationFetch,
} from "./core/rotation-fetch.js";

export { toRotationManager } from "./core/account-rotation.js";
