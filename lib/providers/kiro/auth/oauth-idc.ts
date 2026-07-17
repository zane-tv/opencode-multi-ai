import {
  buildKiroAuthUrl,
  KIRO_AUTH_SERVICE,
  normalizeKiroRegion,
  type KiroRegion,
} from "../constants.js";

export type KiroIDCAuthorization = {
  verificationUrl: string;
  verificationUriComplete: string;
  userCode: string;
  deviceCode: string;
  clientId: string;
  clientSecret: string;
  interval: number;
  expiresIn: number;
  region: KiroRegion;
  startUrl: string;
};

export type KiroIDCTokenResult = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  email: string;
  clientId: string;
  clientSecret: string;
  region: KiroRegion;
  authMethod: "idc";
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function authorizeKiroIDC(
  region?: string,
  startUrl?: string,
): Promise<KiroIDCAuthorization> {
  const effectiveRegion = normalizeKiroRegion(region);
  const ssoOIDCEndpoint = buildKiroAuthUrl(
    KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT,
    effectiveRegion,
  );
  const effectiveStartUrl = startUrl || KIRO_AUTH_SERVICE.BUILDER_ID_START_URL;

  const registerResponse = await fetch(`${ssoOIDCEndpoint}/client/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": KIRO_AUTH_SERVICE.USER_AGENT,
    },
    body: JSON.stringify({
      clientName: "Kiro IDE",
      clientType: "public",
      scopes: KIRO_AUTH_SERVICE.SCOPES,
      grantTypes: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
    }),
  });
  if (!registerResponse.ok) {
    const errorText = await registerResponse.text().catch(() => "");
    throw new Error(
      `Client registration failed: ${registerResponse.status} ${errorText}`,
    );
  }
  const registerData = asRecord(await registerResponse.json());
  const clientId = registerData.clientId;
  const clientSecret = registerData.clientSecret;
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new Error(
      "Client registration response missing clientId or clientSecret",
    );
  }

  const deviceAuthResponse = await fetch(
    `${ssoOIDCEndpoint}/device_authorization`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": KIRO_AUTH_SERVICE.USER_AGENT,
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl: effectiveStartUrl,
      }),
    },
  );
  if (!deviceAuthResponse.ok) {
    const errorText = await deviceAuthResponse.text().catch(() => "");
    throw new Error(
      `Device authorization failed: ${deviceAuthResponse.status} ${errorText}`,
    );
  }
  const deviceAuthData = asRecord(await deviceAuthResponse.json());
  const verificationUri = deviceAuthData.verificationUri;
  const verificationUriComplete = deviceAuthData.verificationUriComplete;
  const userCode = deviceAuthData.userCode;
  const deviceCode = deviceAuthData.deviceCode;
  const interval =
    typeof deviceAuthData.interval === "number" ? deviceAuthData.interval : 5;
  const expiresIn =
    typeof deviceAuthData.expiresIn === "number"
      ? deviceAuthData.expiresIn
      : 600;
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof verificationUriComplete !== "string"
  ) {
    throw new Error("Device authorization response missing required fields");
  }

  return {
    verificationUrl: verificationUri,
    verificationUriComplete,
    userCode,
    deviceCode,
    clientId,
    clientSecret,
    interval,
    expiresIn,
    region: effectiveRegion,
    startUrl: effectiveStartUrl,
  };
}

export async function pollKiroIDCToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  region: string,
  options?: { signal?: AbortSignal },
): Promise<KiroIDCTokenResult> {
  if (!clientId || !clientSecret || !deviceCode) {
    throw new Error("Missing required parameters for token polling");
  }
  const effectiveRegion = normalizeKiroRegion(region);
  const ssoOIDCEndpoint = buildKiroAuthUrl(
    KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT,
    effectiveRegion,
  );
  const maxAttempts = Math.floor(expiresIn / interval);
  let currentInterval = interval * 1000;
  let attempts = 0;

  while (attempts < maxAttempts) {
    if (options?.signal?.aborted) {
      throw new Error("Token polling cancelled");
    }
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, currentInterval));
    if (options?.signal?.aborted) {
      throw new Error("Token polling cancelled");
    }

    const tokenResponse = await fetch(`${ssoOIDCEndpoint}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": KIRO_AUTH_SERVICE.USER_AGENT,
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: options?.signal,
    });
    const responseText = await tokenResponse.text().catch(() => "");
    let tokenData: Record<string, unknown> = {};
    if (responseText) {
      try {
        tokenData = asRecord(JSON.parse(responseText));
      } catch {
        throw new Error(
          `Token polling failed: invalid JSON response (HTTP ${tokenResponse.status})`,
        );
      }
    }

    if (typeof tokenData.error === "string") {
      if (tokenData.error === "authorization_pending") continue;
      if (tokenData.error === "slow_down") {
        currentInterval += 5000;
        continue;
      }
      if (tokenData.error === "expired_token") {
        throw new Error(
          "Device code has expired. Please restart the authorization process.",
        );
      }
      if (tokenData.error === "access_denied") {
        throw new Error("Authorization was denied by the user.");
      }
      throw new Error(
        `Token polling failed: ${tokenData.error} - ${String(tokenData.error_description ?? "")}`,
      );
    }

    const accessToken = tokenData.access_token ?? tokenData.accessToken;
    const refreshToken = tokenData.refresh_token ?? tokenData.refreshToken;
    const tokenExpiresIn = tokenData.expires_in ?? tokenData.expiresIn;
    if (typeof accessToken === "string" && typeof refreshToken === "string") {
      const expiresInSeconds =
        typeof tokenExpiresIn === "number" ? tokenExpiresIn : 3600;
      return {
        refreshToken,
        accessToken,
        expiresAt: Date.now() + expiresInSeconds * 1000,
        email: "builder-id@aws.amazon.com",
        clientId,
        clientSecret,
        region: effectiveRegion,
        authMethod: "idc",
      };
    }

    if (!tokenResponse.ok) {
      throw new Error(
        `Token request failed with status: ${tokenResponse.status}`,
      );
    }
    throw new Error("Token polling failed: missing tokens in response");
  }

  throw new Error(
    "Token polling timed out. Authorization may have expired.",
  );
}
