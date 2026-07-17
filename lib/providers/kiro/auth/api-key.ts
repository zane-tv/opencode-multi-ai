import type { AccountOf } from "../../../core/schemas.js";
import { createHash } from "node:crypto";
import { normalizeKiroRegion } from "../constants.js";

export type KiroCandidate = AccountOf<"kiro">;

export function validateKiroApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed.startsWith("ksk_")) {
    throw new Error("Kiro API key must start with ksk_");
  }
  return trimmed;
}

export function buildApiKeyCandidate(
  key: string,
  region = "us-east-1",
): KiroCandidate {
  const refreshToken = validateKiroApiKey(key);
  const accountId = createHash("sha256")
    .update(`api-key:${refreshToken}:${region}`)
    .digest("hex")
    .slice(0, 24);
  return {
    provider: "kiro",
    accountId,
    email: "api-key@kiro.local",
    tags: [],
    refreshToken,
    accessToken: refreshToken,
    expiresAt: 4_102_444_800_000,
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    authMethod: "api-key",
    region: normalizeKiroRegion(region),
    credentialSource: "api-key",
  };
}
