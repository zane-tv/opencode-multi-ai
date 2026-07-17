import http from "node:http";
import https from "node:https";

import {
  KIRO_REQUEST_TIMEOUT_MS,
  KIRO_SDK_MAX_ATTEMPTS,
  kiroCodeWhispererEndpoint,
} from "../constants.js";
import { buildAdditionalModelRequestFields } from "../effort.js";
import type { Effort, KiroAuthDetails } from "../types.js";

type MiddlewareNext = (args: {
  request: { headers: Record<string, string>; body?: string };
}) => Promise<unknown>;

type StreamingClient = {
  middlewareStack: {
    add: (
      middleware: (next: MiddlewareNext) => MiddlewareNext,
      options: { step: string; name: string; priority?: string },
    ) => void;
  };
  destroy: () => void;
};

type GenerateInput = {
  conversationState: unknown;
  profileArn?: string;
  agentMode?: string;
};

type ClientCacheEntry = {
  client: StreamingClient;
  token: string;
  effort?: Effort;
  kiroModel?: string;
  budget?: number;
};

const clientCache = new Map<string, ClientCacheEntry>();
const CONNECTION_TIMEOUT_MS = 30_000;
const sharedHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const sharedHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

function isApiKeyAuth(auth: KiroAuthDetails): boolean {
  return auth.authMethod === "api-key";
}

function clientCacheKey(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  kiroModel?: string,
  budget?: number,
): string {
  return `${auth.authMethod}:${region}:${auth.email ?? "default"}:${kiroModel ?? "any"}:${effort ?? "none"}:${budget ?? 0}`;
}

function applyKiroAuthHeaders(
  headers: Record<string, string>,
  auth: KiroAuthDetails,
): void {
  headers["x-amzn-kiro-agent-mode"] = "vibe";
  if (auth.authMethod === "external-idp") {
    headers.TokenType = "EXTERNAL_IDP";
  } else if (isApiKeyAuth(auth)) {
    headers.tokentype = "API_KEY";
    headers.TokenType = "API_KEY";
  }
}

function addEffortMiddleware(
  client: StreamingClient,
  kiroModel: string,
  effort?: Effort,
  budget = 20_000,
): void {
  if (!effort) return;
  const fields = buildAdditionalModelRequestFields(kiroModel, effort, budget);
  if (!fields) return;

  client.middlewareStack.add(
    (next) => async (args) => {
      if (args.request?.body) {
        try {
          const body: unknown = JSON.parse(args.request.body);
          if (body !== null && typeof body === "object" && !Array.isArray(body)) {
            const record = body as Record<string, unknown>;
            const existing =
              record.additionalModelRequestFields !== null &&
              typeof record.additionalModelRequestFields === "object" &&
              !Array.isArray(record.additionalModelRequestFields)
                ? (record.additionalModelRequestFields as Record<string, unknown>)
                : {};
            record.additionalModelRequestFields = { ...existing, ...fields };
            args.request.body = JSON.stringify(record);
          }
        } catch {
          return next(args);
        }
      }
      return next(args);
    },
    { step: "build", name: "addEffortConfig", priority: "high" },
  );
}

function sanitizeApiKeyInput(input: GenerateInput): GenerateInput {
  const { profileArn: _profileArn, ...rest } = input;
  return rest;
}

export async function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  requestTimeoutMs = KIRO_REQUEST_TIMEOUT_MS,
  kiroModel = "",
  budget = 20_000,
): Promise<StreamingClient> {
  const cacheKey = clientCacheKey(auth, region, effort, kiroModel, budget);
  const cached = clientCache.get(cacheKey);
  if (
    cached &&
    cached.token === auth.access &&
    cached.effort === effort &&
    cached.kiroModel === kiroModel &&
    cached.budget === budget
  ) {
    return cached.client;
  }

  const [{ CodeWhispererStreamingClient }, { NodeHttpHandler }] =
    await Promise.all([
      import("@aws/codewhisperer-streaming-client"),
      import("@smithy/node-http-handler"),
    ]);

  const token = auth.access;
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: kiroCodeWhispererEndpoint(region),
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_SDK_MAX_ATTEMPTS,
    retryMode: "standard",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: requestTimeoutMs,
      throwOnRequestTimeout: true,
      httpAgent: sharedHttpAgent,
      httpsAgent: sharedHttpsAgent,
    }),
    customUserAgent: [["KiroIDE"]],
  }) as unknown as StreamingClient;

  client.middlewareStack.add(
    (next) => async (args) => {
      applyKiroAuthHeaders(args.request.headers, auth);
      return next(args);
    },
    { step: "build", name: "addKiroHeaders" },
  );
  addEffortMiddleware(client, kiroModel, effort, budget);

  clientCache.set(cacheKey, { client, token, effort, kiroModel, budget });
  return client;
}

export async function createGenerateAssistantResponseRequest(
  auth: KiroAuthDetails,
  region: string,
  input: GenerateInput,
  requestTimeoutMs = KIRO_REQUEST_TIMEOUT_MS,
  effort?: Effort,
  kiroModel = "",
  budget = 20_000,
): Promise<{
  client: StreamingClient;
  command: unknown;
  runtime: "codewhisperer";
}> {
  const { GenerateAssistantResponseCommand } = await import(
    "@aws/codewhisperer-streaming-client"
  );
  const commandInput = isApiKeyAuth(auth) ? sanitizeApiKeyInput(input) : input;
  const client = await createSdkClient(
    auth,
    region,
    effort,
    requestTimeoutMs,
    kiroModel,
    budget,
  );
  return {
    client,
    command: new GenerateAssistantResponseCommand(
      commandInput as ConstructorParameters<
        typeof GenerateAssistantResponseCommand
      >[0],
    ),
    runtime: "codewhisperer",
  };
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy();
  }
  clientCache.clear();
}
