import type {
  AccountMetadata,
  AccountStorage,
  CodexAccountMetadata,
  KiroAccountMetadata,
  ProviderKind,
  XaiAccountMetadata,
} from "../core/schemas.js";
import { isSelectable } from "../core/accounts.js";
import { accountDisplayName } from "../core/tui-status.js";
import {
  isWindowDisabled,
  leftPercent,
  windowLabel,
} from "../providers/codex/request/usage.js";
import {
  formatPlanLimit,
  resolveXaiRemainingPercent,
} from "../providers/xai/request/plan.js";

export type ActiveQuotaRow = {
  provider: ProviderKind;
  providerLabel: string;
  displayName: string;
  remainingPercent?: number;
  planLabel?: string;
  detail?: string;
  meter: string;
  accountId: string;
  /** True when this provider is the current session model provider. */
  sessionActive?: boolean;
};

const METER_WIDTH = 10;
const METER_PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

const PROVIDER_ORDER: readonly ProviderKind[] = ["codex", "xai", "kiro"];

const PROVIDER_ID_TO_KIND: Readonly<Record<string, ProviderKind>> = {
  "codex-multi": "codex",
  "xai-multi": "xai",
  "kiro-multi": "kiro",
  codex: "codex",
  xai: "xai",
  kiro: "kiro",
};

export function providerKindFromId(
  providerID: string | undefined,
): ProviderKind | undefined {
  if (!providerID) return undefined;
  return PROVIDER_ID_TO_KIND[providerID];
}

export function meterBar(percent: number | undefined, width = METER_WIDTH): string {
  if (percent === undefined || !Number.isFinite(percent)) {
    return "—".repeat(Math.min(3, width));
  }
  const clamped = Math.min(100, Math.max(0, percent));
  const exact = (clamped / 100) * width;
  const full = Math.floor(exact);
  const frac = exact - full;
  const pi = Math.min(7, Math.floor(frac * 8));
  const cells: string[] = [];
  for (let i = 0; i < full; i++) cells.push("█");
  if (full < width) {
    if (pi > 0) cells.push(METER_PARTIALS[pi]!);
    while (cells.length < width) cells.push("░");
  }
  return cells.slice(0, width).join("");
}

export function meterTone(
  percent: number | undefined,
): "ok" | "warn" | "bad" | "muted" {
  if (percent === undefined || !Number.isFinite(percent)) return "muted";
  if (percent <= 0 || percent < 15) return "bad";
  if (percent < 40) return "warn";
  if (percent < 70) return "warn";
  return "ok";
}

/** Soft readiness for sidebar (stricter than isSelectable for exhausted windows). */
export function isSidebarReady(
  account: AccountMetadata,
  now: number,
): boolean {
  if (!isSelectable(account, now)) return false;

  if (account.provider === "codex") {
    const primaryFull =
      typeof account.primaryUsedPercent === "number" &&
      account.primaryUsedPercent >= 100;
    if (primaryFull) {
      const secondaryOpen =
        !isWindowDisabled(account.secondaryWindowMinutes) &&
        typeof account.secondaryUsedPercent === "number" &&
        account.secondaryUsedPercent < 100;
      if (!secondaryOpen) return false;
    }
  }

  if (account.provider === "xai") {
    const rem = resolveXaiRemainingPercent(account);
    if (typeof rem === "number" && rem <= 0) return false;
  }

  if (account.provider === "kiro") {
    if (
      typeof account.usedCount === "number" &&
      typeof account.limitCount === "number" &&
      account.limitCount > 0 &&
      account.usedCount >= account.limitCount
    ) {
      return false;
    }
  }

  return true;
}

function remainingScore(account: AccountMetadata): number {
  if (account.provider === "xai") {
    return resolveXaiRemainingPercent(account) ?? -1;
  }
  if (account.provider === "codex") {
    if (
      !isWindowDisabled(account.primaryWindowMinutes) &&
      typeof account.primaryUsedPercent === "number"
    ) {
      return leftPercent(account.primaryUsedPercent);
    }
    return -1;
  }
  if (account.provider === "kiro") {
    if (
      typeof account.usedCount === "number" &&
      typeof account.limitCount === "number" &&
      account.limitCount > 0
    ) {
      return Math.max(
        0,
        ((account.limitCount - account.usedCount) / account.limitCount) * 100,
      );
    }
    return -1;
  }
  return -1;
}

/**
 * Account multi-ai is most likely using right now for a provider:
 * 1) sticky if still ready
 * 2) else most-recently-used among ready
 * 3) else sticky (even exhausted) for visibility
 * 4) else MRU among any non-dead enabled
 */
export function findActiveAccount(
  storage: AccountStorage,
  provider: ProviderKind,
  now: number = Date.now(),
): AccountMetadata | undefined {
  const pool = storage.accounts.filter(
    (account) => account.provider === provider,
  );
  if (pool.length === 0) return undefined;

  const ready = pool.filter((account) => isSidebarReady(account, now));
  const stickyId = storage.sticky?.[provider];
  const sticky = stickyId
    ? pool.find((account) => account.accountId === stickyId)
    : undefined;

  if (sticky && isSidebarReady(sticky, now)) return sticky;

  if (ready.length > 0) {
    return ready.reduce((best, candidate) => {
      if (candidate.lastUsed !== best.lastUsed) {
        return candidate.lastUsed > best.lastUsed ? candidate : best;
      }
      const candRem = remainingScore(candidate);
      const bestRem = remainingScore(best);
      if (candRem !== bestRem) return candRem > bestRem ? candidate : best;
      return candidate.priority > best.priority ? candidate : best;
    });
  }

  if (sticky && sticky.subscriptionStatus !== "dead" && sticky.enabled) {
    return sticky;
  }

  const alive = pool.filter(
    (account) =>
      account.enabled && account.subscriptionStatus !== "dead",
  );
  if (alive.length === 0) return undefined;
  return alive.reduce((best, candidate) =>
    candidate.lastUsed > best.lastUsed ? candidate : best,
  );
}

