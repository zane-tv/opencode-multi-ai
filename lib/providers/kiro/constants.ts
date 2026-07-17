export const PROVIDER_ID = "kiro-multi";
export const KIRO_DEFAULT_REGION = "us-east-1";
export const KIRO_BASE_URL = `https://q.${KIRO_DEFAULT_REGION}.amazonaws.com`;
export const DUMMY_API_KEY = "kiro-multi-dummy";
export const KIRO_REQUEST_TIMEOUT_MS = 120_000;
export const KIRO_SDK_MAX_ATTEMPTS = 3;

export function defaultModelsCachePath(): string {
  return path.join(os.homedir(), ".config", "opencode", "multi-ai-models-kiro.json");
}

export const KIRO_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ap-south-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "sa-east-1",
] as const;

export type KiroRegion = (typeof KIRO_REGIONS)[number];

export const MODEL_MAPPING: Readonly<Record<string, string>> = {
  "claude-haiku-4-5-thinking": "claude-haiku-4.5",
  "claude-sonnet-4-thinking": "claude-sonnet-4",
  "claude-sonnet-4-5-thinking": "claude-sonnet-4.5",
  "claude-sonnet-4-5-1m-thinking": "claude-sonnet-4.5-1m",
  "claude-sonnet-4-6-thinking": "claude-sonnet-4.6",
  "claude-sonnet-4-6-1m-thinking": "claude-sonnet-4.6-1m",
  "claude-sonnet-5-thinking": "claude-sonnet-5",
  "claude-opus-4-5-thinking": "claude-opus-4.5",
  "claude-opus-4-6-thinking": "claude-opus-4.6",
  "claude-opus-4-7-thinking": "claude-opus-4.7",
  "claude-opus-4-8-thinking": "claude-opus-4.8",
};

export const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING);

export function isValidKiroRegion(region: string): region is KiroRegion {
  return KIRO_REGIONS.includes(region as KiroRegion);
}

export function normalizeKiroRegion(region: string | undefined): KiroRegion {
  return region && isValidKiroRegion(region) ? region : KIRO_DEFAULT_REGION;
}

export function kiroCodeWhispererEndpoint(region: string): string {
  return `https://q.${region}.amazonaws.com`;
}

export function kiroRuntimeEndpoint(region: string): string {
  return `https://runtime.${region}.kiro.dev`;
}

export function extractRegionFromArn(arn: string | undefined): KiroRegion | undefined {
  if (!arn) return undefined;
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn" || !parts[3]) return undefined;
  return isValidKiroRegion(parts[3]) ? parts[3] : undefined;
}

export const KIRO_AUTH_SERVICE = {
  SSO_OIDC_ENDPOINT: "https://oidc.{{region}}.amazonaws.com",
  BUILDER_ID_START_URL: "https://view.awsapps.com/start",
  USER_AGENT: "KiroIDE",
  SCOPES: [
    "codewhisperer:completions",
    "codewhisperer:analysis",
    "codewhisperer:conversations",
    "codewhisperer:transformations",
    "codewhisperer:taskassist",
  ],
} as const;

export function buildKiroAuthUrl(template: string, region: KiroRegion): string {
  return template.replace("{{region}}", region);
}
import os from "node:os";
import path from "node:path";
