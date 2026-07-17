import type {
  FetchLike,
  ProviderFetchContext,
} from "../../../core/adapter.js";
import type {
  AccountOf,
  AccountSelectionStrategy,
} from "../../../core/schemas.js";
import { logger } from "../../../core/logger.js";
import {
  isInvalidGrantError,
  type RotationManager,
} from "../../../core/rotation-fetch.js";
import { withKiroAccountLane } from "./account-lane.js";
import { classifyKiroSdkError } from "./classify-error.js";
import { createGenerateAssistantResponseRequest } from "./sdk-client.js";
import { buildCodeWhispererRequest } from "./transform.js";
import { transformSdkStream } from "../streaming/sdk-stream-transformer.js";
import { createSseResponse } from "../streaming/sse-response.js";
import { fetchKiroUsageLimits } from "./usage.js";
import type { OpenCodeMessage } from "../transformers/message-transformer.js";
import type { OpenCodeTool } from "../transformers/tool-transformer.js";

type ManagerLike = Omit<RotationManager, "selectAccount"> & {
  selectAccount(
    provider: "kiro",
    attempted: Set<string>,
    policy?: AccountSelectionStrategy,
  ): { accountId: string } | null;
  recordKiroUsage?(
    provider: "kiro",
    id: string,
    snap: {
      usedCount?: number;
      limitCount?: number;
      email?: string;
      observedAt?: number;
    },
  ): Promise<void>;
  get?(provider: "kiro", id: string): AccountOf<"kiro"> | undefined;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseOpenAiBody(init?: RequestInit): {
  messages: OpenCodeMessage[];
  tools?: OpenCodeTool[];
  system?: string;
  model: string;
  thinking: boolean;
  thinkingBudget: number;
} {
  if (!init?.body || typeof init.body !== "string") {
    throw new Error("Kiro request missing JSON body");
  }
  const body = asRecord(JSON.parse(init.body));
  const messages = Array.isArray(body.messages)
    ? (body.messages as OpenCodeMessage[])
    : [];
  const tools = Array.isArray(body.tools)
    ? (body.tools as OpenCodeTool[])
    : undefined;
  const model = typeof body.model === "string" ? body.model : "auto";
  const thinking =
    body.thinking === true ||
    model.includes("thinking") ||
    asRecord(body.thinkingConfig).type === "enabled";
  const budgetRaw = asRecord(body.thinkingConfig).thinkingBudget;
  const thinkingBudget =
    typeof budgetRaw === "number" ? budgetRaw : 16_384;
  const system =
    typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system
            .map((part) =>
              typeof part === "string"
                ? part
                : typeof asRecord(part).text === "string"
                  ? String(asRecord(part).text)
                  : "",
            )
            .filter(Boolean)
            .join("\n")
        : undefined;
  return { messages, tools, system, model, thinking, thinkingBudget };
}

export function createKiroFetch(
  ctx: ProviderFetchContext,
  options?: { accountSelectionStrategy?: AccountSelectionStrategy },
): FetchLike {
  const manager = ctx.manager as ManagerLike;
  const policy = options?.accountSelectionStrategy ?? "sticky";

  return async function kiroFetch(input, init): Promise<Response> {
    const url = String(input);
    if (!/q\.[^/]+\.amazonaws\.com|runtime\.[^/]+\.kiro\.dev/i.test(url)) {
      return fetch(input, init);
    }

    const body = parseOpenAiBody(init);
    const attempted = new Set<string>();
    const pool = manager.list("kiro");
    let forcedAuthRetryFor: string | undefined;

    for (let i = 0; i < pool.length + 1; i++) {
      const selected = manager.selectAccount("kiro", attempted, policy);
      if (!selected) break;
      const accountId = selected.accountId;
      attempted.add(accountId);

      let accessToken: string;
      try {
        const tokens = await manager.ensureFreshToken(
          "kiro",
          accountId,
          forcedAuthRetryFor === accountId,
        );
        accessToken = tokens.accessToken;
      } catch (error) {
        if (isInvalidGrantError(error)) {
          await manager.markDeadCandidate("kiro", accountId);
        }
        continue;
      }

      const live =
        (manager.get?.("kiro", accountId) as AccountOf<"kiro"> | undefined) ??
        (selected as AccountOf<"kiro">);

      try {
        return await withKiroAccountLane(
          accountId,
          async (release) => {
            const prepared = buildCodeWhispererRequest({
              messages: body.messages,
              tools: body.tools,
              system: body.system,
              modelId: body.model,
              thinking: body.thinking,
              thinkingBudget: body.thinkingBudget,
              profileArn: live.profileArn,
              authMethod: live.authMethod,
            });
            const request = await createGenerateAssistantResponseRequest(
              {
                refresh: live.refreshToken,
                access: accessToken,
                expires: live.expiresAt ?? Date.now() + 60_000,
                authMethod: live.authMethod,
                region: live.region,
                oidcRegion: live.oidcRegion,
                clientId: live.clientId,
                clientSecret: live.clientSecret,
                tokenEndpoint: live.tokenEndpoint,
                email: live.email,
                profileArn: live.profileArn,
              },
              live.region,
              {
                conversationState: prepared.conversationState,
                profileArn: prepared.profileArn,
              },
              undefined,
              undefined,
              prepared.conversationState.currentMessage.userInputMessage
                ?.modelId ?? body.model,
              body.thinkingBudget,
            );

            const client = request.client as unknown as {
              send: (
                command: unknown,
                opts?: { abortSignal?: AbortSignal },
              ) => Promise<unknown>;
            };
            const sdkResponse = await client.send(request.command, {
              abortSignal: init?.signal ?? undefined,
            });

            const stream = transformSdkStream(
              sdkResponse as Parameters<typeof transformSdkStream>[0],
              body.model,
              prepared.conversationState.conversationId,
              body.thinking,
            );

            return createSseResponse(stream, {
              signal: init?.signal ?? undefined,
              onClose: () => {
                release();
                void manager.touchLastUsed("kiro", accountId);
                if (manager.recordKiroUsage) {
                  void fetchKiroUsageLimits(live, accessToken)
                    .then((usage) =>
                      manager.recordKiroUsage?.("kiro", accountId, usage),
                    )
                    .catch((error: unknown) => {
                      logger.debug(
                        `kiro usage probe failed: ${
                          error instanceof Error
                            ? error.message
                            : String(error)
                        }`,
                      );
                    });
                }
              },
            });
          },
          { signal: init?.signal ?? undefined },
        );
      } catch (error) {
        const classification = classifyKiroSdkError(error);
        switch (classification.kind) {
          case "unknown-client-error":
            return new Response(
              JSON.stringify({
                error: {
                  message:
                    error instanceof Error ? error.message : "client error",
                },
              }),
              { status: classification.status, headers: { "content-type": "application/json" } },
            );
          case "auth-dead":
            if (forcedAuthRetryFor !== accountId) {
              forcedAuthRetryFor = accountId;
              attempted.delete(accountId);
              continue;
            }
            await manager.recordCooldown(
              "kiro",
              accountId,
              "auth-failure",
              Date.now() + 30_000,
            );
            continue;
          case "quota-exhausted":
            await manager.markQuotaExhausted(
              "kiro",
              accountId,
              classification.resetAtMs ?? Date.now() + 15 * 60_000,
            );
            continue;
          case "entitlement-blocked":
            await manager.markEntitlementBlocked("kiro", accountId);
            continue;
          case "transient":
            await manager.recordCooldown(
              "kiro",
              accountId,
              "network-error",
              Date.now() + (classification.retryAfterMs ?? 5_000),
            );
            continue;
          case "server":
          case "network":
            continue;
          default:
            continue;
        }
      }
    }

    return new Response(
      JSON.stringify({ error: "All Kiro accounts exhausted" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  };
}