function xaiRow(account: XaiAccountMetadata, sessionActive: boolean): ActiveQuotaRow {
  const rem = resolveXaiRemainingPercent(account);
  let detail: string | undefined;
  if (
    typeof account.planUsed === "number" &&
    typeof account.planMonthlyLimit === "number" &&
    account.planMonthlyLimit > 0
  ) {
    detail = `${formatPlanLimit(account.planUsed)} / ${formatPlanLimit(account.planMonthlyLimit)}`;
  }
  return {
    provider: "xai",
    providerLabel: "xAI",
    displayName: accountDisplayName(account),
    remainingPercent: rem,
    planLabel: account.planName,
    detail,
    meter: meterBar(rem),
    accountId: account.accountId,
    sessionActive,
  };
}

function codexRow(
  account: CodexAccountMetadata,
  sessionActive: boolean,
): ActiveQuotaRow {
  const win = account.primaryWindowMinutes;
  let rem: number | undefined;
  let detail: string | undefined;
  if (!isWindowDisabled(win) && typeof account.primaryUsedPercent === "number") {
    rem = leftPercent(account.primaryUsedPercent);
    detail = `primary ${windowLabel(win)} · used ${account.primaryUsedPercent.toFixed(0)}%`;
  } else if (isWindowDisabled(win)) {
    detail = `primary disabled`;
  }
  if (
    !isWindowDisabled(account.secondaryWindowMinutes) &&
    typeof account.secondaryUsedPercent === "number"
  ) {
    const sLeft = leftPercent(account.secondaryUsedPercent);
    const sec = `sec ${sLeft.toFixed(0)}% left`;
    detail = detail ? `${detail} · ${sec}` : sec;
  }
  return {
    provider: "codex",
    providerLabel: "Codex",
    displayName: accountDisplayName(account),
    remainingPercent: rem,
    planLabel: account.planType,
    detail,
    meter: meterBar(rem),
    accountId: account.accountId,
    sessionActive,
  };
}

function kiroRow(
  account: KiroAccountMetadata,
  sessionActive: boolean,
): ActiveQuotaRow {
  let rem: number | undefined;
  let detail: string | undefined;
  if (
    typeof account.usedCount === "number" &&
    typeof account.limitCount === "number" &&
    account.limitCount > 0
  ) {
    rem = Math.min(
      100,
      Math.max(
        0,
        ((account.limitCount - account.usedCount) / account.limitCount) * 100,
      ),
    );
    detail = `${account.usedCount} / ${account.limitCount} used`;
  }
  return {
    provider: "kiro",
    providerLabel: "Kiro",
    displayName: accountDisplayName(account),
    remainingPercent: rem,
    detail,
    meter: meterBar(rem),
    accountId: account.accountId,
    sessionActive,
  };
}

export type BuildActiveQuotaOptions = {
  sessionProviderID?: string;
  sessionOnly?: boolean;
};

/** Build ACTIVE rows; session provider always first. */
export function buildActiveQuotaRows(
  storage: AccountStorage,
  now: number = Date.now(),
  options: BuildActiveQuotaOptions = {},
): ActiveQuotaRow[] {
  const sessionKind = providerKindFromId(options.sessionProviderID);
  const rows: ActiveQuotaRow[] = [];

  for (const provider of PROVIDER_ORDER) {
    if (options.sessionOnly && sessionKind && provider !== sessionKind) {
      continue;
    }
    const acc = findActiveAccount(storage, provider, now);
    if (!acc) continue;
    const sessionActive = sessionKind === provider;
    switch (acc.provider) {
      case "codex":
        rows.push(codexRow(acc, sessionActive));
        break;
      case "xai":
        rows.push(xaiRow(acc, sessionActive));
        break;
      case "kiro":
        rows.push(kiroRow(acc, sessionActive));
        break;
    }
  }

  // Session provider first; among the rest, higher remaining % first.
  rows.sort((a, b) => {
    if (a.sessionActive !== b.sessionActive) {
      return a.sessionActive ? -1 : 1;
    }
    const ar = a.remainingPercent ?? -1;
    const br = b.remainingPercent ?? -1;
    if (ar !== br) return br - ar;
    return PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider);
  });

  return rows;
}

export function formatActiveQuotaLines(rows: ActiveQuotaRow[]): string[] {
  if (rows.length === 0) {
    return ["No multi-ai accounts yet", "Run: op-ai tui → a to add"];
  }
  const lines: string[] = [];
  for (const row of rows) {
    const pct =
      row.remainingPercent === undefined
        ? "—"
        : `${Math.round(row.remainingPercent)}%`;
    const plan = row.planLabel ? ` · ${row.planLabel}` : "";
    const mark = row.sessionActive ? "●" : "★";
    const tag = row.sessionActive ? " · ACTIVE" : "";
    lines.push(`${mark} ${row.providerLabel}  ${row.displayName}${plan}${tag}`);
    lines.push(`  │${row.meter}│ ${pct}`);
    if (row.detail) lines.push(`  ${row.detail}`);
  }
  return lines;
}
