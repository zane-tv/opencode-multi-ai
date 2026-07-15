import { CODEX_API_HOST, CODEX_RESPONSES_PATH } from "../constants.js";

/**
 * Rewrite an outbound Responses URL for the ChatGPT/Codex backend-api.
 *
 * Rules (native/minimal, matching Codex CLI / oc-codex-multi-auth):
 * - Force `https:`
 * - Force host `chatgpt.com` (`CODEX_API_HOST`)
 * - Strip userinfo (username/password) so credentials never ride the URL
 * - Ensure path is under `/backend-api`
 * - Map `/responses` → `/codex/responses` (never double-prefix `/codex/codex`)
 *
 * Query string and hash are preserved.
 *
 * @example
 * rewriteUrlForCodex("https://api.openai.com/v1/responses")
 * // → "https://chatgpt.com/backend-api/codex/responses"
 */
export function rewriteUrlForCodex(input: string | URL): string {
  const url = typeof input === "string" ? new URL(input) : new URL(input.href);

  url.protocol = "https:";
  url.username = "";
  url.password = "";
  url.host = CODEX_API_HOST;

  let path = url.pathname || "/";

  path = path.replace(/\/v1(?=\/|$)/g, "");

  if (path.includes("/responses") && !path.includes(CODEX_RESPONSES_PATH)) {
    path = path.replace(/\/responses(?=\/|$)/, CODEX_RESPONSES_PATH);
  }

  // Bare root or empty after /v1 strip → codex responses path.
  if (path === "" || path === "/") {
    path = CODEX_RESPONSES_PATH;
  }

  if (!path.startsWith("/backend-api")) {
    path = `/backend-api${path.startsWith("/") ? path : `/${path}`}`;
  }

  // Collapse accidental double slashes (not including protocol).
  path = path.replace(/\/{2,}/g, "/");

  url.pathname = path;
  return url.toString();
}
