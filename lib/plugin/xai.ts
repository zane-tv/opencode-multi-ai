import type { Plugin } from "@opencode-ai/plugin";

import { toRotationManager } from "../core/account-rotation.js";
import { getAccountManager, type AccountManager } from "../core/accounts.js";
import { logger } from "../core/logger.js";
import { createRotationFetch } from "../core/rotation-fetch.js";
import { rememberSessionOptions } from "../core/session-options.js";
import { xaiAdapter } from "../providers/xai/adapter.js";
import { generatePkce, generateState } from "../providers/xai/auth/pkce.js";
import {
  buildAuthorizeUrl,
  discoverEndpoints,
  exchangeCode,
  type Tokens,
} from "../providers/xai/auth/oauth.js";
import { waitForCallback } from "../providers/xai/auth/server.js";
import {
  deviceCodeLogin,
  type DeviceCodePrompt,
} from "../providers/xai/auth/device-code.js";
import { finalizeLoginToPool } from "../providers/xai/auth/login.js";
import { PROVIDER_ID, XAI_API_BASE } from "../providers/xai/constants.js";
import { resolveXaiMultiModels } from "../providers/xai/models-sync.js";

/**
 * OpenCode plugin entry for the multi-account xAI provider.
 *
 * IMPORTANT EXPORT SHAPE: this module must default-export ONLY a PluginModule
 * `{ id, server }` and must NOT export other plain functions. OpenCode's
 * legacy loader path iterates every module export and may invoke each function
 * as a Plugin; a mismatched function can throw and the whole plugin is silently
 * dropped — which hides auth methods from `auth login`.
 *
 * - Registers provider `xai-multi` with createRotationFetch that owns rotation.
 * - Exposes two OAuth login methods (browser + device code).
 * - Tools land in lib/tools/registry.ts (todo 21); empty map until then.
 */

/** Shape the AuthHook expects a successful OAuth callback to resolve to. */
type OAuthSuccess = {
  type: "success";
  provider?: string;
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
};
type OAuthFailed = { type: "failed" };

/**
 * Decode the freshly minted access token, derive a stable identity, add the
 * account to the pool (idempotent on re-login), and return the OpenCode success
 * result carrying the tokens.
 */
async function finalizeLogin(
  manager: AccountManager,
  tokens: Tokens,
): Promise<OAuthSuccess> {
  let accountId: string | undefined;
  try {
    const result = await finalizeLoginToPool(manager, tokens);
    accountId = result.accountId;
  } catch (err) {
    logger.warn(`could not upsert OAuth account: ${(err as Error).message}`);
  }

  // Only network-sync models after successful login (not on every OpenCode start).
  try {
    await resolveXaiMultiModels({
      accessToken: tokens.accessToken,
      allowNetwork: true,
    });
  } catch (err) {
    logger.debug(
      `post-login model sync failed: ${(err as Error).message}`,
    );
  }

  return {
    type: "success",
    provider: PROVIDER_ID,
    refresh: tokens.refreshToken,
    access: tokens.accessToken,
    expires: tokens.expiresAt,
    accountId,
  };
}

