import type { Plugin } from "@opencode-ai/plugin";

import { toKiroFetchManager } from "../core/account-rotation.js";
import { getAccountManager } from "../core/accounts.js";
import { logger } from "../core/logger.js";
import { createProviderFetch } from "../core/provider-fetch.js";
import { createKiroAdapter } from "../providers/kiro/adapter.js";
import { bootstrapHostAuthIfNeeded } from "../providers/codex/auth/host-auth.js";
import {
  beginIdcDeviceLogin,
  completeIdcDeviceLogin,
  importAccountManagerExport,
  importCredentialsJson,
  loginWithApiKey,
  validateAwsRegionInput,
} from "../providers/kiro/auth/login.js";
import {
  DUMMY_API_KEY,
  isValidKiroRegion,
  KIRO_BASE_URL,
  KIRO_DEFAULT_REGION,
  PROVIDER_ID,
} from "../providers/kiro/constants.js";
import { resolveKiroMultiModels } from "../providers/kiro/models-sync.js";

const plugin: Plugin = async () => {
  logger.debug("multi-kiro plugin loading (server entry)");
  bootstrapHostAuthIfNeeded(PROVIDER_ID, DUMMY_API_KEY);
  const manager = getAccountManager();
  await manager.load();
  const kiroAdapter = createKiroAdapter();
  const customFetch = createProviderFetch(
    kiroAdapter,
    toKiroFetchManager(manager),
  );
  const view = manager.providerView("kiro");

  return {
    config: async (cfg) => {
      const c = cfg as {
        provider?: Record<string, Record<string, unknown>>;
      };
      if (!c.provider) c.provider = {};
      if (!c.provider[PROVIDER_ID]) c.provider[PROVIDER_ID] = {};
      const p = c.provider[PROVIDER_ID];
      if (p.npm === undefined) p.npm = kiroAdapter.npmPackage;
      if (p.name === undefined) p.name = kiroAdapter.displayName;
      if (p.options === undefined || typeof p.options !== "object") {
        p.options = {
          baseURL: KIRO_BASE_URL,
          apiKey: DUMMY_API_KEY,
          accountSelectionStrategy: "sticky",
        };
      } else {
        const opts = p.options as Record<string, unknown>;
        if (opts.baseURL === undefined) opts.baseURL = KIRO_BASE_URL;
        if (opts.apiKey === undefined) opts.apiKey = DUMMY_API_KEY;
        if (opts.accountSelectionStrategy === undefined) {
          opts.accountSelectionStrategy = "sticky";
        }
      }
      const existing =
        p.models && typeof p.models === "object"
          ? (p.models as Record<string, unknown>)
          : {};
      p.models = await resolveKiroMultiModels({
        userModels: existing,
        allowNetwork: false,
      });
    },

    auth: {
      provider: PROVIDER_ID,
      loader: async () => ({
        apiKey: DUMMY_API_KEY,
        baseURL: KIRO_BASE_URL,
        fetch: customFetch,
      }),
      methods: [
        {
          type: "api",
          label: "Kiro API Key",
          prompts: [
            {
              type: "text",
              key: "api_key",
              message: "Kiro API Key (starts with ksk_)",
              placeholder: "ksk_…",
              validate: (value: string) => {
                const v = (value || "").trim();
                if (!v) return "API key is required";
                if (!v.startsWith("ksk_")) return "API key must start with ksk_";
                if (v.length < 20) return "API key looks too short";
                return undefined;
              },
            },
            {
              type: "text",
              key: "region",
              message: `API region for this key (default: ${KIRO_DEFAULT_REGION}). EU keys often need eu-central-1`,
              placeholder:
                KIRO_DEFAULT_REGION === "us-east-1"
                  ? "eu-central-1"
                  : KIRO_DEFAULT_REGION,
              validate: (value: string) => {
                if (!value) return undefined;
                return validateAwsRegionInput(value);
              },
            },
          ],
          async authorize(inputs) {
            try {
              const account = await loginWithApiKey(
                inputs?.api_key ?? "",
                inputs?.region,
              );
              await view.upsertFromOAuth(account);
              return {
                type: "success" as const,
                key: account.accessToken || account.refreshToken,
                provider: PROVIDER_ID,
                metadata: {
                  email: account.email ?? "",
                  region: account.region,
                  accountId: account.accountId,
                },
              };
            } catch (error) {
              logger.error(
                `kiro API key login failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              return { type: "failed" as const };
            }
          },
        },
        {
          type: "oauth",
          label: "AWS Builder ID / IAM Identity Center",
          prompts: [
            {
              type: "text",
              key: "start_url",
              message:
                "IAM Identity Center Start URL (leave blank for AWS Builder ID)",
              placeholder: "https://your-company.awsapps.com/start",
              validate: (value: string) => {
                if (!value) return undefined;
                try {
                  new URL(value);
                  return undefined;
                } catch {
                  return "Please enter a valid URL";
                }
              },
            },
            {
              type: "text",
              key: "idc_region",
              message:
                "IAM Identity Center region (sso_region) (leave blank for us-east-1)",
              placeholder: "us-east-1",
              validate: (value: string) => {
                if (!value) return undefined;
                return isValidKiroRegion(value.trim())
                  ? undefined
                  : "Please enter a valid AWS region";
              },
            },
          ],
          async authorize(inputs) {
            const session = await beginIdcDeviceLogin({
              startUrl: inputs?.start_url,
              idcRegion: inputs?.idc_region,
              openBrowser: true,
            });
            return {
              url: session.verificationUrl,
              instructions: `Open the verification URL and complete sign-in.\nCode: ${session.auth.userCode}`,
              method: "auto" as const,
              async callback() {
                try {
                  const account = await completeIdcDeviceLogin(session);
                  await view.upsertFromOAuth(account);
                  return {
                    type: "success" as const,
                    provider: PROVIDER_ID,
                    refresh: account.refreshToken,
                    access: account.accessToken || account.refreshToken,
                    expires: account.expiresAt ?? Date.now() + 3_600_000,
                    accountId: account.accountId,
                  };
                } catch (error) {
                  logger.error(
                    `kiro IDC login failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
        {
          type: "oauth",
          label: "IAM Identity Center with Profile ARN",
          prompts: [
            {
              type: "text",
              key: "start_url",
              message:
                "IAM Identity Center Start URL (leave blank for AWS Builder ID)",
              placeholder: "https://your-company.awsapps.com/start",
              validate: (value: string) => {
                if (!value) return undefined;
                try {
                  new URL(value);
                  return undefined;
                } catch {
                  return "Please enter a valid URL";
                }
              },
            },
            {
              type: "text",
              key: "idc_region",
              message:
                "IAM Identity Center region (sso_region) (leave blank for us-east-1)",
              placeholder: "us-east-1",
              validate: (value: string) => {
                if (!value) return undefined;
                return isValidKiroRegion(value.trim())
                  ? undefined
                  : "Please enter a valid AWS region";
              },
            },
            {
              type: "text",
              key: "profile_arn",
              message:
                "Profile ARN (e.g. arn:aws:codewhisperer:eu-central-1:428597928572:profile/HE7XVERQ9VXW)",
              placeholder:
                "arn:aws:codewhisperer:us-east-1:123456789012:profile/XXXXXXXXXX",
              validate: (value: string) => {
                if (!value) return "Profile ARN is required for this method";
                return value.startsWith("arn:aws:codewhisperer:") ||
                  value.startsWith("arn:aws:qdeveloper:")
                  ? undefined
                  : "Please enter a valid CodeWhisperer or Q Developer profile ARN";
              },
            },
          ],
          async authorize(inputs) {
            const session = await beginIdcDeviceLogin({
              startUrl: inputs?.start_url,
              idcRegion: inputs?.idc_region,
              profileArn: inputs?.profile_arn,
              openBrowser: true,
            });
            return {
              url: session.verificationUrl,
              instructions: `Open the verification URL and complete sign-in.\nCode: ${session.auth.userCode}`,
              method: "auto" as const,
              async callback() {
                try {
                  const account = await completeIdcDeviceLogin(session);
                  await view.upsertFromOAuth(account);
                  return {
                    type: "success" as const,
                    provider: PROVIDER_ID,
                    refresh: account.refreshToken,
                    access: account.accessToken || account.refreshToken,
                    expires: account.expiresAt ?? Date.now() + 3_600_000,
                    accountId: account.accountId,
                  };
                } catch (error) {
                  logger.error(
                    `kiro IDC+ARN login failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
        {
          type: "api",
          label: "Import account from credentials JSON",
          prompts: [
            {
              type: "text",
              key: "credentials_json",
              message:
                "Paste account credentials JSON (refreshToken required; clientId/clientSecret for idc, clientId/tokenEndpoint for external-idp)",
              placeholder:
                '{"refreshToken":"...","clientId":"...","clientSecret":"...","authMethod":"idc"}',
              validate: (value: string) => {
                if (!value || !value.trim()) return "Credentials JSON is required";
                try {
                  JSON.parse(value);
                  return undefined;
                } catch {
                  return "Please enter valid JSON";
                }
              },
            },
          ],
          async authorize(inputs) {
            try {
              const account = await importCredentialsJson(
                inputs?.credentials_json ?? "",
              );
              await view.upsertFromOAuth(account);
              return {
                type: "success" as const,
                key: account.accessToken || account.refreshToken,
                provider: PROVIDER_ID,
                metadata: {
                  email: account.email ?? "",
                  accountId: account.accountId,
                },
              };
            } catch (error) {
              logger.error(
                `kiro credentials JSON import failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              return { type: "failed" as const };
            }
          },
        },
        {
          type: "api",
          label: "Import accounts from Kiro Account Manager export",
          prompts: [
            {
              type: "text",
              key: "export_json",
              message:
                'Paste the Kiro Account Manager export JSON (contains an "accounts" array)',
              placeholder:
                '{"accounts":[{"credentials":{"refreshToken":"...","authMethod":"idc"}}]}',
              validate: (value: string) => {
                if (!value || !value.trim()) return "Export JSON is required";
                try {
                  JSON.parse(value);
                  return undefined;
                } catch {
                  return "Please enter valid JSON";
                }
              },
            },
          ],
          async authorize(inputs) {
            try {
              const accounts = await importAccountManagerExport(
                inputs?.export_json ?? "",
              );
              if (accounts.length === 0) return { type: "failed" as const };
              let first = accounts[0]!;
              for (const account of accounts) {
                await view.upsertFromOAuth(account);
                first = account;
              }
              return {
                type: "success" as const,
                key: first.accessToken || first.refreshToken,
                provider: PROVIDER_ID,
                metadata: {
                  email: first.email ?? "",
                  imported: String(accounts.length),
                },
              };
            } catch (error) {
              logger.error(
                `kiro export import failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              return { type: "failed" as const };
            }
          },
        },
      ],
    },

    tool: {},

    async event({ event }) {
      if (event.type === "session.error") {
        logger.debug("session.error event observed", event);
      }
    },
  };
};

export default {
  id: PROVIDER_ID,
  server: plugin,
};
