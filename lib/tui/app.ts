/**
 * Tabbed OpenTUI account manager for SuperGrok + Codex pools.
 * Run via: op-ai tui | op-xai tui | op-codex tui
 *
 * Visual language: dark surfaces + vivid per-provider hues, status badges,
 * and green→amber→red quota meters. Select rows are plain strings (API limit)
 * with colored status glyphs; brand/tabs/header/detail/footer use StyledText.
 *
 * Full plugin-parity: VI+EN locale (g), provider-scoped actions, OAuth add,
 * quota probe, live toggle, two-press remove/prune, edit label/tags/note.
 */

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  bold,
  createCliRenderer,
  dim,
  fg,
  parseColor,
  StyledText,
  t,
  type SelectOption,
  type TextChunk,
} from "@opentui/core";

import {
  AccountManager,
  type ProviderAccountView,
} from "../core/accounts.js";
import type {
  AccountMetadata,
  CodexAccountMetadata,
  ProviderKind,
  XaiAccountMetadata,
} from "../core/schemas.js";
import {
  accountDisplayName,
  renderStatusLine,
  shortAccountId,
  summarizePool,
  type StatusAccount,
} from "../core/tui-status.js";
import type { ProviderAdapter } from "../core/adapter.js";
import {
  formatDateTime,
  formatUntil,
} from "../core/format-time.js";
import {
  getLocale,
  localeLabel,
  toggleLocale,
  t as tr,
  type Locale,
} from "../core/i18n.js";
import { xaiAdapter } from "../providers/xai/adapter.js";
import { codexAdapter } from "../providers/codex/adapter.js";
import {
  isWindowDisabled,
  leftPercent,
  windowLabel,
} from "../providers/codex/request/usage.js";
import {
  createLiveGeneration,
  createTabSelection,
  nextTab,
  renderTabBar,
  setSelectedForTab,
  tabFromKey,
  type LiveGeneration,
  type TabSelectionState,
  type TuiTab,
  TUI_TABS,
  TAB_LABELS,
  bumpGeneration,
  isStaleResult,
} from "./tabs.js";
import {
  TUI_BINDINGS,
  advanceConfirmation,
  clearConfirmation,
  decodeTuiAction,
  normalizeTags,
  rowIndexFromMouse,
  type ConfirmationState,
  type TuiAction,
  type TuiKeyEvent,
} from "./action-helpers.js";

/** Coherent dark theme with vivid status + provider accents. */
const T = {
  bg: "#0a0a0a",
  surface: "#141414",
  surfaceRaised: "#1a1a1a",
  border: "#3a3a3a",
  text: "#f2f2f2",
  textMuted: "#a8a8a8",
  textDim: "#8a8a8a",
  selectedBg: "#1e2a33",

  brandOp: "#7dd3fc",
  brandAi: "#a78bfa",
  brandSep: "#6b7280",

  xai: "#38bdf8",
  xaiBright: "#7dd3fc",
  xaiDim: "#0e7490",
  xaiBorder: "#0ea5e9",
  xaiSelectedBg: "#0c2a3a",
  xaiSelectedText: "#7dd3fc",

  codex: "#34d399",
  codexBright: "#6ee7b7",
  codexDim: "#047857",
  codexBorder: "#10b981",
  codexSelectedBg: "#0c2a1f",
  codexSelectedText: "#6ee7b7",

  ready: "#4ade80",
  quota: "#fbbf24",
  cooling: "#22d3ee",
  blocked: "#e879f9",
  dead: "#f87171",
  disabled: "#9ca3af",
  flag: "#fb923c",
  warn: "#fbbf24",
  key: "#c4b5fd",
  label: "#94a3b8",
  value: "#f8fafc",
  section: "#e2e8f0",
} as const;

type StatusKind =
  | "ready"
  | "quota"
  | "cooling"
  | "blocked"
  | "dead"
  | "disabled"
  | "flagged";

const STATUS_COLOR: Record<StatusKind, string> = {
  ready: T.ready,
  quota: T.quota,
  cooling: T.cooling,
  blocked: T.blocked,
  dead: T.dead,
  disabled: T.disabled,
  flagged: T.flag,
};

const STATUS_LABEL: Record<StatusKind, string> = {
  ready: "READY",
  quota: "QUOTA",
  cooling: "COOLING",
  blocked: "BLOCKED",
  dead: "DEAD",
  disabled: "DISABLED",
  flagged: "FLAGGED",
};

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  xai: xaiAdapter,
  codex: codexAdapter,
};

type StatusTone = "ok" | "warn" | "err" | "info" | "neutral";

type SemanticStatus = {
  key?: string;
  vars?: Record<string, string | number>;
  text?: string;
  tone: StatusTone;
};

type EditField = "label" | "tags" | "note";

type EditContext = {
  provider: TuiTab;
  accountId: string;
  field: EditField;
};

type ProbeOutcome = "success" | "partial" | "failure";

export type RunTuiOptions = {
  /** Initial provider tab. */
  initialTab?: TuiTab;
  /** Optional pre-built manager (tests / CLI). */
  manager?: AccountManager;
  createRenderer?: typeof createCliRenderer;
  probeQuota?: (
    tab: TuiTab,
    accessToken: string,
    account: { accountId: string; organizationId?: string },
  ) => Promise<Record<string, unknown>>;
  login?: {
    xai?: {
      browserLogin?: (
        view: ProviderAccountView,
        opts?: {
          openBrowser?: boolean;
          onAuthorizeUrl?: (url: string) => void;
          signal?: AbortSignal;
        },
      ) => Promise<{ accountId: string; email?: string; outcome: string }>;
      deviceCodeLoginFlow?: (
        view: ProviderAccountView,
        onPrompt?: (p: {
          verificationUri: string;
          userCode: string;
        }) => void,
        signal?: AbortSignal,
      ) => Promise<{ accountId: string; email?: string; outcome: string }>;
    };
    codex?: {
      browserLogin?: (
        view: ProviderAccountView,
        opts?: {
          openBrowser?: boolean;
          onAuthorizeUrl?: (url: string) => void;
          signal?: AbortSignal;
          forceNewLogin?: boolean;
        },
      ) => Promise<{ accountId: string; email?: string; outcome: string }>;
      deviceCodeLoginFlow?: (
        view: ProviderAccountView,
        onPrompt?: (p: {
          verificationUri: string;
          userCode: string;
        }) => void,
        signal?: AbortSignal,
      ) => Promise<{ accountId: string; email?: string; outcome: string }>;
    };
  };
};

function providerHue(tab: TuiTab): {
  accent: string;
  bright: string;
  dim: string;
  border: string;
  selectedBg: string;
  selectedText: string;
} {
  if (tab === "xai") {
    return {
      accent: T.xai,
      bright: T.xaiBright,
      dim: T.xaiDim,
      border: T.xaiBorder,
      selectedBg: T.xaiSelectedBg,
      selectedText: T.xaiSelectedText,
    };
  }
  return {
    accent: T.codex,
    bright: T.codexBright,
    dim: T.codexDim,
    border: T.codexBorder,
    selectedBg: T.codexSelectedBg,
    selectedText: T.codexSelectedText,
  };
}

function stickyIndex(view: ProviderAccountView): number {
  const sticky = view.sticky();
  if (!sticky) return 0;
  const i = view.list().findIndex((a) => a.accountId === sticky);
  return i >= 0 ? i : 0;
}

function accountStatus(account: AccountMetadata, now: number): StatusKind {
  if (!account.enabled) return "disabled";
  if (account.subscriptionStatus === "dead") return "dead";
  if (account.entitlementBlocked) return "blocked";
  if (account.flaggedForRemoval) return "flagged";
  if (
    typeof account.quotaResetAt === "number" &&
    account.quotaResetAt > now
  ) {
    return "quota";
  }
  if (
    typeof account.coolingDownUntil === "number" &&
    account.coolingDownUntil > now
  ) {
    return "cooling";
  }
  return "ready";
}

