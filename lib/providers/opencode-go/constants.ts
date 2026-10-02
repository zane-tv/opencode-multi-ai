/**
 * opencode-go provider constants.
 *
 * Rotation is MANUAL config-file rotation: the active pool key is mirrored
 * into OpenCode's auth.json (entry `opencode-go`, shape { type: "api", key })
 * and the instance is reloaded. The built-in `opencode-go` OpenCode provider
 * (serving glm-5.2 via BASE_URL) handles actual requests — no HTTP proxy,
 * no OAuth.
 */

export const PROVIDER_ID = "opencode-go-multi";
export const PROVIDER_KIND = "opencode-go" as const;
export const BASE_URL = "https://opencode.ai/zen/go/v1";
export const AUTH_JSON_KEY = "opencode-go";
export const MODELS_CACHE = "multi-ai-models-opencode-go.json";
export const DISPLAY_NAME = "OpenCode Go";
export const DUMMY_API_KEY = "opencode-go-multi-dummy";
