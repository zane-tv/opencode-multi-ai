/**
 * Tabbed OpenTUI account manager for SuperGrok + Codex pools.
 * Run via: op-ai tui | op-xai tui | op-codex tui
 *
 * Visual language: dark surfaces + vivid per-provider hues, status badges,
 * and green→amber→red quota meters. Select rows are plain strings (API limit)
 * with colored status glyphs; brand/tabs/header/detail/footer use StyledText.
 */

import {
  BoxRenderable,
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
import { formatUntil } from "../core/format-time.js";
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

  // Brand
  brandOp: "#7dd3fc",
  brandAi: "#a78bfa",
  brandSep: "#6b7280",

  // xAI — electric blue/cyan family
  xai: "#38bdf8",
  xaiBright: "#7dd3fc",
  xaiDim: "#0e7490",
  xaiBorder: "#0ea5e9",
  xaiSelectedBg: "#0c2a3a",
  xaiSelectedText: "#7dd3fc",

  // Codex — emerald/green family
  codex: "#34d399",
  codexBright: "#6ee7b7",
  codexDim: "#047857",
  codexBorder: "#10b981",
  codexSelectedBg: "#0c2a1f",
  codexSelectedText: "#6ee7b7",

  // Status
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

export type RunTuiOptions = {
  /** Initial provider tab. */
  initialTab?: TuiTab;
  /** Optional pre-built manager (tests / CLI). */
  manager?: AccountManager;
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
  return t`${bold(fg(T.brandOp)("op"))}${fg(T.brandSep)("-")}${bold(fg(T.brandAi)("ai"))}${fg(T.textDim)(" · ")}${fg(T.textMuted)("multi-account pool")}`;
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
      prefix: activeTabPrefix(tab),
      pruneCommand: `${tab}-prune`,
    },
  );
  // Re-color the same semantic segments for legibility.
  if (accounts.length === 0) {
    return t`${bold(fg(hue.bright)(TAB_LABELS[tab]))}${fg(T.textDim)(" · ")}${fg(T.warn)("no accounts")}`;
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
    chunks.push(
      bold(fg(T.dead)(`⚠ ${warnParts.join(", ")}`)),
    );
    chunks.push(fg(T.textDim)(` (run ${tab}-prune)`));
  }
  // Keep plain string reachable for debugging/tests of status content shape.
  void plain;
  return joinChunks(chunks);
}

function activeTabPrefix(tab: TuiTab): string {
  return tab;
}

function styledHints(message?: string): StyledText {
  if (message) {
    return t`${bold(fg(T.ready)("✓"))}${fg(T.textDim)(" ")}${fg(T.value)(message)}`;
  }
  return t`${fg(T.key)("↑↓")}${fg(T.textDim)(" select  ")}${fg(T.key)("s")}${fg(T.textDim)(" sticky  ")}${fg(T.key)("r")}${fg(T.textDim)(" reload  ")}${fg(T.key)("q")}${fg(T.textDim)(" quit  ")}${fg(T.cooling)("live probe 30s")}`;
}

