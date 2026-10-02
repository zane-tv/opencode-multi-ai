/**
 * Shared Antigravity (Google Cloud Code / Gemini) OAuth login for plugin + CLI/TUI.
 *
 * - browserLogin: Google OAuth with loopback callback on 127.0.0.1:8085/oauth/callback
 */

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";

import type {
  AccountManager,
  ProviderAccountView,
} from "../../../core/accounts.js";
import { logger } from "../../../core/logger.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  finalizeAntigravityLogin,
  waitForOAuthCallback,
} from "./oauth.js";

export type AntigravityLoginTarget = AccountManager | ProviderAccountView;

export type LoginResult = {
  accountId: string;
  email?: string;
  outcome: "added" | "updated";
};

export class LoginCancelledError extends Error {
  constructor(message = "login cancelled") {
    super(message);
    this.name = "LoginCancelledError";
  }
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
 * Browser OAuth login for Antigravity (Google Cloud Code).
 * Opens the Google consent page, listens for loopback on port 8085, exchanges code,
 * and upserts the account into the pool.
 */
export async function browserLogin(
  target: AntigravityLoginTarget,
  opts?: {
    openBrowser?: boolean;
    onAuthorizeUrl?: (url: string) => void;
    signal?: AbortSignal;
    port?: number;
  },
): Promise<LoginResult> {
  if (opts?.signal?.aborted) throw new LoginCancelledError();

  const state = crypto.randomBytes(16).toString("hex");
  const port = opts?.port ?? 8085;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  const url = buildAuthorizeUrl({ state, redirectUri });

  opts?.onAuthorizeUrl?.(url);
  if (opts?.openBrowser !== false) {
    openInBrowser(url);
  }

  try {
    const { code } = await waitForOAuthCallback(state, port, opts?.signal);
    if (opts?.signal?.aborted) throw new LoginCancelledError();

    const tokens = await exchangeCode({ code, redirectUri });
    const account = await finalizeAntigravityLogin(target, tokens);

    return {
      accountId: account.accountId,
      email: account.email,
      outcome: account.outcome ?? "added",
    };
  } catch (err) {
    if (
      (err as { name?: string }).name === "AbortError" ||
      (err as { name?: string }).name === "LoginCancelledError" ||
      (err as Error).message === "login cancelled" ||
      opts?.signal?.aborted
    ) {
      throw new LoginCancelledError();
    }
    throw err;
  }
}
