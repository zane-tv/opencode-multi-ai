/**
 * Tabbed OpenTUI account manager for SuperGrok + Codex pools.
 * Run via: op-ai tui | op-xai tui | op-codex tui
 *
 * Skeleton with full tab state + per-provider list/detail via adapters.
 * Visual language: OpenCode default theme (warm orange primary, purple accent).
 */

import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  parseColor,
  stringToStyledText,
  type SelectOption,
} from "@opentui/core";

import {
  AccountManager,
  type ProviderAccountView,
} from "../core/accounts.js";
import type { AccountMetadata, ProviderKind } from "../core/schemas.js";
import { accountDisplayName, renderStatusLine } from "../core/tui-status.js";
import type { ProviderAdapter } from "../core/adapter.js";
import { xaiAdapter } from "../providers/xai/adapter.js";
import { codexAdapter } from "../providers/codex/adapter.js";
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

const T = {
  bg: "#0a0a0a",
  surface: "#141414",
  border: "#484848",
  borderFocus: "#fab283",
  accent: "#fab283",
  purpleSoft: "#b4a0e0",
  text: "#eeeeee",
  textMuted: "#808080",
  textDim: "#606060",
  cyan: "#56b6c2",
  selectedBg: "#282828",
  selectedText: "#fab283",
} as const;

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

function stickyIndex(view: ProviderAccountView): number {
  const sticky = view.sticky();
  if (!sticky) return 0;
  const i = view.list().findIndex((a) => a.accountId === sticky);
  return i >= 0 ? i : 0;
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
        name: "(no accounts)",
        description: "press q to quit · use CLI add / auth login",
        value: -1,
      },
    ];
  }
  return accounts.map((a, i) => {
    const marker = a.accountId === sticky ? "*" : " ";
    const name = `${marker} ${i}  ${accountDisplayName(a)}`;
    const subtitle = adapter.listSubtitle(
      a as unknown as Record<string, unknown>,
      now,
    );
    return {
      name,
      description: subtitle,
      value: i,
    };
  });
}

function detailFor(
  account: AccountMetadata | undefined,
  adapter: ProviderAdapter,
  now: number,
): string {
  if (!account) {
    return "No account selected.\n\nAdd via:\n  op-xai add / op-codex add\n  opencode auth login";
  }
  const lines = adapter.detailLines(
    account as unknown as Record<string, unknown>,
    now,
  );
  const state: string[] = [];
  if (!account.enabled) state.push("disabled");
  if (account.subscriptionStatus === "dead") state.push("DEAD");
  if (account.entitlementBlocked) state.push("entitlement-blocked");
  if (account.flaggedForRemoval) state.push("flagged");
  return [
    accountDisplayName(account),
    `id: ${account.accountId.length > 16 ? account.accountId.slice(0, 16) + "…" : account.accountId}`,
    state.length ? `state: ${state.join(", ")}` : "state: ready",
    "",
    ...lines,
  ].join("\n");
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
    content: stringToStyledText("op-ai · multi-account"),
    fg: parseColor(T.purpleSoft),
    height: 1,
    width: "100%",
  });

  const tabText = new TextRenderable(renderer, {
    id: "tabs",
    content: stringToStyledText(renderTabBar(activeTab)),
    fg: parseColor(T.accent),
    height: 1,
    width: "100%",
  });

  const headerText = new TextRenderable(renderer, {
    id: "header",
    content: stringToStyledText(""),
    fg: parseColor(T.cyan),
    height: 1,
    width: "100%",
  });

  const statusText = new TextRenderable(renderer, {
    id: "status",
    content: stringToStyledText("Tab/1/2 switch provider · ↑↓ select · s switch · q quit"),
    fg: parseColor(T.textDim),
    height: 1,
    width: "100%",
  });

  const left = new BoxRenderable(renderer, {
    id: "left",
    flexDirection: "column",
    width: "48%",
    height: "100%",
    border: true,
    borderColor: parseColor(T.borderFocus),
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
    selectedBackgroundColor: parseColor(T.selectedBg),
    selectedTextColor: parseColor(T.selectedText),
    descriptionColor: parseColor(T.textMuted),
    selectedDescriptionColor: parseColor(T.textMuted),
    showScrollIndicator: true,
    wrapSelection: true,
    showDescription: true,
  });

  const detailText = new TextRenderable(renderer, {
    id: "detail",
    content: stringToStyledText(""),
    fg: parseColor(T.text),
    width: "100%",
    flexGrow: 1,
  });

  const footer = new TextRenderable(renderer, {
    id: "footer",
    content: stringToStyledText(
      "1/2 or Tab: provider · s: sticky switch · r: reload · q: quit",
    ),
    fg: parseColor(T.textDim),
    height: 1,
    width: "100%",
  });

  function view(): ProviderAccountView {
    return manager.providerView(activeTab);
  }

  function adapter(): ProviderAdapter {
    return ADAPTERS[activeTab];
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

      tabText.content = stringToStyledText(renderTabBar(activeTab));
      left.title = `${TAB_LABELS[activeTab]} accounts`;
      headerText.content = stringToStyledText(
        renderStatusLine(accounts, stickyIndex(v), now, {
          prefix: activeTab,
          pruneCommand: `${activeTab}-prune`,
        }),
      );

      accountSelect.options = accountOptions(v, adapter(), now);
      if (accountSelect.getSelectedIndex() !== selected) {
        accountSelect.setSelectedIndex(selected);
      }

      const acc = accounts[selected];
      detailText.content = stringToStyledText(
        detailFor(acc, adapter(), now),
      );
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
      detailText.content = stringToStyledText(
        detailFor(acc, adapter(), Date.now()),
      );
    },
  );

  async function switchSticky(): Promise<void> {
    const accounts = view().list();
    const acc = accounts[selection[activeTab]!];
    if (!acc) return;
    await view().switchTo(acc.accountId);
    statusText.content = stringToStyledText(
      `Active ${activeTab}: ${accountDisplayName(acc)}`,
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
      void manager.reloadFromDisk().then(() => refreshViews());
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