function meterColor(percent: number | undefined): string {
  if (percent === undefined || !Number.isFinite(percent)) return T.textDim;
  if (percent >= 50) return T.ready;
  if (percent >= 20) return T.quota;
  return T.dead;
}

/** 10-cell bar: █████░░░░░ colored by remaining %. */
function meterBar(percent: number | undefined, width = 10): string {
  if (percent === undefined || !Number.isFinite(percent)) {
    return "—".repeat(Math.min(3, width));
  }
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function remainingPercent(account: AccountMetadata): number | undefined {
  if (account.provider === "xai") {
    const p = (account as XaiAccountMetadata).billingRemainingPercent;
    return typeof p === "number" && Number.isFinite(p) ? p : undefined;
  }
  const used = (account as CodexAccountMetadata).primaryUsedPercent;
  const win = (account as CodexAccountMetadata).primaryWindowMinutes;
  if (isWindowDisabled(win)) return undefined;
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  return leftPercent(used);
}

function statusGlyph(kind: StatusKind): string {
  switch (kind) {
    case "ready":
      return "●";
    case "quota":
      return "◆";
    case "cooling":
      return "◎";
    case "blocked":
      return "◈";
    case "dead":
      return "✖";
    case "disabled":
      return "○";
    case "flagged":
      return "⚑";
  }
}

function joinChunks(chunks: TextChunk[]): StyledText {
  return new StyledText(chunks);
}

function styledBrand(): StyledText {
  return t`${bold(fg(T.brandOp)("op"))}${fg(T.brandSep)("-")}${bold(fg(T.brandAi)("ai"))}${fg(T.textDim)(" · ")}${fg(T.textMuted)(tr("brand").trim() || "multi-account pool")}`;
}

function styledTabBar(active: TuiTab): StyledText {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < TUI_TABS.length; i++) {
    const tab = TUI_TABS[i]!;
    const hue = providerHue(tab);
    const label = TAB_LABELS[tab];
    if (i > 0) chunks.push(fg(T.border)("  "));
    if (tab === active) {
      chunks.push(bold(fg(hue.bright)(`[ ${label} ]`)));
    } else {
      chunks.push(dim(fg(hue.dim)(`  ${label}  `)));
    }
  }
  chunks.push(fg(T.textDim)("   "));
  chunks.push(fg(T.key)("1"));
  chunks.push(fg(T.textDim)("/"));
  chunks.push(fg(T.key)("2"));
  chunks.push(fg(T.textDim)(" or "));
  chunks.push(fg(T.key)("Tab"));
  return joinChunks(chunks);
}

function styledHeader(
  accounts: AccountMetadata[],
  activeIndex: number,
  now: number,
  tab: TuiTab,
): StyledText {
  const hue = providerHue(tab);
  const plain = renderStatusLine(
    accounts as StatusAccount[],
    activeIndex,
    now,
    {
      prefix: tab,
      pruneCommand: `${tab}-prune`,
    },
  );
  if (accounts.length === 0) {
    return t`${bold(fg(hue.bright)(TAB_LABELS[tab]))}${fg(T.textDim)(" · ")}${fg(T.warn)(tr("empty_pool").trim())}`;
  }
  const summary = summarizePool(accounts as StatusAccount[], now);
  const chunks: TextChunk[] = [
    bold(fg(hue.bright)(TAB_LABELS[tab])),
    fg(T.textDim)(" · "),
  ];
  const active = accounts[activeIndex];
  if (active) {
    chunks.push(fg(T.value)(accountDisplayName(active)));
    chunks.push(fg(T.textDim)(" · "));
  }
  chunks.push(fg(T.ready)(`${summary.ready} ready`));
  if (summary.quotaExhausted > 0) {
    chunks.push(fg(T.textDim)(" · "));
    chunks.push(fg(T.quota)(`${summary.quotaExhausted} quota`));
  }
  if (summary.cooling > 0) {
    chunks.push(fg(T.textDim)(" · "));
    chunks.push(fg(T.cooling)(`${summary.cooling} cooling`));
  }
  if (summary.entitlementBlocked > 0) {
    chunks.push(fg(T.textDim)(" · "));
    chunks.push(fg(T.blocked)(`${summary.entitlementBlocked} blocked`));
  }
  if (summary.disabled > 0) {
    chunks.push(fg(T.textDim)(" · "));
    chunks.push(fg(T.disabled)(`${summary.disabled} disabled`));
  }
  if (summary.dead > 0 || summary.flagged > 0) {
    chunks.push(fg(T.textDim)(" · "));
    const warnParts: string[] = [];
    if (summary.dead > 0) warnParts.push(`${summary.dead} dead`);
    if (summary.flagged > 0) warnParts.push(`${summary.flagged} flagged`);
    chunks.push(bold(fg(T.dead)(`⚠ ${warnParts.join(", ")}`)));
    chunks.push(fg(T.textDim)(` (run ${tab}-prune)`));
  }
  void plain;
  return joinChunks(chunks);
}

function toneColor(tone: StatusTone): string {
  switch (tone) {
    case "ok":
      return T.ready;
    case "warn":
      return T.warn;
    case "err":
      return T.dead;
    case "info":
      return T.cooling;
    default:
      return T.value;
  }
}

function resolveStatusMessage(status: SemanticStatus | undefined): string {
  if (!status) return "";
  if (status.key) return tr(status.key, status.vars);
  return status.text ?? "";
}

function styledHints(
  status: SemanticStatus | undefined,
  liveEnabled: boolean,
  liveBusy: boolean,
): StyledText {
  const msg = resolveStatusMessage(status);
  if (msg) {
    const glyph =
      status?.tone === "err" ? "✗" : status?.tone === "warn" ? "!" : "✓";
    const color = toneColor(status?.tone ?? "ok");
    return t`${bold(fg(color)(glyph))}${fg(T.textDim)(" ")}${fg(T.value)(msg)}`;
  }
  const live = liveBusy
    ? tr("live_busy")
    : liveEnabled
      ? tr("live_on")
      : tr("live_off");
  return t`${fg(T.key)("↑↓")}${fg(T.textDim)(" select  ")}${fg(T.key)("s")}${fg(T.textDim)(" sticky  ")}${fg(T.key)("r")}${fg(T.textDim)(" refresh  ")}${fg(T.key)("g")}${fg(T.textDim)(" lang  ")}${fg(T.key)("q")}${fg(T.textDim)(" quit")}${fg(T.cooling)(live)}`;
}

function styledFooter(): StyledText {
  // Footer from registry — only implemented bindings, no phantoms.
  const chunks: TextChunk[] = [];
  const shown = TUI_BINDINGS.filter((b) => b.available);
  for (let i = 0; i < shown.length; i++) {
    const b = shown[i]!;
    if (i > 0) chunks.push(fg(T.textDim)("  "));
    chunks.push(fg(T.key)(b.key));
    chunks.push(fg(T.textDim)(":"));
    // Short token from label key (first word after key letter in catalog)
    const label = tr(b.labelKey).replace(/^\S+\s+/, "").trim() || b.labelKey;
    chunks.push(fg(T.textDim)(label.length > 14 ? label.slice(0, 14) : label));
  }
  return joinChunks(chunks);
}

