import {
  AUTH_FETCH_TIMEOUT_MS,
  CLIENT_ID,
  DEVICE_GRANT_TYPE,
  OAUTH_SCOPE,
} from "../constants.js";
import { logger } from "../../../core/logger.js";
import {
  assertTrustedEndpoint,
  discoverEndpoints,
  parseTokenResponse,
  TransientAuthError,
  type Tokens,
} from "./oauth.js";

/**
 * RFC 8628 device authorization flow (headless / SSH friendly).
 *
 * 1. POST the device authorization endpoint to obtain a device_code +
 *    user_code + verification_uri.
 * 2. Print the verification URI and user code for the human to enter.
 * 3. Poll the token endpoint with the device_code grant, honoring the server's
 *    `interval` and any `slow_down` responses, until tokens arrive or the
 *    device code expires.
 */

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface DeviceCodePrompt {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresIn: number;
}

/** Default poll interval (seconds) if the server does not specify one. */
const DEFAULT_INTERVAL_S = 5;

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
 * cleared in finally. A hung device fetch must never wedge the flow.
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

/**
 * Run the full device-code flow. `onPrompt` is invoked once with the
 * verification URI + user code so the caller can display them; if omitted a
 * default message is logged to stderr.
 */
export async function deviceCodeLogin(
  onPrompt?: (p: DeviceCodePrompt) => void,
  signal?: AbortSignal,
): Promise<Tokens> {
  throwIfAborted(signal);
  const endpoints = await discoverEndpoints();
  // Defense in depth (S5): re-assert host-pin before POSTing credentials.
  assertTrustedEndpoint(endpoints.deviceCodeUrl, "device authorization");
  assertTrustedEndpoint(endpoints.tokenUrl, "device token poll");

  const startBody = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: OAUTH_SCOPE,
  });

  const startRes = await fetchWithTimeout(
    endpoints.deviceCodeUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: startBody,
    },
    "device authorization",
  );

  const startText = await startRes.text();
  if (!startRes.ok) {
    throw new Error(
      `device authorization failed with HTTP ${startRes.status}: ${startText}`,
    );
  }

  const auth = JSON.parse(startText) as DeviceAuthResponse;
  const prompt: DeviceCodePrompt = {
    verificationUri: auth.verification_uri,
    verificationUriComplete: auth.verification_uri_complete,
    userCode: auth.user_code,
    expiresIn: auth.expires_in,
  };

  if (onPrompt) {
    onPrompt(prompt);
  } else {
    logger.info(
      `To sign in, open ${prompt.verificationUri} and enter code: ${prompt.userCode}`,
    );
  }

  let intervalMs = (auth.interval ?? DEFAULT_INTERVAL_S) * 1000;
  const deadline = Date.now() + auth.expires_in * 1000;

  // Poll the token endpoint until success, hard error, expiry, or cancel.
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

    const pollBody = new URLSearchParams({
      grant_type: DEVICE_GRANT_TYPE,
      client_id: CLIENT_ID,
      device_code: auth.device_code,
    });

    const res = await fetchWithTimeout(
      endpoints.tokenUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: pollBody,
      },
      "device token poll",
    );

    const text = await res.text();

    if (res.ok) {
      const data = JSON.parse(text) as Record<string, unknown>;
      // Reuse the shared parser (no old refresh token in the device flow).
      return parseTokenResponse(data);
    }

    // RFC 8628 poll errors are carried in the `error` field of a 400 body.
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
      // Server asks us to back off; RFC suggests +5s.
      intervalMs += 5_000;
      continue;
    }
    if (errCode === "expired_token") {
      throw new Error("device code expired before authorization completed");
    }
    if (errCode === "access_denied") {
      throw new Error("device authorization was denied by the user");
    }

    throw new Error(
      `device token poll failed with HTTP ${res.status}: ${text}`,
    );
  }
}
