/**
 * Shared SuperGrok OAuth login for plugin + CLI/TUI (no OpenCode host required).
 *
 * - browserLogin: PKCE + loopback callback on 127.0.0.1:56121
 * - deviceCodeLoginFlow: RFC 8628 device code (best for terminals)
 *
 * Upserts into the unified AccountManager with provider "xai".
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

import { OAUTH_SCOPE } from "../constants.js";
import type {
  AccountManager,
  ProviderAccountView,
} from "../../../core/accounts.js";
import type { XaiAccountMetadata } from "../../../core/schemas.js";
import { logger } from "../../../core/logger.js";
import { generatePkce, generateState } from "./pkce.js";
import {
  buildAuthorizeUrl,
  decodeJwt,
  discoverEndpoints,
  exchangeCode,
  extractIdentity,
  type Tokens,
} from "./oauth.js";
import { planFromAccessToken } from "../request/plan.js";
import { fetchGrokUserProfile } from "../request/user-profile.js";
import { waitForCallback } from "./server.js";
import {
  deviceCodeLogin,
  LoginCancelledError,
  type DeviceCodePrompt,
} from "./device-code.js";

export type LoginResult = {
  accountId: string;
  email?: string;
  outcome: "added" | "updated";
};

export type DeviceCodePromptHandler = (p: DeviceCodePrompt) => void;
export { LoginCancelledError } from "./device-code.js";

/** Accept full AccountManager or a provider-scoped view. */
export type XaiLoginTarget = AccountManager | ProviderAccountView;

function asXaiView(target: XaiLoginTarget): ProviderAccountView {
  if ("providerView" in target && typeof target.providerView === "function") {
    return target.providerView("xai");
  }
  const view = target as ProviderAccountView;
  if (view.provider !== "xai") {
    throw new Error(
      `xai login requires provider "xai" (got "${view.provider}")`,
    );
  }
  return view;
}

function accountFromTokens(tokens: Tokens): XaiAccountMetadata {
  const claims = decodeJwt(tokens.accessToken);
  const identity = extractIdentity(claims);
  const now = Date.now();
  const plan = planFromAccessToken(tokens.accessToken, now);
  return {
    provider: "xai",
    accountId: identity.accountId,
    email: identity.email,
    tags: [],
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    oauthScope: OAUTH_SCOPE,
    enabled: true,
    priority: 0,
    addedAt: now,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    planTier: plan.planTier,
    planName: plan.planName,
    planObservedAt: plan.observedAt,
  };
}

/**
 * Persist a freshly minted OAuth session into the pool.
 * Re-login of the same accountId updates tokens instead of failing.
 */
export async function finalizeLoginToPool(
  target: XaiLoginTarget,
  tokens: Tokens,
): Promise<LoginResult> {
  const view = asXaiView(target);
  const account = accountFromTokens(tokens);
  if (!account.email) {
    try {
      const profile = await fetchGrokUserProfile(tokens.accessToken);
      if (profile.email) account.email = profile.email;
    } catch (err) {
      logger.debug(
        `user profile fetch skipped: ${(err as Error).message}`,
      );
    }
  }
  const outcome = await view.upsertFromOAuth(account);
  logger.debug(`OAuth ${outcome} account ${account.accountId}`);
  return {
    accountId: account.accountId,
    email: account.email,
    outcome,
  };
}

/** Best-effort open URL in the default browser (macOS/Linux/Windows). */
export function openInBrowser(url: string): void {
  try {
    const p = platform();
    if (p === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (p === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (err) {
    logger.debug(`openInBrowser failed: ${(err as Error).message}`);
  }
}

export async function browserLogin(
  target: XaiLoginTarget,
  opts?: {
    openBrowser?: boolean;
    onAuthorizeUrl?: (url: string) => void;
    signal?: AbortSignal;
  },
): Promise<LoginResult> {
  if (opts?.signal?.aborted) throw new LoginCancelledError();
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateState();
  const endpoints = await discoverEndpoints();
  const url = buildAuthorizeUrl({
    codeChallenge,
    state,
    authorizeUrl: endpoints.authorizeUrl,
  });

  opts?.onAuthorizeUrl?.(url);
  if (opts?.openBrowser !== false) openInBrowser(url);

  try {
    const { code } = await waitForCallback(state, undefined, opts?.signal);
    if (opts?.signal?.aborted) throw new LoginCancelledError();
    const tokens = await exchangeCode({
      code,
      codeVerifier,
      tokenUrl: endpoints.tokenUrl,
    });
    return finalizeLoginToPool(target, tokens);
  } catch (err) {
    if (
      (err as { name?: string }).name === "AbortError" ||
      (err as Error).message === "login cancelled"
    ) {
      throw new LoginCancelledError();
    }
    throw err;
  }
}

export async function deviceCodeLoginFlow(
  target: XaiLoginTarget,
  onPrompt?: DeviceCodePromptHandler,
  signal?: AbortSignal,
): Promise<LoginResult> {
  if (signal?.aborted) throw new LoginCancelledError();
  try {
    const tokens = await deviceCodeLogin(onPrompt, signal);
    if (signal?.aborted) throw new LoginCancelledError();
    return finalizeLoginToPool(target, tokens);
  } catch (err) {
    if (
      err instanceof LoginCancelledError ||
      (err as { name?: string }).name === "AbortError"
    ) {
      throw new LoginCancelledError();
    }
    throw err;
  }
}
