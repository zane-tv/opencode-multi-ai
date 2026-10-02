import type { Plugin } from "@opencode-ai/plugin";
import crypto from "node:crypto";
import { getAccountManager } from "../core/accounts.js";
import { logger } from "../core/logger.js";
import { createProviderFetch } from "../core/provider-fetch.js";
import { createAntigravityAdapter } from "../providers/antigravity/adapter.js";
import { bootstrapHostAuthIfNeeded } from "../providers/codex/auth/host-auth.js";
import {
  ANTIGRAVITY_BASE_URL,
  DUMMY_API_KEY,
  PROVIDER_ID,
} from "../providers/antigravity/constants.js";
import { resolveAntigravityMultiModels } from "../providers/antigravity/models-sync.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  finalizeAntigravityLogin,
  waitForOAuthCallback,
} from "../providers/antigravity/auth/oauth.js";
import { importAntigravityFrom9Router } from "../providers/antigravity/auth/import-9router.js";
import { startAntigravityBackgroundPrewarm } from "../providers/antigravity/auth/prewarm.js";
import { ensureBundledSkillsInstalled } from "../core/skills-sync.js";

type OAuthSuccess = {
  type: "success";
  provider?: string;
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
};
type OAuthFailed = { type: "failed" };

const plugin: Plugin = async () => {
  logger.debug("multi-antigravity plugin loading (server entry)");
  void ensureBundledSkillsInstalled();
  bootstrapHostAuthIfNeeded(PROVIDER_ID, DUMMY_API_KEY);
  const manager = getAccountManager();
  await manager.load();
  startAntigravityBackgroundPrewarm(manager);

  const adapter = createAntigravityAdapter();
  const customFetch = createProviderFetch(adapter, manager);

  return {
    config: async (cfg) => {
      const c = cfg as {
        provider?: Record<string, Record<string, unknown>>;
      };
      if (!c.provider) c.provider = {};
      if (!c.provider[PROVIDER_ID]) c.provider[PROVIDER_ID] = {};
      const p = c.provider[PROVIDER_ID];

      if (p.npm === undefined) p.npm = adapter.npmPackage;
      if (p.name === undefined) p.name = adapter.displayName;

      if (p.options === undefined || typeof p.options !== "object") {
        p.options = {
          baseURL: ANTIGRAVITY_BASE_URL,
          apiKey: DUMMY_API_KEY,
          accountSelectionStrategy: "sticky",
        };
      } else {
        const opts = p.options as Record<string, unknown>;
        if (opts.baseURL === undefined) opts.baseURL = ANTIGRAVITY_BASE_URL;
        if (opts.apiKey === undefined) opts.apiKey = DUMMY_API_KEY;
        if (opts.accountSelectionStrategy === undefined) {
          opts.accountSelectionStrategy = "sticky";
        }
      }

      const existing =
        p.models && typeof p.models === "object"
          ? (p.models as Record<string, unknown>)
          : {};

      p.models = await resolveAntigravityMultiModels({
        userModels: existing,
        allowNetwork: false,
      });

      logger.debug("multi-antigravity config hook: provider registered", {
        provider: PROVIDER_ID,
        modelCount: Object.keys(p.models as object).length,
      });
    },

    auth: {
      provider: PROVIDER_ID,
      loader: async () => ({
        apiKey: DUMMY_API_KEY,
        baseURL: ANTIGRAVITY_BASE_URL,
        fetch: customFetch,
      }),
      methods: [
        {
          type: "oauth",
          label: "Antigravity Google OAuth (Browser)",
          async authorize() {
            const state = crypto.randomBytes(16).toString("hex");
            const port = 8085;
            const redirectUri = `http://localhost:${port}/oauth/callback`;
            const url = buildAuthorizeUrl({ state, redirectUri });

            return {
              url,
              instructions:
                "Đăng nhập tài khoản Google Antigravity trong trình duyệt, sau đó quay lại đây.",
              method: "auto" as const,
              async callback(): Promise<OAuthSuccess | OAuthFailed> {
                try {
                  const { code } = await waitForOAuthCallback(state, port);
                  const tokens = await exchangeCode({ code, redirectUri });
                  const account = await finalizeAntigravityLogin(manager, tokens);
                  return {
                    type: "success",
                    provider: PROVIDER_ID,
                    refresh: account.refreshToken,
                    access: account.accessToken || "",
                    expires: account.expiresAt || Date.now() + 3600_000,
                    accountId: account.accountId,
                  };
                } catch (err) {
                  logger.error(`Antigravity OAuth error: ${(err as Error).message}`);
                  return { type: "failed" };
                }
              },
            };
          },
        },
        {
          type: "oauth",
          label: "Import Accounts from 9Router (Automatic)",
          async authorize() {
            return {
              url: "https://daily-cloudcode-pa.googleapis.com",
              instructions: "Tự động quét và import 17 tài khoản từ 9Router...",
              method: "auto" as const,
              async callback(): Promise<OAuthSuccess | OAuthFailed> {
                try {
                  const res = await importAntigravityFrom9Router({ manager });
                  if (res.accounts.length > 0) {
                    const first = res.accounts[0];
                    return {
                      type: "success",
                      provider: PROVIDER_ID,
                      refresh: first.refreshToken,
                      access: first.accessToken || "",
                      expires: first.expiresAt || Date.now() + 3600_000,
                      accountId: first.accountId,
                    };
                  }
                  return { type: "failed" };
                } catch (err) {
                  logger.error(`9Router import error: ${(err as Error).message}`);
                  return { type: "failed" };
                }
              },
            };
          },
        },
      ],
    },
  };
};

export default {
  id: PROVIDER_ID,
  server: plugin,
};
