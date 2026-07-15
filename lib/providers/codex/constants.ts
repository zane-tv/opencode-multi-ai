import os from "node:os";
import path from "node:path";

/**
 * ChatGPT / Codex OAuth + API constants.
 *
 * These values are PUBLIC and must match the official Codex CLI client
 * (and oc-codex-multi-auth). Do NOT invent alternate client ids, redirect
 * ports, or authorize extras — wrong values brick the OAuth loopback flow.
 */

/** Public Codex CLI OAuth client id. */
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Authorization endpoint (auth.openai.com). */
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";

/** Token endpoint (auth.openai.com). */
export const TOKEN_URL = "https://auth.openai.com/oauth/token";

/**
 * Loopback redirect URI. Port and path are registered with the OAuth client
 * and must match EXACTLY (localhost:1455 + /auth/callback).
 */
export const REDIRECT_URI = "http://localhost:1455/auth/callback";

/**
 * Loopback callback bind host. Server later also accepts ::1; constant is
 * the primary IPv4 bind address.
 */
export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";

/** OAuth scopes (Codex CLI). */
export const OAUTH_SCOPE = "openid profile email offline_access";

/**
 * Extra authorize params required by the Codex simplified OAuth flow.
 */
export const OAUTH_EXTRA_PARAMS: Record<string, string> = {
  id_token_add_organizations: "true",
  codex_cli_simplified_flow: "true",
  originator: "codex_cli_rs",
};

/** Device-auth: request user code. */
export const DEVICE_USERCODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";

/** Device-auth: poll for authorization_code. */
export const DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";

/** Device-auth: human verify URL (browser). */
export const DEVICE_VERIFY_URL = "https://auth.openai.com/codex/device";

/** ChatGPT backend-api base (runtime baseURL for auth.loader). */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** ChatGPT API host used after URL rewrite (token leak guard target). */
export const CODEX_API_HOST = "chatgpt.com";

/** Responses path after rewrite: /responses → /codex/responses. */
export const CODEX_RESPONSES_PATH = "/codex/responses";

/**
 * Dummy API key for `@ai-sdk/openai` construction only.
 * Real bearer is always overwritten in customFetch (same pattern as
 * oc-codex-multi-auth's `chatgpt-oauth`). Never a real OpenAI Platform key.
 */
export const DUMMY_API_KEY = "chatgpt-oauth";

/** Custom provider id. Do NOT override the built-in `openai` provider. */
export const PROVIDER_ID = "codex-multi";

/**
 * JWT claim path for ChatGPT account identity (`chatgpt_account_id`).
 * Nested under this URL-shaped claim key on the access/id token.
 */
export const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/**
 * Refresh access tokens this many ms BEFORE their real expiry, to avoid
 * racing the expiry boundary.
 */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * Timeout for OAuth/token HTTP requests. Node's fetch has no default timeout;
 * without this a hung request could wedge the single-flight refresh promise.
 */
export const AUTH_FETCH_TIMEOUT_MS = 30_000;

/** Maximum number of accounts allowed in the pool. */
export const MAX_ACCOUNTS = 20;

/**
 * After an auth failure, cool the account down this long before it is
 * selectable again (rotate-first; only escalate after repeated failures).
 */
export const AUTH_FAILURE_COOLDOWN_MS = 30_000;

/**
 * Consecutive auth failures before the account is treated as permanently
 * dead / removable (invalid_grant path still marks dead immediately).
 */
export const MAX_AUTH_FAILURES_BEFORE_REMOVAL = 3;

/**
 * Default chat models for the codex-multi provider (seed catalog).
 * Network sync may extend this after successful OAuth. Image-only models
 * are omitted — add them in opencode.json if needed.
 */
const CODEX_CHAT_MODALITIES = {
  input: ["text", "image"] as string[],
  output: ["text"] as string[],
};

const REASONING_VARIANTS_XHIGH = {
  none: { reasoningEffort: "none" },
  minimal: { reasoningEffort: "minimal" },
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
  xhigh: { reasoningEffort: "xhigh" },
} as const;

const REASONING_VARIANTS_SOL = {
  ...REASONING_VARIANTS_XHIGH,
  max: { reasoningEffort: "max" },
} as const;

const LIMIT_CODEX = { context: 400_000, output: 128_000 };
const LIMIT_LARGE = { context: 1_050_000, output: 128_000 };

export const DEFAULT_MODELS: Record<
  string,
  {
    name: string;
    attachment?: boolean;
    reasoning?: boolean;
    limit?: { context: number; output: number };
    modalities?: { input?: string[]; output?: string[] };
    variants?: Record<
      string,
      { reasoningEffort: string } | { disabled: true }
    >;
  }
> = {
  "gpt-5-codex": {
    name: "GPT-5 Codex",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_CODEX,
    variants: { ...REASONING_VARIANTS_XHIGH },
  },
  "gpt-5.1-codex": {
    name: "GPT-5.1 Codex",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_CODEX,
    variants: { ...REASONING_VARIANTS_XHIGH },
  },
  "gpt-5.1-codex-mini": {
    name: "GPT-5.1 Codex Mini",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_CODEX,
    variants: { ...REASONING_VARIANTS_XHIGH },
  },
  "gpt-5.1-codex-max": {
    name: "GPT-5.1 Codex Max",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_CODEX,
    variants: { ...REASONING_VARIANTS_XHIGH },
  },
  "gpt-5.1": {
    name: "GPT-5.1",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_CODEX,
    variants: { ...REASONING_VARIANTS_XHIGH },
  },
  "gpt-5.5": {
    name: "GPT-5.5",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_LARGE,
    variants: { ...REASONING_VARIANTS_XHIGH },
  },
  "gpt-5.4-mini": {
    name: "GPT-5.4 Mini",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_CODEX,
    variants: { ...REASONING_VARIANTS_XHIGH },
  },
  "gpt-5.4-nano": {
    name: "GPT-5.4 Nano",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_CODEX,
    variants: { ...REASONING_VARIANTS_XHIGH },
  },
  "gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_LARGE,
    variants: { ...REASONING_VARIANTS_SOL },
  },
  "gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_LARGE,
    // Live probe (Plus): max accepted; ultra rejected; minimal rejected.
    variants: { ...REASONING_VARIANTS_SOL },
  },
  "gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    attachment: true,
    reasoning: true,
    modalities: CODEX_CHAT_MODALITIES,
    limit: LIMIT_LARGE,
    variants: { ...REASONING_VARIANTS_SOL },
  },
};

/**
 * Unified account storage path (shared with xAI).
 * Prefer importing from `lib/core/paths.js` in new code.
 */
export function defaultStoragePath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-ai-accounts.json",
  );
}

/**
 * Cached models catalog: ~/.config/opencode/multi-ai-models-codex.json
 * Per-provider cache (unified accounts file is separate).
 */
export function defaultModelsCachePath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-ai-models-codex.json",
  );
}

/**
 * UI settings live in the unified multi-ai-settings.json (core i18n).
 * Kept as a thin alias for any leftover callers.
 */
export function defaultSettingsPath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-ai-settings.json",
  );
}
