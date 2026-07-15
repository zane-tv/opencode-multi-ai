import {
  AUTH_FETCH_TIMEOUT_MS,
  CLIENT_ID,
  DEVICE_TOKEN_URL,
  DEVICE_USERCODE_URL,
  DEVICE_VERIFY_URL,
  TOKEN_URL,
} from "../constants.js";
import { logger } from "../../../core/logger.js";
import {
  assertTrustedEndpoint,
  exchangeCode,
  TransientAuthError,
  type Tokens,
} from "./oauth.js";

/**
 * OpenAI / Codex device-auth flow (NOT RFC 8628 device_code grant).
 *
 * 1. POST DEVICE_USERCODE_URL with { client_id } → device_auth_id + user_code
 * 2. Prompt human to open DEVICE_VERIFY_URL and enter user_code
 * 3. Poll DEVICE_TOKEN_URL with { device_auth_id, user_code } until
 *    authorization_code + code_verifier arrive
 * 4. exchangeCode(authorization_code, code_verifier) against TOKEN_URL
 *    (device redirect URI: https://auth.openai.com/deviceauth/callback)
 */

/** Device flow token exchange uses the auth-server device callback, not loopback. */
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";

export interface DeviceCodePrompt {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  /** Seconds until the user code expires (best-effort; default ~15 min). */
  expiresIn: number;
}

/** Default poll interval (seconds) if the server does not specify one. */
const DEFAULT_INTERVAL_S = 5;
/** Max wait for human authorization (~15 minutes). */
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000;

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** User-facing cancel (Esc in TUI / AbortSignal). */
export class LoginCancelledError extends Error {
  constructor(message = "login cancelled") {
    super(message);
    this.name = "LoginCancelledError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LoginCancelledError();
  }
}

/**
 * fetch with an AbortController timeout. On timeout (or network failure) the
 * request is aborted and a TransientAuthError is thrown; the timer is always
 * cleared in finally.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new TransientAuthError(
        `${what} timed out after ${AUTH_FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw new TransientAuthError(
      `network error during ${what}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseIntervalSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string") {
    const n = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(n) && n > 0) return Math.max(1, n);
  }
  return DEFAULT_INTERVAL_S;
}

interface UsercodeSession {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

function parseUsercodeResponse(raw: unknown): UsercodeSession | null {
  if (!isRecord(raw)) return null;
  const deviceAuthId =
    typeof raw.device_auth_id === "string" && raw.device_auth_id.trim()
      ? raw.device_auth_id.trim()
      : undefined;
  const userCode =
    typeof raw.user_code === "string" && raw.user_code.trim()
      ? raw.user_code.trim()
      : typeof raw.usercode === "string" && raw.usercode.trim()
        ? raw.usercode.trim()
        : undefined;
  if (!deviceAuthId || !userCode) return null;
  return {
    deviceAuthId,
    userCode,
    intervalSeconds: parseIntervalSeconds(raw.interval),
  };
}

interface PollAuthPayload {
  authorizationCode: string;
  codeVerifier: string;
}

function parsePollResponse(raw: unknown): PollAuthPayload | null {
  if (!isRecord(raw)) return null;
  const authorizationCode =
    typeof raw.authorization_code === "string" && raw.authorization_code.trim()
      ? raw.authorization_code.trim()
      : undefined;
  const codeVerifier =
    typeof raw.code_verifier === "string" && raw.code_verifier.trim()
      ? raw.code_verifier.trim()
      : undefined;
  if (!authorizationCode || !codeVerifier) return null;
  return { authorizationCode, codeVerifier };
}

/**
 * Run the full OpenAI device-auth flow. `onPrompt` is invoked once with the
 * verification URI + user code so the caller can display them; if omitted a
 * default message is logged to stderr.
 */
export async function deviceCodeLogin(
  onPrompt?: (p: DeviceCodePrompt) => void,
  signal?: AbortSignal,
): Promise<Tokens> {
  throwIfAborted(signal);

  assertTrustedEndpoint(DEVICE_USERCODE_URL, "device usercode");
  assertTrustedEndpoint(DEVICE_TOKEN_URL, "device token poll");
  assertTrustedEndpoint(TOKEN_URL, "device code exchange");

  const startRes = await fetchWithTimeout(
    DEVICE_USERCODE_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    },
    "device usercode",
  );

  const startText = await startRes.text();
  if (!startRes.ok) {
    throw new Error(
      `device usercode failed with HTTP ${startRes.status}: ${startText}`,
    );
  }

  let startJson: unknown;
  try {
    startJson = JSON.parse(startText);
  } catch {
    throw new Error("device usercode returned non-JSON body");
  }

  const session = parseUsercodeResponse(startJson);
  if (!session) {
    throw new Error(
      "device usercode response missing device_auth_id or user_code",
    );
  }

  const verificationUri = DEVICE_VERIFY_URL;
  // Best-effort deep link; verify UI may ignore query params.
  const verificationUriComplete = `${DEVICE_VERIFY_URL}?user_code=${encodeURIComponent(session.userCode)}`;
  const expiresIn = Math.floor(DEFAULT_MAX_WAIT_MS / 1000);

  const prompt: DeviceCodePrompt = {
    verificationUri,
    verificationUriComplete,
    userCode: session.userCode,
    expiresIn,
  };

  if (onPrompt) {
    onPrompt(prompt);
  } else {
    logger.info(
      `To sign in, open ${prompt.verificationUri} and enter code: ${prompt.userCode}`,
    );
  }

  let intervalMs = session.intervalSeconds * 1000;
  const deadline = Date.now() + DEFAULT_MAX_WAIT_MS;

  for (;;) {
    throwIfAborted(signal);
    if (Date.now() >= deadline) {
      throw new Error("device code expired before authorization completed");
    }

    try {
      await delay(intervalMs, signal);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new LoginCancelledError();
      }
      throw err;
    }
    throwIfAborted(signal);

    const res = await fetchWithTimeout(
      DEVICE_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          device_auth_id: session.deviceAuthId,
          user_code: session.userCode,
        }),
      },
      "device token poll",
    );

    // Pending: server returns 403/404 while user has not finished yet.
    if (res.status === 403 || res.status === 404) {
      continue;
    }

    const text = await res.text();

    if (res.ok) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("device token poll returned non-JSON body");
      }
      const parsed = parsePollResponse(json);
      if (!parsed) {
        throw new Error(
          "device token poll missing authorization_code or code_verifier",
        );
      }
      return exchangeCode({
        code: parsed.authorizationCode,
        codeVerifier: parsed.codeVerifier,
        redirectUri: DEVICE_REDIRECT_URI,
        tokenUrl: TOKEN_URL,
      });
    }

    // Some servers still return RFC-style error codes in a 400 body.
    let errCode = "";
    try {
      errCode = String(
        (JSON.parse(text) as Record<string, unknown>)["error"] ?? "",
      );
    } catch {
      errCode = "";
    }

    if (errCode === "authorization_pending") {
      continue;
    }
    if (errCode === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (errCode === "expired_token") {
      throw new Error("device code expired before authorization completed");
    }
    if (errCode === "access_denied") {
      throw new Error("device authorization was denied by the user");
    }

    if (res.status >= 500) {
      throw new TransientAuthError(
        `device token poll failed with HTTP ${res.status}`,
        res.status,
        text,
      );
    }

    throw new Error(
      `device token poll failed with HTTP ${res.status}: ${text}`,
    );
  }
}
