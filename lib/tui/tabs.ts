/**
 * Pure tab-state helpers for the multi-provider OpenTUI.
 * No OpenTUI dependency — unit-tested without a renderer.
 */

import type { ProviderKind } from "../core/schemas.js";

export type TuiTab = ProviderKind;

export const TUI_TABS: readonly TuiTab[] = ["xai", "codex"] as const;

export const TAB_LABELS: Record<TuiTab, string> = {
  xai: "xAI",
  codex: "Codex",
};

export type TabSelectionState = Record<TuiTab, number>;

export function createTabSelection(
  initial: Partial<TabSelectionState> = {},
): TabSelectionState {
  return {
    xai: Math.max(0, initial.xai ?? 0),
    codex: Math.max(0, initial.codex ?? 0),
  };
}

export function nextTab(current: TuiTab): TuiTab {
  return current === "xai" ? "codex" : "xai";
}

export function prevTab(current: TuiTab): TuiTab {
  return nextTab(current);
}

export function tabFromKey(key: string): TuiTab | undefined {
  if (key === "1") return "xai";
  if (key === "2") return "codex";
  return undefined;
}

/**
 * Clamp selected index for a tab when the account list length changes.
 * Empty list → 0 (caller still shows empty state).
 */
export function clampSelectedIndex(
  selected: number,
  listLength: number,
): number {
  if (listLength <= 0) return 0;
  if (selected < 0) return 0;
  if (selected >= listLength) return listLength - 1;
  return selected;
}

export function setSelectedForTab(
  state: TabSelectionState,
  tab: TuiTab,
  index: number,
  listLength: number,
): TabSelectionState {
  return {
    ...state,
    [tab]: clampSelectedIndex(index, listLength),
  };
}

export function renderTabBar(active: TuiTab): string {
  return TUI_TABS.map((tab) => {
    const label = TAB_LABELS[tab];
    return tab === active ? `[${label}]` : ` ${label} `;
  }).join("  ");
}

/**
 * Live-probe generation tokens: each tab keeps a generation counter.
 * When a probe completes, ignore results if generation no longer matches
 * (user switched tabs while probe was in flight).
 */
export type LiveGeneration = Record<TuiTab, number>;

export function createLiveGeneration(): LiveGeneration {
  return { xai: 0, codex: 0 };
}

export function bumpGeneration(
  gens: LiveGeneration,
  tab: TuiTab,
): LiveGeneration {
  return { ...gens, [tab]: gens[tab]! + 1 };
}

export function isStaleResult(
  gens: LiveGeneration,
  tab: TuiTab,
  startedAt: number,
): boolean {
  return gens[tab] !== startedAt;
}