function styledFooter(): StyledText {
  return t`${fg(T.key)("1")}${fg(T.textDim)("/")}${fg(T.key)("2")}${fg(T.textDim)(" or ")}${fg(T.key)("Tab")}${fg(T.textDim)(": provider  ")}${fg(T.key)("s")}${fg(T.textDim)(": sticky switch  ")}${fg(T.key)("r")}${fg(T.textDim)(": reload  ")}${fg(T.key)("q")}${fg(T.textDim)(": quit")}`;
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
        name: "○  (no accounts)",
        description: "press q to quit · use CLI add / auth login",
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
    return t`${fg(T.warn)("No account selected.")}${fg(T.text)("\n\n")}${fg(T.label)("Add via:")}${fg(T.text)("\n")}${fg(T.key)("  op-xai add")}${fg(T.textDim)(" / ")}${fg(T.key)("op-codex add")}${fg(T.text)("\n")}${fg(T.key)("  opencode auth login")}`;
  }

  const kind = accountStatus(account, now);
  const statusColor = STATUS_COLOR[kind];
  const rem = remainingPercent(account);
  const chunks: TextChunk[] = [];

  chunks.push(bold(fg(hue.bright)(accountDisplayName(account))));
  chunks.push(fg(T.text)("\n"));
  chunks.push(fg(T.label)("status      "));
  chunks.push(bold(fg(statusColor)(`${statusGlyph(kind)} ${STATUS_LABEL[kind]}`)));
  if (account.accountId === undefined) {
    /* keep type narrow */
  }
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
  if (typeof account.priority === "number") {
    chunks.push(...labelValue("priority", String(account.priority)));
  }

  // Quota meter
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

  // Timing / flags
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

  // Adapter extra lines (provider-specific, as plain values under a section)
  const extra = adapter.detailLines(
    account as unknown as Record<string, unknown>,
    now,
  );
  if (extra.length > 0) {
    chunks.push(...sectionHeader("Provider", hue.accent));
    for (const line of extra) {
      // Avoid duplicating name/id already shown above.
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

  // Short id footer for copy-friendly reference
  chunks.push(fg(T.textDim)("\n"));
  chunks.push(fg(T.textDim)(`# ${shortAccountId(account.accountId)}`));

  return joinChunks(chunks);
}

/**
 * Launch the tabbed multi-provider TUI.
 * Tabs: [xAI] [Codex] — switch with Tab / 1 / 2.
 * Per-tab selectedIndex; live timers tagged with provider generation so
 * stale probe results never paint the wrong tab.
 */
export async function runTui(opts: RunTuiOptions = {}): Promise<void> {
  const manager = opts.manager ?? new AccountManager(undefined, {
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

  function teardown(): void {
    if (!alive) return;
    alive = false;
    stopLive();
    for (const tab of TUI_TABS) gens = bumpGeneration(gens, tab);
  }

  const renderer = await createCliRenderer({
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
    content: styledHints(),
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
    title: "Accounts",
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
    title: "Detail",
    titleAlignment: "center",
    backgroundColor: parseColor(T.surface),
    padding: 1,
  });

  const accountSelect = new SelectRenderable(renderer, {
    id: "accounts",
    width: "100%",
    flexGrow: 1,
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

  function applyProviderChrome(tab: TuiTab): void {
    const hue = providerHue(tab);
    left.borderColor = parseColor(hue.border);
    left.title = `${TAB_LABELS[tab]} accounts`;
    right.borderColor = parseColor(hue.border);
    right.title = `${TAB_LABELS[tab]} detail`;
    accountSelect.selectedBackgroundColor = parseColor(hue.selectedBg);
    accountSelect.selectedTextColor = parseColor(hue.selectedText);
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
      tabText.content = styledTabBar(activeTab);
      // Keep plain bar available for callers that only need brackets.
      void renderTabBar(activeTab);
      headerText.content = styledHeader(
        accounts,
        stickyIndex(v),
        now,
        activeTab,
      );

      accountSelect.options = accountOptions(v, adapter(), now);
      accountSelect.selectedBackgroundColor = parseColor(hue.selectedBg);
      accountSelect.selectedTextColor = parseColor(hue.selectedText);
      if (accountSelect.getSelectedIndex() !== selected) {
        accountSelect.setSelectedIndex(selected);
      }

      const acc = accounts[selected];
      detailText.content = styledDetail(acc, adapter(), now, activeTab);
    } finally {
      refreshing = false;
    }
  }

  function switchTab(next: TuiTab): void {
    if (next === activeTab) return;
    // Bump generation on the tab we leave so in-flight live work is ignored.
    gens = bumpGeneration(gens, activeTab);
    activeTab = next;
    refreshViews();
  }

  accountSelect.on(
    SelectRenderableEvents.SELECTION_CHANGED,
    (_opt: SelectOption | null, idx: number) => {
      if (refreshing) return;
      selection = setSelectedForTab(
        selection,
        activeTab,
        idx,
        view().list().length,
      );
      const accounts = view().list();
      const acc = accounts[selection[activeTab]!];
      detailText.content = styledDetail(
        acc,
        adapter(),
        Date.now(),
        activeTab,
      );
    },
  );

  async function switchSticky(): Promise<void> {
    const accounts = view().list();
    const acc = accounts[selection[activeTab]!];
    if (!acc) return;
    await view().switchTo(acc.accountId);
    statusText.content = styledHints(
      `Active ${TAB_LABELS[activeTab]}: ${accountDisplayName(acc)}`,
    );
    refreshViews();
  }

  async function liveTickOnce(): Promise<void> {
    if (!alive) return;
    const tab = activeTab;
    const started = gens[tab]!;
    const v = manager.providerView(tab);
    const ad = ADAPTERS[tab];
    const accounts = v.list();
    if (accounts.length === 0 || !ad.probeQuota) return;

    const idx = selection[tab]!;
    const acc = accounts[idx];
    if (!acc) return;

    try {
      const tokens = await v.ensureFreshToken(acc.accountId);
      if (isStaleResult(gens, tab, started) || !alive) return;
      const orgId =
        acc.provider === "codex" ? acc.organizationId : undefined;
      await ad.probeQuota(tokens.accessToken, {
        accountId: acc.accountId,
        organizationId: orgId,
      });
      if (isStaleResult(gens, tab, started) || !alive) return;
      if (tab === activeTab) refreshViews();
    } catch {
      // live probe is best-effort
    }
  }

  function startLive(): void {
    stopLive();
    if (!alive) return;
    liveTimer = setInterval(() => {
      void liveTickOnce();
    }, 30_000);
  }

  function stopLive(): void {
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  renderer.keyInput.on("keypress", (key) => {
    if (!alive) return;
    const name = (key.name ?? "").toLowerCase();
    const seq = key.sequence ?? "";

    if (name === "q" || (key.ctrl && name === "c")) {
      teardown();
      renderer.destroy();
      return;
    }

    const fromDigit = tabFromKey(name) ?? tabFromKey(seq);
    if (fromDigit) {
      switchTab(fromDigit);
      return;
    }
    if (name === "tab") {
      switchTab(nextTab(activeTab));
      return;
    }
    if (name === "s") {
      void switchSticky();
      return;
    }
    if (name === "r") {
      void manager.reloadFromDisk().then(() => {
        statusText.content = styledHints("Reloaded from disk");
        refreshViews();
      });
      return;
    }
  });

  left.add(accountSelect);
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
  accountSelect.focus();
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