const plugin: Plugin = async () => {
  logger.debug("multi-xai plugin loading (server entry)");
  const manager = getAccountManager();
  await manager.load();
  const customFetch = createRotationFetch(
    xaiAdapter,
    toRotationManager(manager, "xai"),
  );

  return {
    // Ensure provider is present in the live config so auth login + model picker
    // can see xai-multi even if opencode.json(c) was not updated.
    config: async (cfg) => {
      const c = cfg as {
        provider?: Record<string, Record<string, unknown>>;
      };
      if (!c.provider) c.provider = {};
      if (!c.provider[PROVIDER_ID]) c.provider[PROVIDER_ID] = {};
      const p = c.provider[PROVIDER_ID];
      // Match built-in xai: @ai-sdk/xai defaults languageModel() to Responses API.
      if (p.npm === undefined || p.npm === "@ai-sdk/openai-compatible") {
        p.npm = xaiAdapter.npmPackage;
      }
      if (p.name === undefined) p.name = xaiAdapter.displayName;
      if (p.options === undefined || typeof p.options !== "object") {
        p.options = { baseURL: XAI_API_BASE };
      } else {
        const opts = p.options as Record<string, unknown>;
        if (opts.baseURL === undefined) opts.baseURL = XAI_API_BASE;
      }
      // Cold start: cache/defaults only — no models.dev network fetch.
      // Network sync runs after successful auth login (finalizeLogin).
      const existing =
        p.models && typeof p.models === "object"
          ? (p.models as Record<string, unknown>)
          : {};
      p.models = await resolveXaiMultiModels({
        userModels: existing,
        allowNetwork: false,
      });
      logger.debug("multi-xai config hook: provider registered", {
        provider: PROVIDER_ID,
        modelCount: Object.keys(p.models as object).length,
      });
    },

    auth: {
      provider: PROVIDER_ID,
      // AccountManager JSON is canonical; OpenCode's auth store copy is unused
      // by design (loader ignores auth() and uses customFetch for every request).
      loader: async () => ({
        // Dummy key: customFetch overwrites the Authorization header per request.
        apiKey: xaiAdapter.dummyApiKey,
        baseURL: XAI_API_BASE,
        fetch: customFetch,
      }),
      methods: [
        {
          type: "oauth",
          label: "SuperGrok OAuth (browser)",
          async authorize() {
            const { codeVerifier, codeChallenge } = generatePkce();
            const state = generateState();
            const endpoints = await discoverEndpoints();
            const url = buildAuthorizeUrl({
              codeChallenge,
              state,
              authorizeUrl: endpoints.authorizeUrl,
            });

            return {
              url,
              instructions:
                "Open the URL in your browser to sign in to SuperGrok, then return here.",
              method: "auto" as const,
              async callback(): Promise<OAuthSuccess | OAuthFailed> {
                try {
                  const { code } = await waitForCallback(state);
                  const tokens = await exchangeCode({
                    code,
                    codeVerifier,
                    tokenUrl: endpoints.tokenUrl,
                  });
                  return finalizeLogin(manager, tokens);
                } catch (err) {
                  logger.error(
                    `browser OAuth login failed: ${(err as Error).message}`,
                  );
                  return { type: "failed" };
                }
              },
            };
          },
        },
        {
          type: "oauth",
          label: "SuperGrok OAuth (device code)",
          async authorize() {
            // The device flow must obtain a verification URI + user code before
            // it can return url/instructions. Kick off the full login and wait
            // for the first prompt; the polling continues in the background and
            // the returned callback awaits its completion.
            let resolvePrompt!: (p: DeviceCodePrompt) => void;
            const promptReady = new Promise<DeviceCodePrompt>((r) => {
              resolvePrompt = r;
            });

            const login = deviceCodeLogin((p) => resolvePrompt(p)).then(
              (tokens) => ({ ok: true as const, tokens }),
              (error) => ({ ok: false as const, error }),
            );

            // Race the first prompt against an early failure of the flow.
            const winner = await Promise.race([
              promptReady.then((prompt) => ({ prompt })),
              login.then((settled) => ({ settled })),
            ]);

            if ("settled" in winner) {
              // The flow settled before a prompt fired. If it settled OK
              // (tokens obtained before onPrompt ran — unreachable in practice
              // but must not be dropped), finalize on those tokens rather than
              // discarding a valid login. Otherwise report the start failure.
              const settled = winner.settled;
              if (settled.ok) {
                const result = await finalizeLogin(manager, settled.tokens);
                return {
                  url: "",
                  instructions:
                    "Device authorization completed; you are signed in.",
                  method: "auto" as const,
                  async callback(): Promise<OAuthSuccess | OAuthFailed> {
                    return result;
                  },
                };
              }
              logger.error(
                `device OAuth failed to start: ${(settled.error as Error)?.message}`,
              );
              return {
                url: "",
                instructions: "Device authorization failed to start.",
                method: "auto" as const,
                async callback(): Promise<OAuthSuccess | OAuthFailed> {
                  return { type: "failed" };
                },
              };
            }

            const prompt = winner.prompt;
            return {
              url: prompt.verificationUriComplete ?? prompt.verificationUri,
              instructions: `Open ${prompt.verificationUri} and enter code: ${prompt.userCode}`,
              method: "auto" as const,
              async callback(): Promise<OAuthSuccess | OAuthFailed> {
                const settled = await login;
                if (!settled.ok) {
                  logger.error(
                    `device OAuth login failed: ${(settled.error as Error)?.message}`,
                  );
                  return { type: "failed" };
                }
                return finalizeLogin(manager, settled.tokens);
              },
            };
          },
        },
      ],
    },

    // Full tool map lands in todo 21 (lib/tools/registry.ts). Empty until then.
    tool: {},

    // OpenCode keys providerOptions as "xai-multi"; @ai-sdk/xai only reads "xai".
    // Stash variant options here; rotation-fetch injects reasoning into Responses body.
    "chat.params": async (input, output) => {
      if (input.model.providerID !== PROVIDER_ID) return;
      rememberSessionOptions(input.sessionID, output.options ?? {});
    },

    // v1: log-only. Rotation happens in createRotationFetch, NOT via events.
    async event({ event }) {
      if (event.type === "session.error") {
        logger.debug("session.error event observed", event);
      }
    },
  };
};

/**
 * Default export in the installed PluginModule shape `{ id, server }`.
 * This is the ONLY export from this module — do not add named function exports
 * (OpenCode legacy loader may call them as plugins and silently drop us).
 */
export default { id: PROVIDER_ID, server: plugin };
