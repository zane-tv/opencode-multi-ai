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

import type { AccountSelectionStrategy } from "./schemas.js";

const STRATEGIES: readonly AccountSelectionStrategy[] = [
  "sticky",
  "round-robin",
  "lowest-usage",
] as const;

let cached: AccountSelectionStrategy | undefined;
let cachedAt = 0;
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

function readSettingsStrategy(): AccountSelectionStrategy | null {
  try {
    const p = defaultSettingsPath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
      string,
      unknown
    >;
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

function writeSettingsStrategy(strategy: AccountSelectionStrategy): void {
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
    const next = { ...prev, selectionStrategy: strategy };
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
export function getSelectionStrategy(): AccountSelectionStrategy {
  const now = Date.now();
  if (cached !== undefined && now - cachedAt < CACHE_MS) return cached;

  const fromEnv = normalizeStrategy(
    process.env.MULTI_AI_SELECTION_STRATEGY ??
      process.env.MULTI_AI_ACCOUNT_SELECTION,
  );
  const strategy = fromEnv ?? readSettingsStrategy() ?? "sticky";
  cached = strategy;
  cachedAt = now;
  return strategy;
}

export function setSelectionStrategy(
  strategy: AccountSelectionStrategy,
  persist = true,
): void {
  cached = strategy;
  cachedAt = Date.now();
  if (persist) writeSettingsStrategy(strategy);
}

/** Cycle sticky → round-robin → lowest-usage → sticky. */
export function cycleSelectionStrategy(): AccountSelectionStrategy {
  const cur = getSelectionStrategy();
  const i = STRATEGIES.indexOf(cur);
  const next = STRATEGIES[(i + 1) % STRATEGIES.length]!;
  setSelectionStrategy(next, true);
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
  cached = undefined;
  cachedAt = 0;
}