function styledHelp(activeTab: TuiTab, locale: Locale): StyledText {
  void locale;
  const hue = providerHue(activeTab);
  const chunks: TextChunk[] = [
    bold(fg(hue.bright)(tr("how_to_add"))),
    fg(T.text)("\n"),
    fg(T.textDim)("─".repeat(40)),
    fg(T.text)("\n"),
  ];
  if (activeTab === "codex") {
    chunks.push(bold(fg(hue.bright)("CLI JSON import")));
    chunks.push(fg(T.text)("\n"));
    chunks.push(
      fg(T.textDim)(
        "  op-codex import-json <file>  — OAuth JSON (CLI only)",
      ),
    );
    chunks.push(fg(T.text)("\n"));
    chunks.push(
      fg(T.textDim)("  op-codex import-json --text '{...}'"),
    );
    chunks.push(fg(T.text)("\n\n"));
  }
  for (const b of TUI_BINDINGS) {
    if (!b.available) continue;
    chunks.push(fg(T.key)(b.key.padEnd(4)));
    chunks.push(fg(T.value)(tr(b.labelKey)));
    chunks.push(fg(T.text)("\n"));
  }
  chunks.push(fg(T.text)("\n"));
  chunks.push(fg(T.textDim)(`locale: ${localeLabel(getLocale())}  (? closes)`));
  return joinChunks(chunks);
}

function accountOptions(
  view: ProviderAccountView,
  adapter: ProviderAdapter,
  now: number,
): SelectOption[] {
  const accounts = view.list();
  const sticky = view.sticky();
  if (accounts.length === 0) {
    return [
      {
        name: `○  ${tr("empty_pool").trim()}`,
        description: tr("empty_hint"),
        value: -1,
      },
    ];
  }
  return accounts.map((a, i) => {
    const kind = accountStatus(a, now);
    const marker = a.accountId === sticky ? "*" : " ";
    const glyph = statusGlyph(kind);
    const rem = remainingPercent(a);
    const bar = meterBar(rem, 8);
    const pct =
      rem === undefined || !Number.isFinite(rem)
        ? "  — "
        : `${String(Math.round(rem)).padStart(3, " ")}%`;
    const name = `${glyph}${marker} ${i}  ${accountDisplayName(a)}`;
    const subtitle = adapter.listSubtitle(
      a as unknown as Record<string, unknown>,
      now,
    );
    const description = `${bar} ${pct}  ${subtitle}`;
    return {
      name,
      description,
      value: i,
    };
  });
}

function buildActionOptions(): SelectOption[] {
  return TUI_BINDINGS.filter((b) => b.available).map((b) => ({
    name: `${b.key}  ${tr(b.labelKey)}`,
    description: tr(b.descKey),
    value: b.action,
  }));
}

function labelValue(
  label: string,
  value: string,
  valueColor: string = T.value,
): TextChunk[] {
  return [
    fg(T.label)(`${label.padEnd(12)} `),
    fg(valueColor)(value),
    fg(T.text)("\n"),
  ];
}

function sectionHeader(title: string, accent: string): TextChunk[] {
  return [
    fg(T.textDim)("\n"),
    bold(fg(accent)(`▸ ${title}`)),
    fg(T.text)("\n"),
  ];
}

