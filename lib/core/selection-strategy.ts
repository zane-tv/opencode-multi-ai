/**
 * Account selection strategy for multi-ai rotation (all providers).
 *
 * Load order:
 *   MULTI_AI_SELECTION_STRATEGY env
 *   > multi-ai-settings.json `selectionStrategy`
 *   > sticky
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountSelectionStrategy, ProviderKind } from "./schemas.js";

const STRATEGIES: readonly AccountSelectionStrategy[] = [
  "sticky",
  "round-robin",
  "lowest-usage",
] as const;

let cachedGlobal: AccountSelectionStrategy | undefined;
let cachedGlobalAt = 0;
const cachedByProvider: Partial<Record<ProviderKind, { strategy: AccountSelectionStrategy; at: number }>> = {};
const CACHE_MS = 2_000;

export function defaultSettingsPath(): string {
  const override = process.env.MULTI_AI_SETTINGS_PATH?.trim();
  if (override) return override;
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-ai-settings.json",
  );
}

function normalizeStrategy(
  raw: string | undefined | null,
): AccountSelectionStrategy | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/_/g, "-");
  if (v === "sticky" || v === "s") return "sticky";
  if (v === "round-robin" || v === "rr" || v === "roundrobin") {
    return "round-robin";
  }
  if (
    v === "lowest-usage" ||
    v === "lowest" ||
    v === "lu" ||
    v === "usage"
  ) {
    return "lowest-usage";
  }
  return null;
}

function readSettingsStrategy(provider?: ProviderKind): AccountSelectionStrategy | null {
  try {
    const p = defaultSettingsPath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
      string,
      unknown
    >;
    if (provider === "antigravity") {
      const agRaw =
        (typeof data.antigravitySelectionStrategy === "string"
          ? data.antigravitySelectionStrategy
          : undefined) ??
        (typeof data.antigravityAccountSelectionStrategy === "string"
          ? data.antigravityAccountSelectionStrategy
          : undefined);
      const normalized = normalizeStrategy(agRaw);
      if (normalized) return normalized;
    }
    const raw =
      (typeof data.selectionStrategy === "string"
        ? data.selectionStrategy
        : undefined) ??
      (typeof data.accountSelectionStrategy === "string"
        ? data.accountSelectionStrategy
        : undefined);
    return normalizeStrategy(raw);
  } catch {
    return null;
  }
}

function writeSettingsStrategy(strategy: AccountSelectionStrategy, provider?: ProviderKind): void {
  try {
    const p = defaultSettingsPath();
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    let prev: Record<string, unknown> = {};
    try {
      if (fs.existsSync(p)) {
        prev = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
          string,
          unknown
        >;
      }
    } catch {
      prev = {};
    }
    const next = provider === "antigravity"
      ? { ...prev, antigravitySelectionStrategy: strategy }
      : { ...prev, selectionStrategy: strategy };
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, p);
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* ignore */
    }
  } catch {
    /* non-fatal */
  }
}

/** Current strategy (env > settings > sticky). Cached briefly. */
export function getSelectionStrategy(provider?: ProviderKind): AccountSelectionStrategy {
  const now = Date.now();
  if (provider === "antigravity") {
    const entry = cachedByProvider.antigravity;
    if (entry && now - entry.at < CACHE_MS) return entry.strategy;

    const fromEnv = normalizeStrategy(
      process.env.MULTI_AI_ANTIGRAVITY_SELECTION_STRATEGY ??
        process.env.MULTI_AI_SELECTION_STRATEGY ??
        process.env.MULTI_AI_ACCOUNT_SELECTION,
    );
    const strategy = fromEnv ?? readSettingsStrategy("antigravity") ?? "sticky";
    cachedByProvider.antigravity = { strategy, at: now };
    return strategy;
  }

  if (cachedGlobal !== undefined && now - cachedGlobalAt < CACHE_MS) return cachedGlobal;

  const fromEnv = normalizeStrategy(
    process.env.MULTI_AI_SELECTION_STRATEGY ??
      process.env.MULTI_AI_ACCOUNT_SELECTION,
  );
  const strategy = fromEnv ?? readSettingsStrategy() ?? "sticky";
  cachedGlobal = strategy;
  cachedGlobalAt = now;
  return strategy;
}

export function setSelectionStrategy(
  strategy: AccountSelectionStrategy,
  persist = true,
  provider?: ProviderKind,
): void {
  const now = Date.now();
  if (provider === "antigravity") {
    cachedByProvider.antigravity = { strategy, at: now };
    if (persist) writeSettingsStrategy(strategy, "antigravity");
    return;
  }
  cachedGlobal = strategy;
  cachedGlobalAt = now;
  if (persist) writeSettingsStrategy(strategy);
}

/**
 * Cycle selection strategy.
 * For Antigravity: toggles between "sticky" and "round-robin".
 * For other providers: cycles sticky → round-robin → lowest-usage → sticky.
 */
export function cycleSelectionStrategy(provider?: ProviderKind): AccountSelectionStrategy {
  if (provider === "antigravity") {
    const cur = getSelectionStrategy("antigravity");
    const next: AccountSelectionStrategy = cur === "round-robin" ? "sticky" : "round-robin";
    setSelectionStrategy(next, true, "antigravity");
    return next;
  }
  const cur = getSelectionStrategy(provider);
  const i = STRATEGIES.indexOf(cur);
  const next = STRATEGIES[(i + 1) % STRATEGIES.length]!;
  setSelectionStrategy(next, true, provider);
  return next;
}

export function selectionStrategyLabel(
  strategy: AccountSelectionStrategy = getSelectionStrategy(),
): string {
  switch (strategy) {
    case "round-robin":
      return "round-robin";
    case "lowest-usage":
      return "lowest-usage";
    default:
      return "sticky";
  }
}

export function resetSelectionStrategyForTests(): void {
  cachedGlobal = undefined;
  cachedGlobalAt = 0;
  delete cachedByProvider.antigravity;
}
