import type { AccountOf } from "../../../core/schemas.js";

export type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export class KiroTokenRefreshError extends Error {
  readonly code: string;
  constructor(message: string, code: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = "KiroTokenRefreshError";
    this.code = code;
  }
}

export class KiroInvalidGrantError extends KiroTokenRefreshError {
  constructor(message = "refresh token rejected") {
    super(message, "invalid_grant");
    this.name = "KiroInvalidGrantError";
  }
}

const REFRESH_TIMEOUT_MS = 15_000;
const API_KEY_EXPIRES_AT = 4_102_444_800_000;

type KiroAccount = AccountOf<"kiro">;

function createTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function externalIdpRefreshScope(
  tokenEndpoint: string,
  clientId: string,
): string | undefined {
  try {
    const host = new URL(tokenEndpoint).host;
    if (host === "login.microsoftonline.com") {
      return `${clientId}/codewhisperer:conversations ${clientId}/codewhisperer:completions offline_access`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isInvalidGrantBody(text: string, data: Record<string, unknown>): boolean {
  const code = String(data.__type ?? data.error ?? "");
  const message = String(data.message ?? data.error_description ?? text);
  return (
    /invalid_grant|InvalidGrant|ExpiredToken|NotAuthorized/i.test(code) ||
    /invalid_grant|expired.*token|not authorized/i.test(message)
  );
}

export async function refreshKiroAccount(account: KiroAccount): Promise<Tokens> {
  if (account.authMethod === "api-key") {
    const key = account.accessToken || account.refreshToken;
    if (!key.startsWith("ksk_")) {
      throw new KiroTokenRefreshError("Missing API key", "MISSING_CREDENTIALS");
    }
    return {
      accessToken: key,
      refreshToken: key,
      expiresAt: account.expiresAt ?? API_KEY_EXPIRES_AT,
    };
  }

  const isIdc = account.authMethod === "idc";
  const isExternalIdp = account.authMethod === "external-idp";
  const oidcRegion = account.oidcRegion || account.region;
  const url = isExternalIdp
    ? account.tokenEndpoint!
    : isIdc
      ? `https://oidc.${oidcRegion}.amazonaws.com/token`
      : `https://prod.${account.region}.auth.desktop.kiro.dev/refreshToken`;

  if (isIdc && (!account.clientId || !account.clientSecret)) {
    throw new KiroTokenRefreshError("Missing creds", "MISSING_CREDENTIALS");
  }
  if (isExternalIdp && (!account.clientId || !account.tokenEndpoint)) {
    throw new KiroTokenRefreshError(
      "Missing external IdP creds",
      "MISSING_CREDENTIALS",
    );
  }

  const formBody = isExternalIdp
    ? new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        client_id: account.clientId!,
      })
    : undefined;
  const scope =
    isExternalIdp && account.tokenEndpoint && account.clientId
      ? externalIdpRefreshScope(account.tokenEndpoint, account.clientId)
      : undefined;
  if (formBody && scope) formBody.set("scope", scope);

  const requestBody = formBody
    ? formBody.toString()
    : isIdc
      ? {
          refreshToken: account.refreshToken,
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          grantType: "refresh_token",
        }
      : { refreshToken: account.refreshToken };

  const ua =
    isIdc || isExternalIdp
      ? "aws-sdk-js/3.738.0 ua/2.1 os/other lang/js md/browser#unknown_unknown api/sso-oidc#3.738.0 m/E KiroIDE"
      : "aws-sdk-js/3.0.0 KiroIDE-0.1.0 os/macos lang/js md/nodejs/18.0.0";

  const timeout = createTimeoutSignal(REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: timeout.signal,
      headers: {
        "Content-Type": isExternalIdp
          ? "application/x-www-form-urlencoded"
          : "application/json",
        Accept: "application/json",
        "amz-sdk-request": "attempt=1; max=1",
        "x-amzn-kiro-agent-mode": "vibe",
        "user-agent": ua,
        Connection: "close",
      },
      body:
        typeof requestBody === "string"
          ? requestBody
          : JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const txt = await res.text();
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(txt);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        } else {
          data = { message: txt };
        }
      } catch {
        data = { message: txt };
      }
      if (isInvalidGrantBody(txt, data)) {
        throw new KiroInvalidGrantError(
          String(data.message ?? data.error_description ?? txt),
        );
      }
      throw new KiroTokenRefreshError(
        `Refresh failed: ${String(data.message ?? data.error_description ?? txt)}`,
        String(data.__type ?? data.error ?? `HTTP_${res.status}`),
      );
    }

    const payload: unknown = await res.json();
    const d =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const access = d.access_token ?? d.accessToken;
    if (typeof access !== "string" || !access) {
      throw new KiroTokenRefreshError("No access token", "INVALID_RESPONSE");
    }
    const nextRefresh = d.refresh_token ?? d.refreshToken ?? account.refreshToken;
    const expiresIn = Number(d.expires_in ?? d.expiresIn ?? 3600);
    return {
      accessToken: access,
      refreshToken: typeof nextRefresh === "string" ? nextRefresh : account.refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch (error) {
    if (
      error instanceof KiroTokenRefreshError ||
      error instanceof KiroInvalidGrantError
    ) {
      throw error;
    }
    if (
      error instanceof Error &&
      (error.name === "AbortError" || timeout.signal.aborted)
    ) {
      throw new KiroTokenRefreshError(
        `Token refresh timed out after ${REFRESH_TIMEOUT_MS}ms`,
        "TIMEOUT",
        error,
      );
    }
    throw new KiroTokenRefreshError(
      `Token refresh failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined,
    );
  } finally {
    timeout.dispose();
  }
}
