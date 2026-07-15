/**
 * Shared Codex / ChatGPT OAuth login for plugin + CLI/TUI (no OpenCode host required).
 *
 * - browserLogin: PKCE + loopback callback on 127.0.0.1:1455/auth/callback
 * - deviceCodeLoginFlow: OpenAI deviceauth (usercode → poll → code exchange)
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

import { OAUTH_SCOPE, PROVIDER_ID } from "../constants.js";
import type {
  AccountManager,
  ProviderAccountView,
} from "../../../core/accounts.js";
import type { CodexAccountMetadata } from "../../../core/schemas.js";
import { logger } from "../../../core/logger.js";
import { generatePkce, generateState } from "./pkce.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  identityFromTokens,
  type Tokens,
} from "./oauth.js";
import { waitForCallback } from "./server.js";
import {
  deviceCodeLogin,
  LoginCancelledError,
  type DeviceCodePrompt,
} from "./device-code.js";
import { ensureHostAuthAfterLogin } from "./host-auth.js";

/** Manager surface used by login/import (full manager or codex provider view). */
export type CodexLoginManager =
  | ProviderAccountView
  | Pick<
      AccountManager,
      | "upsertFromOAuth"
      | "setLabel"
      | "setTags"
      | "setNote"
      | "setEmail"
      | "list"
    >;

export type LoginResult = {
  accountId: string;
  email?: string;
  outcome: "added" | "updated";
};

export type DeviceCodePromptHandler = (p: DeviceCodePrompt) => void;
export { LoginCancelledError } from "./device-code.js";

function accountFromTokens(tokens: Tokens): CodexAccountMetadata {
  const identity = identityFromTokens(tokens);
  const now = Date.now();
  return {
    provider: "codex",
    accountId: identity.accountId,
    email: identity.email,
    organizationId: identity.organizationId,
    tags: [],
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    oauthScope: tokens.scope ?? OAUTH_SCOPE,
    enabled: true,
    priority: 0,
    addedAt: now,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
  };
}

/**
 * Persist a freshly minted OAuth session into the pool.
 * Re-login of the same accountId updates tokens instead of failing.
 * One login = one account (best workspace already selected in extractIdentity).
 */
export async function finalizeLoginToPool(
  manager: CodexLoginManager,
  tokens: Tokens,
): Promise<LoginResult> {
  const account = accountFromTokens(tokens);
  const outcome =
    "provider" in manager && manager.provider === "codex"
      ? await manager.upsertFromOAuth(account)
      : await (manager as AccountManager).upsertFromOAuth("codex", account);
  logger.debug(`OAuth ${outcome} account ${account.accountId}`);
  ensureHostAuthAfterLogin(PROVIDER_ID, account.accountId);
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

/**
 * Browser PKCE loopback login. Opens the authorize URL, waits for callback,
 * exchanges code, upserts pool.
 */
export async function browserLogin(
  manager: CodexLoginManager,
  opts?: {
    openBrowser?: boolean;
    onAuthorizeUrl?: (url: string) => void;
    signal?: AbortSignal;
    /** Force prompt=login when adding another account. */
    forceNewLogin?: boolean;
  },
): Promise<LoginResult> {
  if (opts?.signal?.aborted) throw new LoginCancelledError();
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateState();
  const url = buildAuthorizeUrl({
    codeChallenge,
    state,
    forceNewLogin: opts?.forceNewLogin,
  });

  opts?.onAuthorizeUrl?.(url);
  if (opts?.openBrowser !== false) openInBrowser(url);

  try {
    const { code } = await waitForCallback(state, undefined, opts?.signal);
    if (opts?.signal?.aborted) throw new LoginCancelledError();
    const tokens = await exchangeCode({
      code,
      codeVerifier,
    });
    return finalizeLoginToPool(manager, tokens);
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

/**
 * Device-code login. `onPrompt` receives verification URI + user code once;
 * then polls until authorized or expired.
 */
export async function deviceCodeLoginFlow(
  manager: CodexLoginManager,
  onPrompt?: DeviceCodePromptHandler,
  signal?: AbortSignal,
): Promise<LoginResult> {
  if (signal?.aborted) throw new LoginCancelledError();
  try {
    const tokens = await deviceCodeLogin(onPrompt, signal);
    if (signal?.aborted) throw new LoginCancelledError();
    return finalizeLoginToPool(manager, tokens);
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
