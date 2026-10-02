/**
 * xAI CLI-proxy transport mode — route inference like the grok CLI.
 *
 * The grok CLI talks to https://cli-chat-proxy.grok.com/v1 with the SAME
 * OAuth access token the pool stores, plus `x-xai-token-auth: xai-grok-cli`
 * (confirmed from grok CLI 1.0.3 binary + ~/.grok/models_cache.json: every
 * model's base_url is the CLI proxy, auth_scheme bearer).
 *
 * api.x.ai rejects subscription tiers without API credits / API entitlement
 * (`personal-team-blocked:spending-limit`, e.g. X Premium+ accounts), while
 * the CLI proxy serves every subscription tier — the CLI works where the API
 * surface does not.
 *
 * Load order:
 *   MULTI_AI_XAI_CLI_PROXY env
 *   > multi-ai-settings.json `xaiCliProxy`
 *   > false
 *
 * Settings path: ~/.config/opencode/multi-ai-settings.json
 * (override with MULTI_AI_SETTINGS_PATH for hermetic tests)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** grok CLI inference base URL (OpenAI-compatible, Responses API supported). */
export const CLI_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";

/** Host used by resolveUrl rewrites and host-pinning. */
export const CLI_PROXY_HOST = "cli-chat-proxy.grok.com";

/** Value for the `x-xai-token-auth` header the grok CLI sends. */
export const CLI_TOKEN_AUTH_VALUE = "xai-grok-cli";

/**
 * `x-grok-client-version` sent to the CLI proxy. The proxy rejects requests
 * without it (HTTP 426 "Your Grok CLI version (none) is outdated. Please
 * update to version 0.1.202 or later"). 1.0.3 is the stable grok CLI release
 * this was verified against; override with MULTI_AI_XAI_CLIENT_VERSION.
 */
export const CLI_CLIENT_VERSION = "1.0.3";

export function cliClientVersion(): string {
  const v = process.env.MULTI_AI_XAI_CLIENT_VERSION?.trim();
  return v && v.length > 0 ? v : CLI_CLIENT_VERSION;
}

/** Origin header sent with CLI-proxy requests (matches grok.com web client). */
export const CLI_PROXY_ORIGIN = "https://grok.com";

/** Referer sent with CLI-proxy requests (matches billing-quota probe). */
export const CLI_PROXY_REFERER = "https://grok.com/?_s=usage";

let cached: boolean | undefined;
let cachedAt = 0;
const CACHE_MS = 2_000;

export function defaultSettingsPath(): string {
  const override = process.env.MULTI_AI_SETTINGS_PATH?.trim();
  if (override) return override;
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-ai-settings.json",
  );
}

function normalizeBool(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on" || v === "proxy") {
    return true;
  }
  if (v === "0" || v === "false" || v === "no" || v === "off" || v === "api") {
    return false;
  }
  return null;
}

function readSettingsCliProxy(): boolean | null {
  try {
    const p = defaultSettingsPath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
      string,
      unknown
    >;
    return normalizeBool(data.xaiCliProxy ?? data.xai_cli_proxy);
  } catch {
    return null;
  }
}

function writeSettingsCliProxy(on: boolean): void {
  try {
    const p = defaultSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let prev: Record<string, unknown> = {};
    try {
      if (fs.existsSync(p)) {
        prev = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
          string,
          unknown
        >;
      }
    } catch {
      prev = {};
    }
    const next = { ...prev, xaiCliProxy: on };
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, p);
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* ignore */
    }
  } catch {
    /* non-fatal */
  }
}

/** True when inference should route through cli-chat-proxy.grok.com. */
export function getXaiCliProxyMode(): boolean {
  const now = Date.now();
  if (cached !== undefined && now - cachedAt < CACHE_MS) return cached;

  const fromEnv = normalizeBool(process.env.MULTI_AI_XAI_CLI_PROXY);
  const on = fromEnv ?? readSettingsCliProxy() ?? false;
  cached = on;
  cachedAt = now;
  return on;
}

export function setXaiCliProxy(on: boolean, persist = true): void {
  cached = on;
  cachedAt = Date.now();
  if (persist) writeSettingsCliProxy(on);
}

export function toggleXaiCliProxy(): boolean {
  const next = !getXaiCliProxyMode();
  setXaiCliProxy(next, true);
  return next;
}

export function resetXaiCliProxyForTests(): void {
  cached = undefined;
  cachedAt = 0;
}