function styledDetail(
  account: AccountMetadata | undefined,
  adapter: ProviderAdapter,
  now: number,
  tab: TuiTab,
): StyledText {
  const hue = providerHue(tab);
  if (!account) {
    return t`${fg(T.warn)(tr("no_accounts"))}`;
  }

  const kind = accountStatus(account, now);
  const statusColor = STATUS_COLOR[kind];
  const rem = remainingPercent(account);
  const chunks: TextChunk[] = [];

  chunks.push(bold(fg(hue.bright)(accountDisplayName(account))));
  chunks.push(fg(T.text)("\n"));
  chunks.push(fg(T.label)("status      "));
  chunks.push(
    bold(fg(statusColor)(`${statusGlyph(kind)} ${STATUS_LABEL[kind]}`)),
  );
  chunks.push(fg(T.text)("\n"));

  chunks.push(
    ...labelValue(
      "id",
      account.accountId.length > 20
        ? `${account.accountId.slice(0, 20)}…`
        : account.accountId,
      T.textMuted,
    ),
  );
  if (account.email) {
    chunks.push(...labelValue("email", account.email));
  }
  if (account.label) {
    chunks.push(...labelValue("label", account.label, hue.bright));
  }
  if (account.tags && account.tags.length > 0) {
    chunks.push(...labelValue("tags", account.tags.join(", "), T.textMuted));
  }
  if (account.note) {
    chunks.push(...labelValue("note", account.note, T.textMuted));
  }
  if (typeof account.priority === "number") {
    chunks.push(...labelValue("priority", String(account.priority)));
  }

  chunks.push(...sectionHeader("Quota", hue.accent));
  const bar = meterBar(rem, 12);
  const barColor = meterColor(rem);
  const pctText =
    rem === undefined || !Number.isFinite(rem)
      ? "—"
      : `${Math.round(rem)}% remaining`;
  chunks.push(fg(T.label)("meter       "));
  chunks.push(fg(barColor)(bar));
  chunks.push(fg(T.textDim)("  "));
  chunks.push(bold(fg(barColor)(pctText)));
  chunks.push(fg(T.text)("\n"));

  if (account.provider === "xai") {
    const x = account as XaiAccountMetadata;
    if (x.planName) chunks.push(...labelValue("plan", x.planName, hue.bright));
    if (
      typeof x.billingRemainingPercent === "number" &&
      Number.isFinite(x.billingRemainingPercent)
    ) {
      chunks.push(
        ...labelValue(
          "credits",
          `${Math.round(x.billingRemainingPercent)}% left`,
          meterColor(x.billingRemainingPercent),
        ),
      );
    }
    if (
      typeof x.rateLimitRemainingRequests === "number" ||
      typeof x.rateLimitLimitRequests === "number"
    ) {
      const remR = x.rateLimitRemainingRequests;
      const limR = x.rateLimitLimitRequests;
      const rate =
        remR !== undefined && limR !== undefined
          ? `${remR}/${limR}`
          : remR !== undefined
            ? String(remR)
            : limR !== undefined
              ? `?/${limR}`
              : "—";
      chunks.push(...labelValue("rate", rate, T.cooling));
    }
  } else {
    const c = account as CodexAccountMetadata;
    if (c.planType) {
      chunks.push(...labelValue("plan", c.planType, hue.bright));
    }
    const primaryLeft =
      typeof c.primaryUsedPercent === "number"
        ? leftPercent(c.primaryUsedPercent)
        : undefined;
    if (isWindowDisabled(c.primaryWindowMinutes)) {
      chunks.push(...labelValue("primary", "disabled", T.disabled));
    } else if (primaryLeft !== undefined) {
      const win = windowLabel(c.primaryWindowMinutes);
      const until =
        typeof c.primaryResetAt === "number" && c.primaryResetAt > now
          ? ` · resets ${formatUntil(c.primaryResetAt, now)}`
          : "";
      chunks.push(
        ...labelValue(
          "primary",
          `${primaryLeft}% left (${win})${until}`,
          meterColor(primaryLeft),
        ),
      );
    }
    const secondaryLeft =
      typeof c.secondaryUsedPercent === "number"
        ? leftPercent(c.secondaryUsedPercent)
        : undefined;
    if (isWindowDisabled(c.secondaryWindowMinutes)) {
      chunks.push(...labelValue("secondary", "disabled", T.disabled));
    } else if (secondaryLeft !== undefined) {
      const win = windowLabel(c.secondaryWindowMinutes);
      const until =
        typeof c.secondaryResetAt === "number" && c.secondaryResetAt > now
          ? ` · resets ${formatUntil(c.secondaryResetAt, now)}`
          : "";
      chunks.push(
        ...labelValue(
          "secondary",
          `${secondaryLeft}% left (${win})${until}`,
          meterColor(secondaryLeft),
        ),
      );
    }
    if (c.activeLimit) {
      chunks.push(...labelValue("active lim", c.activeLimit, T.quota));
    }
  }

  chunks.push(...sectionHeader("State", hue.accent));
  if (
    typeof account.quotaResetAt === "number" &&
    account.quotaResetAt > now
  ) {
    chunks.push(
      ...labelValue(
        "quota until",
        formatUntil(account.quotaResetAt, now),
        T.quota,
      ),
    );
  }
  if (
    typeof account.coolingDownUntil === "number" &&
    account.coolingDownUntil > now
  ) {
    chunks.push(
      ...labelValue(
        "cooling",
        formatUntil(account.coolingDownUntil, now),
        T.cooling,
      ),
    );
  }
  if (typeof account.addedAt === "number") {
    chunks.push(
      ...labelValue("added", formatDateTime(account.addedAt), T.textMuted),
    );
  }
  chunks.push(
    ...labelValue(
      "enabled",
      account.enabled ? "yes" : "no",
      account.enabled ? T.ready : T.disabled,
    ),
  );
  chunks.push(
    ...labelValue(
      "subscription",
      account.subscriptionStatus,
      account.subscriptionStatus === "dead"
        ? T.dead
        : account.subscriptionStatus === "active"
          ? T.ready
          : T.textMuted,
    ),
  );
  if (account.entitlementBlocked) {
    chunks.push(...labelValue("entitlement", "blocked", T.blocked));
  }
  if (account.flaggedForRemoval) {
    chunks.push(...labelValue("flagged", "for removal", T.flag));
  }

  const extra = adapter.detailLines(
    account as unknown as Record<string, unknown>,
    now,
  );
  if (extra.length > 0) {
    chunks.push(...sectionHeader("Provider", hue.accent));
    for (const line of extra) {
      if (/^(id:|email:)/i.test(line)) continue;
      const colon = line.indexOf(":");
      if (colon > 0 && colon < 18) {
        const lab = line.slice(0, colon).trim();
        const val = line.slice(colon + 1).trim();
        chunks.push(...labelValue(lab, val));
      } else {
        chunks.push(fg(T.textMuted)(line));
        chunks.push(fg(T.text)("\n"));
      }
    }
  }

  chunks.push(fg(T.textDim)("\n"));
  chunks.push(fg(T.textDim)(`# ${shortAccountId(account.accountId)}`));

  return joinChunks(chunks);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Launch the tabbed multi-provider TUI.
 * Tabs: [xAI] [Codex] — switch with Tab / 1 / 2.
 * Per-tab selectedIndex; live timers tagged with provider generation so
 * stale probe results never paint the wrong tab.
 */
export async function runTui(opts: RunTuiOptions = {}): Promise<void> {
  const manager =
    opts.manager ??
    new AccountManager(undefined, {
      xai: async (refreshToken) => {
        const { refreshTokens } = await import(
          "../providers/xai/auth/oauth.js"
        );
        return refreshTokens(refreshToken);
      },
      codex: async (refreshToken) => {
        const { refreshTokens } = await import(
          "../providers/codex/auth/oauth.js"
        );
        return refreshTokens(refreshToken);
      },
    });
  await manager.load();

  let activeTab: TuiTab = opts.initialTab ?? "xai";
  let selection: TabSelectionState = createTabSelection({
    xai: stickyIndex(manager.providerView("xai")),
    codex: stickyIndex(manager.providerView("codex")),
  });
  let gens: LiveGeneration = createLiveGeneration();
  let alive = true;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let refreshing = false;
  let busy = false;
  let liveEnabled = true;
  let liveBusy = false;
  let helpVisible = false;
  let confirmation: ConfirmationState = { kind: "none" };
  let semanticStatus: SemanticStatus | undefined;
  let editMode = false;
  let editContext: EditContext | null = null;
  let addAbort: AbortController | null = null;
  let focusPane: "accounts" | "actions" | "edit" = "accounts";

  function teardown(): void {
    if (!alive) return;
    alive = false;
    stopLive();
    if (addAbort) {
      try {
        addAbort.abort();
      } catch {
        /* ignore */
      }
      addAbort = null;
    }
    for (const tab of TUI_TABS) gens = bumpGeneration(gens, tab);
  }

  const makeRenderer = opts.createRenderer ?? createCliRenderer;
  const renderer = await makeRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    backgroundColor: T.bg,
    useMouse: true,
    autoFocus: true,
    onDestroy: teardown,
  });

  const brandText = new TextRenderable(renderer, {
    id: "brand",
    content: styledBrand(),
    height: 1,
    width: "100%",
  });

  const tabText = new TextRenderable(renderer, {
    id: "tabs",
    content: styledTabBar(activeTab),
    height: 1,
    width: "100%",
  });

  const headerText = new TextRenderable(renderer, {
    id: "header",
    content: t`${fg(T.textDim)("")}`,
    height: 1,
    width: "100%",
  });

  const statusText = new TextRenderable(renderer, {
    id: "status",
    content: styledHints(undefined, liveEnabled, liveBusy),
    height: 1,
    width: "100%",
  });

  const hue0 = providerHue(activeTab);

  const left = new BoxRenderable(renderer, {
    id: "left",
    flexDirection: "column",
    width: "48%",
    height: "100%",
    border: true,
    borderColor: parseColor(hue0.border),
    title: `${tr("accounts_title").trim() || "Accounts"}`,
    titleAlignment: "center",
    backgroundColor: parseColor(T.surface),
    padding: 1,
  });

  const right = new BoxRenderable(renderer, {
    id: "right",
    flexDirection: "column",
    flexGrow: 1,
    height: "100%",
    border: true,
    borderColor: parseColor(T.border),
    title: `${tr("detail_title").trim() || "Detail"}`,
    titleAlignment: "center",
    backgroundColor: parseColor(T.surface),
    padding: 1,
  });

  const accountSelect = new SelectRenderable(renderer, {
    id: "accounts",
    width: "100%",
    height: 12,
    flexGrow: 2,
    options: [],
    backgroundColor: parseColor(T.surface),
    textColor: parseColor(T.text),
    focusedBackgroundColor: parseColor(T.surface),
    focusedTextColor: parseColor(T.text),
    selectedBackgroundColor: parseColor(hue0.selectedBg),
    selectedTextColor: parseColor(hue0.selectedText),
    descriptionColor: parseColor(T.textMuted),
    selectedDescriptionColor: parseColor(T.textMuted),
    showScrollIndicator: true,
    wrapSelection: true,
    showDescription: true,
    showSelectionIndicator: true,
  });

  const actionsLabel = new TextRenderable(renderer, {
    id: "actions-label",
    content: t`${fg(hue0.bright)(tr("actions_title"))}`,
    height: 1,
    width: "100%",
  });

  const actionSelect = new SelectRenderable(renderer, {
    id: "actions",
    width: "100%",
    height: 10,
    flexGrow: 1,
    options: buildActionOptions(),
    backgroundColor: parseColor(T.surface),
    textColor: parseColor(T.text),
    focusedBackgroundColor: parseColor(T.surface),
    focusedTextColor: parseColor(T.text),
    selectedBackgroundColor: parseColor(hue0.selectedBg),
    selectedTextColor: parseColor(hue0.selectedText),
    descriptionColor: parseColor(T.textMuted),
    selectedDescriptionColor: parseColor(T.textDim),
    showScrollIndicator: true,
    wrapSelection: true,
    showDescription: true,
    showSelectionIndicator: true,
  });

  const editInput = new InputRenderable(renderer, {
    id: "edit-input",
    width: "100%",
    visible: false,
    backgroundColor: parseColor(T.surfaceRaised),
    textColor: parseColor(T.value),
    focusedBackgroundColor: parseColor(T.surfaceRaised),
    focusedTextColor: parseColor(T.value),
    placeholder: "",
  });

  const detailText = new TextRenderable(renderer, {
    id: "detail",
    content: t`${fg(T.text)("")}`,
    width: "100%",
    flexGrow: 1,
  });

  const footer = new TextRenderable(renderer, {
    id: "footer",
    content: styledFooter(),
    height: 1,
    width: "100%",
  });

  function view(): ProviderAccountView {
    return manager.providerView(activeTab);
  }

  function adapter(): ProviderAdapter {
    return ADAPTERS[activeTab];
  }

  function setStatus(next: SemanticStatus | undefined): void {
    semanticStatus = next;
    if (!alive) return;
    try {
      statusText.content = styledHints(semanticStatus, liveEnabled, liveBusy);
    } catch {
      void 0;
    }
  }

  function selectedAccount(): AccountMetadata | undefined {
    const accounts = view().list();
    let idx = selection[activeTab]!;
    try {
      const live = accountSelect.getSelectedIndex();
      if (
        typeof live === "number" &&
        live >= 0 &&
        live < accounts.length
      ) {
        idx = live;
        selection = setSelectedForTab(
          selection,
          activeTab,
          live,
          accounts.length,
        );
      }
    } catch {
      void 0;
    }
    return accounts[idx];
  }

  function selectedId(): string | undefined {
    return selectedAccount()?.accountId;
  }

  function restoreSelectionById(tab: TuiTab, id: string | undefined): void {
    const list = manager.providerView(tab).list();
    if (!id || list.length === 0) {
      selection = setSelectedForTab(selection, tab, 0, list.length);
      return;
    }
    const idx = list.findIndex((a) => a.accountId === id);
    selection = setSelectedForTab(
      selection,
      tab,
      idx >= 0 ? idx : 0,
      list.length,
    );
  }

  function applyProviderChrome(tab: TuiTab): void {
    const hue = providerHue(tab);
    left.borderColor = parseColor(hue.border);
    left.title = `${TAB_LABELS[tab]}${tr("accounts_title")}`;
    right.borderColor = parseColor(hue.border);
    right.title = `${TAB_LABELS[tab]}${tr("detail_title")}`;
    accountSelect.selectedBackgroundColor = parseColor(hue.selectedBg);
    accountSelect.selectedTextColor = parseColor(hue.selectedText);
    actionSelect.selectedBackgroundColor = parseColor(hue.selectedBg);
    actionSelect.selectedTextColor = parseColor(hue.selectedText);
    actionsLabel.content = t`${fg(hue.bright)(tr("actions_title"))}`;
  }

  function paintFocus(): void {
    if (!alive) return;
    const hue = providerHue(activeTab);
    if (focusPane === "accounts") {
      left.borderColor = parseColor(hue.border);
      actionsLabel.content = t`${fg(hue.dim)(tr("actions_title"))}`;
    } else if (focusPane === "actions") {
      left.borderColor = parseColor(hue.bright);
      actionsLabel.content = t`${fg(hue.bright)(tr("actions_title"))}`;
    } else {
      left.borderColor = parseColor(T.warn);
      actionsLabel.content = t`${fg(hue.dim)(tr("actions_title"))}`;
    }
  }

  function focusAccountsPane(): void {
    focusPane = "accounts";
    accountSelect.focus();
    paintFocus();
  }

  function focusActionsPane(): void {
    focusPane = "actions";
    actionSelect.focus();
    paintFocus();
  }

  function toggleFocusPane(): void {
    if (editMode) return;
    if (focusPane === "actions") focusAccountsPane();
    else focusActionsPane();
  }

  function paintDetail(): void {
    if (helpVisible) {
      detailText.content = styledHelp(activeTab, getLocale());
      return;
    }
    const accounts = view().list();
    const acc = accounts[selection[activeTab]!];
    detailText.content = styledDetail(acc, adapter(), Date.now(), activeTab);
  }

  function refreshViews(): void {
    if (!alive || refreshing) return;
    refreshing = true;
    try {
      const now = Date.now();
      const v = view();
      const accounts = v.list();
      selection = setSelectedForTab(
        selection,
        activeTab,
        selection[activeTab]!,
        accounts.length,
      );
      const selected = selection[activeTab]!;
      const hue = providerHue(activeTab);

      applyProviderChrome(activeTab);
      brandText.content = styledBrand();
      tabText.content = styledTabBar(activeTab);
      void renderTabBar(activeTab);
      headerText.content = styledHeader(
        accounts,
        stickyIndex(v),
        now,
        activeTab,
      );
      statusText.content = styledHints(semanticStatus, liveEnabled, liveBusy);
      footer.content = styledFooter();

      accountSelect.options = accountOptions(v, adapter(), now);
      accountSelect.selectedBackgroundColor = parseColor(hue.selectedBg);
      accountSelect.selectedTextColor = parseColor(hue.selectedText);
      if (accountSelect.getSelectedIndex() !== selected) {
        accountSelect.setSelectedIndex(selected);
      }

      actionSelect.options = buildActionOptions();
      actionSelect.selectedBackgroundColor = parseColor(hue.selectedBg);
      actionSelect.selectedTextColor = parseColor(hue.selectedText);

      paintDetail();
      paintFocus();
    } catch {
      void 0;
    } finally {
      refreshing = false;
    }
  }

  function disarmConfirmation(reason?: string): void {
    if (confirmation.kind === "none") return;
    confirmation = clearConfirmation(confirmation);
    if (reason) setStatus({ text: reason, tone: "info" });
  }

  function switchTab(next: TuiTab): void {
    if (next === activeTab) return;
    if (editMode) cancelEdit();
    gens = bumpGeneration(gens, activeTab);
    activeTab = next;
    helpVisible = false;
    disarmConfirmation();
    refreshViews();
  }

  function cancelEdit(): void {
    editMode = false;
    editContext = null;
    editInput.visible = false;
    editInput.value = "";
    editInput.blur();
    focusAccountsPane();
  }

  function beginEdit(field: EditField): void {
    const acc = selectedAccount();
    if (!acc) return;
    editMode = true;
    focusPane = "edit";
    editContext = {
      provider: activeTab,
      accountId: acc.accountId,
      field,
    };
    helpVisible = false;
    const seed =
      field === "label"
        ? (acc.label ?? "")
        : field === "tags"
          ? (acc.tags ?? []).join(", ")
          : (acc.note ?? "");
    editInput.placeholder =
      field === "label"
        ? seed
          ? `label (was: ${seed})`
          : "label (empty clears)"
        : field === "tags"
          ? seed
            ? `tags (was: ${seed})`
            : "tags, comma-separated"
          : seed
            ? `note (was: ${seed})`
            : "note (empty clears)";
    editInput.visible = true;
    editInput.value = "";
    editInput.focus();
    paintFocus();
    queueMicrotask(() => {
      if (editMode && editInput.visible) editInput.value = "";
    });
    setStatus({
      text: `editing ${field} — Enter save · Esc cancel`,
      tone: "info",
    });
  }

  async function commitEdit(): Promise<void> {
    if (!editContext) {
      cancelEdit();
      return;
    }
    const { provider, accountId, field } = editContext;
    const raw = editInput.value;
    const v = manager.providerView(provider);
    try {
      if (field === "label") {
        const next = raw.trim() === "" ? undefined : raw.trim();
        await v.setLabel(accountId, next);
      } else if (field === "tags") {
        await v.setTags(accountId, normalizeTags(raw));
      } else {
        const next = raw.trim() === "" ? undefined : raw;
        await v.setNote(accountId, next);
      }
      setStatus({ text: `${field} saved`, tone: "ok" });
    } catch (err) {
      setStatus({
        text: `${field} failed: ${(err as Error).message}`,
        tone: "err",
      });
    }
    cancelEdit();
    restoreSelectionById(provider, accountId);
    refreshViews();
  }

  editInput.on(InputRenderableEvents.ENTER, () => {
    void commitEdit();
  });

  accountSelect.on(
    SelectRenderableEvents.SELECTION_CHANGED,
    (idx: number, _opt: SelectOption | null) => {
      if (refreshing) return;
      if (typeof idx !== "number" || !Number.isFinite(idx)) return;
      const prevId = selectedId();
      selection = setSelectedForTab(
        selection,
        activeTab,
        idx,
        view().list().length,
      );
      const nextId = selectedId();
      if (confirmation.kind === "remove" && nextId !== prevId) {
        disarmConfirmation();
      }
      if (helpVisible) {
        helpVisible = false;
      }
      paintDetail();
    },
  );

  function runSelectedActionOption(opt: SelectOption | null | undefined): void {
    if (busy || editMode || !opt) return;
    const value = opt.value;
    if (typeof value !== "string") return;
    void runAction(value as TuiAction);
  }

  actionSelect.on(
    SelectRenderableEvents.ITEM_SELECTED,
    (idxOrOpt: number | SelectOption, optOrIdx?: SelectOption | number) => {
      const opt =
        typeof idxOrOpt === "object" && idxOrOpt !== null
          ? idxOrOpt
          : typeof optOrIdx === "object" && optOrIdx !== null
            ? optOrIdx
            : null;
      runSelectedActionOption(opt);
    },
  );

  type SelectMouseDown = (event: {
    type?: string;
    x: number;
    y: number;
    stopPropagation?: () => void;
    preventDefault?: () => void;
  }) => void;
  type SelectMouseScroll = (event: {
    scroll?: { direction?: string; delta?: number };
    stopPropagation?: () => void;
  }) => void;
  type SelectWithTuiMouse = SelectRenderable & {
    tuiOnMouseDown?: SelectMouseDown;
    tuiOnMouseScroll?: SelectMouseScroll;
  };
  type TextWithTuiMouse = TextRenderable & {
    tuiOnMouseDown?: () => void;
  };

  function wireSelectMouse(
    select: SelectRenderable,
    kind: "accounts" | "actions",
  ): void {
    select.focusable = true;
    const onDown: SelectMouseDown = (event) => {
      if (busy || editMode) return;
      event.stopPropagation?.();
      event.preventDefault?.();

      if (kind === "accounts") {
        focusPane = "accounts";
        select.focus();
        paintFocus();
      } else {
        focusPane = "actions";
        select.focus();
        paintFocus();
      }

      const priv = select as unknown as {
        linesPerItem?: number;
        scrollOffset?: number;
      };
      const linesPerItem = priv.linesPerItem ?? 2;
      const scrollOffset = priv.scrollOffset ?? 0;
      const localY = event.y - select.y;
      const count = select.options?.length ?? 0;
      const index = rowIndexFromMouse(
        localY,
        select.height,
        linesPerItem,
        scrollOffset,
        count,
      );
      if (index < 0) return;

      if (kind === "accounts") {
        const opt = select.options[index];
        if (opt && opt.value === -1) return;
        if (select.getSelectedIndex() !== index) {
          select.setSelectedIndex(index);
        } else {
          selection = setSelectedForTab(
            selection,
            activeTab,
            index,
            view().list().length,
          );
          paintDetail();
        }
        return;
      }

      if (select.getSelectedIndex() !== index) {
        select.setSelectedIndex(index);
      }
      const selected = select.getSelectedOption();
      if (selected) {
        runSelectedActionOption(selected);
      } else {
        select.selectCurrent();
      }
    };

    const onScroll: SelectMouseScroll = (event) => {
      if (busy || editMode) return;
      event.stopPropagation?.();
      const dir = event.scroll?.direction;
      const delta = Math.max(1, Math.abs(event.scroll?.delta ?? 1));
      if (dir === "up") select.moveUp(delta);
      else if (dir === "down") select.moveDown(delta);
    };

    const tagged = select as SelectWithTuiMouse;
    tagged.tuiOnMouseDown = onDown;
    tagged.tuiOnMouseScroll = onScroll;
    select.onMouseDown = onDown;
    select.onMouseScroll = onScroll;
  }

  wireSelectMouse(accountSelect, "accounts");
  wireSelectMouse(actionSelect, "actions");

  const onTabMouseDown = () => {
    if (busy || editMode) return;
    switchTab(nextTab(activeTab));
  };
  (tabText as TextWithTuiMouse).tuiOnMouseDown = onTabMouseDown;
  tabText.onMouseDown = onTabMouseDown;

  async function probeAndRecord(
    tab: TuiTab,
    v: ProviderAccountView,
    account: AccountMetadata,
  ): Promise<ProbeOutcome> {
    const ad = ADAPTERS[tab];
    if (!ad.probeQuota) return "failure";
    try {
      const tokens = await v.ensureFreshToken(account.accountId);
      const orgId =
        account.provider === "codex"
          ? (account as CodexAccountMetadata).organizationId
          : undefined;
      const probeArgs = {
        accountId: account.accountId,
        organizationId: orgId,
      };
      const raw = opts.probeQuota
        ? await opts.probeQuota(tab, tokens.accessToken, probeArgs)
        : await ad.probeQuota!(tokens.accessToken, probeArgs);
      const result = asRecord(raw) ?? {};

      if (tab === "xai") {
        let ok = 0;
        let fail = 0;
        const billing = asRecord(result.billing);
        const plan = asRecord(result.plan);
        if (billing) {
          const monthlyUsed = asFiniteNumber(billing.monthlyUsedPercent);
          const remaining = asFiniteNumber(billing.remainingPercent);
          if (monthlyUsed !== undefined && remaining !== undefined) {
            await v.recordBillingQuota(account.accountId, {
              monthlyUsedPercent: monthlyUsed,
              remainingPercent: remaining,
              resetsAtMs: asFiniteNumber(billing.resetsAtMs),
              observedAt: asFiniteNumber(billing.observedAt) ?? Date.now(),
            });
            ok++;
          } else {
            fail++;
          }
        } else if (result.billingError) {
          fail++;
        }
        if (plan) {
          const planName = asString(plan.planName);
          if (planName) {
            await v.recordPlan(account.accountId, {
              planTier: asFiniteNumber(plan.planTier),
              planName,
              planMonthlyLimit: asFiniteNumber(plan.planMonthlyLimit),
              planUsed: asFiniteNumber(plan.planUsed),
              planPeriodStartMs: asFiniteNumber(plan.planPeriodStartMs),
              planPeriodEndMs: asFiniteNumber(plan.planPeriodEndMs),
              observedAt: asFiniteNumber(plan.observedAt) ?? Date.now(),
            });
            ok++;
          } else {
            fail++;
          }
        } else if (result.planError) {
          fail++;
        }
        if (ok > 0 && fail > 0) return "partial";
        if (ok > 0) return "success";
        return "failure";
      }

      // codex
      await v.recordUsage(account.accountId, {
        planType: asString(result.planType),
        primaryUsedPercent: asFiniteNumber(result.primaryUsedPercent),
        primaryWindowMinutes: asFiniteNumber(result.primaryWindowMinutes),
        primaryResetAt: asFiniteNumber(result.primaryResetAt),
        secondaryUsedPercent: asFiniteNumber(result.secondaryUsedPercent),
        secondaryWindowMinutes: asFiniteNumber(result.secondaryWindowMinutes),
        secondaryResetAt: asFiniteNumber(result.secondaryResetAt),
        activeLimit: asString(result.activeLimit),
        observedAt: asFiniteNumber(result.observedAt) ?? Date.now(),
      });
      return "success";
    } catch {
      return "failure";
    }
  }

  async function withBusy(fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  }

  async function runAction(action: TuiAction): Promise<void> {
    switch (action) {
      case "quit": {
        if (addAbort) {
          try {
            addAbort.abort();
          } catch {
            /* ignore */
          }
        }
        teardown();
        renderer.destroy();
        return;
      }
      case "escape": {
        if (addAbort) {
          try {
            addAbort.abort();
          } catch {
            /* ignore */
          }
          setStatus({ text: "add cancelled", tone: "warn" });
          return;
        }
        if (editMode) {
          cancelEdit();
          setStatus({ text: "edit cancelled", tone: "info" });
          return;
        }
        if (confirmation.kind !== "none") {
          disarmConfirmation("confirm cancelled");
          return;
        }
        if (helpVisible) {
          helpVisible = false;
          paintDetail();
          return;
        }
        if (focusPane === "actions") {
          focusAccountsPane();
          return;
        }
        return;
      }
      case "tab-xai":
        switchTab("xai");
        return;
      case "tab-codex":
        switchTab("codex");
        return;
      case "tab-next":
        switchTab(nextTab(activeTab));
        return;
      case "toggle-locale": {
        const next = toggleLocale(true);
        setStatus({
          key: "lang_switched",
          text: tr("lang_switched"),
          tone: "ok",
        });
        void next;
        refreshViews();
        return;
      }
      case "help": {
        helpVisible = !helpVisible;
        paintDetail();
        return;
      }
      case "switch": {
        await withBusy(async () => {
          const acc = selectedAccount();
          if (!acc) return;
          await view().switchTo(acc.accountId);
          setStatus({
            text: `Active ${TAB_LABELS[activeTab]}: ${accountDisplayName(acc)}`,
            tone: "ok",
          });
          refreshViews();
        });
        return;
      }
      case "prio-up":
      case "prio-down": {
        await withBusy(async () => {
          const acc = selectedAccount();
          if (!acc) return;
          const id = acc.accountId;
          await view().movePriority(
            id,
            action === "prio-up" ? "up" : "down",
          );
          restoreSelectionById(activeTab, id);
          setStatus({ text: `priority ${action === "prio-up" ? "up" : "down"}`, tone: "ok" });
          refreshViews();
        });
        return;
      }
      case "prio-top": {
        await withBusy(async () => {
          const acc = selectedAccount();
          if (!acc) return;
          const id = acc.accountId;
          await view().moveToFront(id);
          restoreSelectionById(activeTab, id);
          setStatus({ text: "priority top", tone: "ok" });
          refreshViews();
        });
        return;
      }
      case "enable":
      case "disable": {
        await withBusy(async () => {
          const acc = selectedAccount();
          if (!acc) return;
          await view().setEnabled(acc.accountId, action === "enable");
          setStatus({
            text: action === "enable" ? "enabled" : "disabled",
            tone: "ok",
          });
          refreshViews();
        });
        return;
      }
      case "label":
        beginEdit("label");
        return;
      case "tags":
        beginEdit("tags");
        return;
      case "note":
        beginEdit("note");
        return;
      case "flag":
      case "unflag": {
        await withBusy(async () => {
          const acc = selectedAccount();
          if (!acc) return;
          await view().setFlaggedForRemoval(
            acc.accountId,
            action === "flag",
          );
          setStatus({
            text: action === "flag" ? "flagged" : "unflagged",
            tone: "ok",
          });
          refreshViews();
        });
        return;
      }
      case "remove": {
        await withBusy(async () => {
          const acc = selectedAccount();
          if (!acc) {
            setStatus({ text: "no account selected", tone: "warn" });
            return;
          }
          const r = advanceConfirmation(confirmation, "remove", {
            provider: activeTab,
            accountId: acc.accountId,
          });
          confirmation = r.next;
          if (!r.confirmed) {
            setStatus({
              text: "press x again to remove",
              tone: "warn",
            });
            return;
          }
          const id = acc.accountId;
          await view().remove(id);
          restoreSelectionById(activeTab, undefined);
          setStatus({ text: `removed ${shortAccountId(id)}`, tone: "ok" });
          refreshViews();
        });
        return;
      }
      case "prune": {
        await withBusy(async () => {
          const r = advanceConfirmation(confirmation, "prune", {
            provider: activeTab,
          });
          confirmation = r.next;
          if (!r.confirmed) {
            const n = view().prunableAccounts().length;
            if (n === 0) {
              confirmation = clearConfirmation();
              setStatus({ text: "nothing to prune", tone: "info" });
              return;
            }
            setStatus({
              text: `press p again to prune ${n}`,
              tone: "warn",
            });
            return;
          }
          const ids = view()
            .prunableAccounts()
            .map((a) => a.accountId);
          if (ids.length === 0) {
            setStatus({ text: "nothing to prune", tone: "info" });
            return;
          }
          const result = await view().pruneAccounts(ids);
          setStatus({
            text: `pruned ${result.removed.length}`,
            tone: "ok",
          });
          restoreSelectionById(activeTab, selectedId());
          refreshViews();
        });
        return;
      }
      case "refresh": {
        await withBusy(async () => {
          const acc = selectedAccount();
          if (!acc) return;
          const outcome = await probeAndRecord(activeTab, view(), acc);
          setStatus({
            text:
              outcome === "success"
                ? "refreshed"
                : outcome === "partial"
                  ? "partial refresh"
                  : "refresh failed",
            tone:
              outcome === "success"
                ? "ok"
                : outcome === "partial"
                  ? "warn"
                  : "err",
          });
          refreshViews();
        });
        return;
      }
      case "refresh-all": {
        await withBusy(async () => {
          const tab = activeTab;
          const v = manager.providerView(tab);
          const snapshot = [...v.list()];
          let ok = 0;
          let fail = 0;
          for (const acc of snapshot) {
            if (!alive) break;
            const outcome = await probeAndRecord(tab, v, acc);
            if (outcome === "failure") fail++;
            else ok++;
          }
          setStatus({
            text: `refreshed ${ok}${fail ? ` · ${fail} failed` : ""}`,
            tone: fail && ok ? "warn" : fail ? "err" : "ok",
          });
          if (tab === activeTab) refreshViews();
        });
        return;
      }
      case "toggle-live": {
        liveEnabled = !liveEnabled;
        if (liveEnabled) {
          startLive();
          setStatus({ key: "live_on", text: tr("live_on").trim(), tone: "ok" });
        } else {
          stopLive();
          setStatus({
            key: "live_off",
            text: tr("live_off").trim(),
            tone: "info",
          });
        }
        statusText.content = styledHints(semanticStatus, liveEnabled, liveBusy);
        return;
      }
      case "reload": {
        await withBusy(async () => {
          const keep = {
            xai: manager.providerView("xai").list()[selection.xai!]?.accountId,
            codex:
              manager.providerView("codex").list()[selection.codex!]
                ?.accountId,
          };
          gens = bumpGeneration(gens, "xai");
          gens = bumpGeneration(gens, "codex");
          await manager.reloadFromDisk();
          restoreSelectionById("xai", keep.xai);
          restoreSelectionById("codex", keep.codex);
          setStatus({ text: "reloaded from disk", tone: "ok" });
          refreshViews();
        });
        return;
      }
      case "add-device":
        void startAdd("device");
        return;
      case "add-browser":
        void startAdd("browser");
        return;
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
      }
    }
  }

  async function startAdd(mode: "device" | "browser"): Promise<void> {
    if (busy || addAbort) return;
    const tab = activeTab;
    const v = manager.providerView(tab);
    const controller = new AbortController();
    addAbort = controller;
    helpVisible = false;
    if (editMode) cancelEdit();
    confirmation = clearConfirmation();
    busy = true;
    setStatus({
      text: mode === "device" ? "device login…" : "browser login…",
      tone: "info",
    });

    try {
      let result: { accountId: string; email?: string; outcome: string };
      const paintDevice = (
        hue: string,
        prompt: { verificationUri: string; userCode: string },
      ) => {
        setStatus({
          text: `${prompt.verificationUri}  code ${prompt.userCode}`,
          tone: "info",
        });
        detailText.content = t`${bold(fg(hue)("Device login"))}${fg(T.text)("\n\n")}${fg(T.label)("URL   ")}${fg(T.value)(prompt.verificationUri)}${fg(T.text)("\n")}${fg(T.label)("Code  ")}${bold(fg(T.ready)(prompt.userCode))}${fg(T.text)("\n\n")}${fg(T.textDim)("Esc cancels")}`;
      };
      const paintBrowser = (hue: string, url: string) => {
        setStatus({ text: url, tone: "info" });
        detailText.content = t`${bold(fg(hue)("Browser login"))}${fg(T.text)("\n\n")}${fg(T.label)("URL   ")}${fg(T.value)(url)}${fg(T.text)("\n\n")}${fg(T.textDim)("Esc cancels")}`;
      };

      if (tab === "xai") {
        const inj = opts.login?.xai;
        if (mode === "device") {
          const fn =
            inj?.deviceCodeLoginFlow ??
            (await import("../providers/xai/auth/login.js"))
              .deviceCodeLoginFlow;
          result = await fn(
            v,
            (prompt) => paintDevice(T.xaiBright, prompt),
            controller.signal,
          );
        } else {
          const fn =
            inj?.browserLogin ??
            (await import("../providers/xai/auth/login.js")).browserLogin;
          result = await fn(v, {
            openBrowser: true,
            signal: controller.signal,
            onAuthorizeUrl: (url) => paintBrowser(T.xaiBright, url),
          });
        }
      } else {
        const inj = opts.login?.codex;
        if (mode === "device") {
          const fn =
            inj?.deviceCodeLoginFlow ??
            (await import("../providers/codex/auth/login.js"))
              .deviceCodeLoginFlow;
          result = await fn(
            v,
            (prompt) => paintDevice(T.codexBright, prompt),
            controller.signal,
          );
        } else {
          const fn =
            inj?.browserLogin ??
            (await import("../providers/codex/auth/login.js")).browserLogin;
          result = await fn(v, {
            openBrowser: true,
            signal: controller.signal,
            forceNewLogin: true,
            onAuthorizeUrl: (url) => paintBrowser(T.codexBright, url),
          });
        }
      }

      if (tab === activeTab) {
        restoreSelectionById(tab, result.accountId);
      } else {
        const list = manager.providerView(tab).list();
        const idx = list.findIndex((a) => a.accountId === result.accountId);
        selection = setSelectedForTab(
          selection,
          tab,
          idx >= 0 ? idx : 0,
          list.length,
        );
      }
      setStatus({
        text: `${result.outcome} ${shortAccountId(result.accountId)}`,
        tone: "ok",
      });
      refreshViews();
      // best-effort follow-up probe — never fails the add
      try {
        const acc = manager.providerView(tab).get(result.accountId);
        if (acc) await probeAndRecord(tab, manager.providerView(tab), acc);
        if (tab === activeTab) refreshViews();
      } catch {
        /* ignore probe after add */
      }
    } catch (err) {
      const cancelled =
        (err as { name?: string }).name === "LoginCancelledError" ||
        (err as Error).message === "login cancelled" ||
        controller.signal.aborted;
      if (cancelled) {
        setStatus({ text: "add cancelled", tone: "warn" });
      } else {
        setStatus({
          text: `add failed: ${(err as Error).message}`,
          tone: "err",
        });
      }
      if (tab === activeTab) paintDetail();
    } finally {
      if (addAbort === controller) addAbort = null;
      busy = false;
    }
  }

  async function liveTickOnce(): Promise<void> {
    if (!alive || !liveEnabled) return;
    const tab = activeTab;
    const started = gens[tab]!;
    const v = manager.providerView(tab);
    const accounts = v.list();
    if (accounts.length === 0) return;
    const idx = selection[tab]!;
    const acc = accounts[idx];
    if (!acc) return;

    liveBusy = true;
    statusText.content = styledHints(semanticStatus, liveEnabled, liveBusy);
    try {
      await probeAndRecord(tab, v, acc);
      if (isStaleResult(gens, tab, started) || !alive) return;
      if (tab === activeTab) refreshViews();
    } catch {
      // live probe is best-effort
    } finally {
      liveBusy = false;
      if (alive) {
        statusText.content = styledHints(semanticStatus, liveEnabled, liveBusy);
      }
    }
  }

  function startLive(): void {
    stopLive();
    if (!alive || !liveEnabled) return;
    liveTimer = setInterval(() => {
      void liveTickOnce();
    }, 30_000);
  }

  function stopLive(): void {
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
    liveBusy = false;
  }

  renderer.keyInput.on("keypress", (key) => {
    if (!alive) return;
    const kev: TuiKeyEvent = {
      name: key.name,
      sequence: key.sequence,
      shift: key.shift,
      ctrl: key.ctrl,
      eventType: (key as { eventType?: string }).eventType,
      type: (key as { type?: string }).type,
    };

    const et = (kev.eventType ?? kev.type ?? "").toLowerCase();
    if (et === "release" || et === "keyup") return;

    if (editMode) {
      const name = (kev.name ?? "").toLowerCase();
      if (name === "escape" || kev.sequence === "\x1b") {
        void runAction("escape");
      }
      return;
    }

    // Shift+Tab toggles accounts↔actions focus; plain Tab stays tab-next.
    const keyName = (kev.name ?? "").toLowerCase();
    if (keyName === "tab" && kev.shift) {
      toggleFocusPane();
      return;
    }

    if (
      focusPane === "actions" &&
      (keyName === "return" || keyName === "enter")
    ) {
      const selected = actionSelect.getSelectedOption();
      if (selected) runSelectedActionOption(selected);
      else actionSelect.selectCurrent();
      return;
    }

    const action = decodeTuiAction(kev);

    if (action === "quit") {
      void runAction("quit");
      return;
    }

    if (action === "escape") {
      void runAction("escape");
      return;
    }

    if (
      busy &&
      action &&
      action !== "help" &&
      action !== "toggle-locale" &&
      action !== "tab-xai" &&
      action !== "tab-codex" &&
      action !== "tab-next"
    ) {
      return;
    }

    if (action) {
      if (
        action !== "remove" &&
        action !== "prune" &&
        action !== "help" &&
        confirmation.kind !== "none"
      ) {
        confirmation = clearConfirmation(confirmation);
      }
      void runAction(action);
    }
  });

  left.add(accountSelect);
  left.add(actionsLabel);
  left.add(actionSelect);
  left.add(editInput);
  right.add(detailText);

  const body = new BoxRenderable(renderer, {
    id: "body",
    flexDirection: "row",
    flexGrow: 1,
    gap: 1,
    width: "100%",
  });
  body.add(left);
  body.add(right);

  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    padding: 1,
    gap: 1,
    backgroundColor: parseColor(T.bg),
  });
  root.add(brandText);
  root.add(tabText);
  root.add(headerText);
  root.add(statusText);
  root.add(body);
  root.add(footer);

  renderer.root.add(root);
  refreshViews();
  focusAccountsPane();
  startLive();

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!alive) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}

export {
  createTabSelection,
  nextTab,
  renderTabBar,
  tabFromKey,
  clampSelectedIndex,
  setSelectedForTab,
  createLiveGeneration,
  bumpGeneration,
  isStaleResult,
} from "./tabs.js";
