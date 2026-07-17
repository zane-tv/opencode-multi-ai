import { describe, expect, it } from "vitest";

import {
  bumpGeneration,
  clampSelectedIndex,
  createLiveGeneration,
  createTabSelection,
  isStaleResult,
  nextTab,
  prevTab,
  renderTabBar,
  setSelectedForTab,
  tabFromKey,
} from "../lib/tui/tabs.js";

describe("tui tab state machine", () => {
  it("cycles codex → xai → kiro (Codex-first order)", () => {
    expect(nextTab("codex")).toBe("xai");
    expect(nextTab("xai")).toBe("kiro");
    expect(nextTab("kiro")).toBe("codex");
    expect(prevTab("codex")).toBe("kiro");
  });

  it("maps digit keys to tab bar order (1=Codex, 2=xAI, 3=Kiro)", () => {
    expect(tabFromKey("1")).toBe("codex");
    expect(tabFromKey("2")).toBe("xai");
    expect(tabFromKey("3")).toBe("kiro");
    expect(tabFromKey("tab")).toBeUndefined();
  });

  it("clamps selected index to list length", () => {
    expect(clampSelectedIndex(5, 0)).toBe(0);
    expect(clampSelectedIndex(5, 3)).toBe(2);
    expect(clampSelectedIndex(-1, 3)).toBe(0);
    expect(clampSelectedIndex(1, 3)).toBe(1);
  });

  it("keeps per-tab selection independent", () => {
    let state = createTabSelection({ xai: 0, codex: 2 });
    state = setSelectedForTab(state, "xai", 1, 5);
    expect(state.xai).toBe(1);
    expect(state.codex).toBe(2);
    state = setSelectedForTab(state, "codex", 99, 4);
    expect(state.codex).toBe(3);
    expect(state.xai).toBe(1);
  });

  it("renders active tab brackets with Codex first", () => {
    expect(renderTabBar("codex")).toMatch(/^\[Codex\]/);
    expect(renderTabBar("codex")).toContain(" xAI ");
    expect(renderTabBar("xai")).toContain(" Codex ");
    expect(renderTabBar("xai")).toContain("[xAI]");
  });

  it("stale live results are ignored after tab switch generation bump", () => {
    let gens = createLiveGeneration();
    const started = gens.xai;
    gens = bumpGeneration(gens, "xai");
    expect(isStaleResult(gens, "xai", started)).toBe(true);
    expect(isStaleResult(gens, "codex", gens.codex)).toBe(false);
  });
});
