import { describe, expect, it } from "vitest";

import {
  TUI_BINDINGS,
  actionMenuBack,
  actionMenuItems,
  actionMenuSelectValue,
  advanceConfirmation,
  clearConfirmation,
  createActionMenuLevel,
  decodeTuiAction,
  normalizeTags,
  openActionMenuGroup,
  rowIndexFromMouse,
  type ConfirmationState,
  type TuiKeyEvent,
} from "../lib/tui/action-helpers.js";

function key(partial: TuiKeyEvent): TuiKeyEvent {
  return partial;
}

describe("decodeTuiAction", () => {
  it("ignores key release events", () => {
    expect(
      decodeTuiAction(key({ name: "a", eventType: "release" })),
    ).toBeUndefined();
    expect(
      decodeTuiAction(key({ name: "q", type: "release" })),
    ).toBeUndefined();
  });

  it("maps lowercase a/r/l and shift A/R/L distinctly", () => {
    expect(decodeTuiAction(key({ name: "a" }))).toBe("add-device");
    expect(decodeTuiAction(key({ name: "r" }))).toBe("refresh");
    expect(decodeTuiAction(key({ name: "l" }))).toBe("label");

    expect(decodeTuiAction(key({ name: "a", shift: true }))).toBe(
      "add-browser",
    );
    expect(decodeTuiAction(key({ name: "r", shift: true }))).toBe(
      "refresh-all",
    );
    expect(decodeTuiAction(key({ name: "l", shift: true }))).toBe("reload");
  });

  it("maps one-char uppercase sequences A/R/L without lowercasing away", () => {
    expect(decodeTuiAction(key({ sequence: "A" }))).toBe("add-browser");
    expect(decodeTuiAction(key({ sequence: "R" }))).toBe("refresh-all");
    expect(decodeTuiAction(key({ sequence: "L" }))).toBe("reload");
  });

  it("does not treat arrow CSI \\x1b[A as browser-add", () => {
    expect(
      decodeTuiAction(key({ name: "up", sequence: "\x1b[A" })),
    ).toBeUndefined();
    expect(decodeTuiAction(key({ sequence: "\x1b[A" }))).toBeUndefined();
    expect(decodeTuiAction(key({ sequence: "\x1b[B" }))).toBeUndefined();
  });

  it("maps + / Insert / shift-= to device add", () => {
    expect(decodeTuiAction(key({ sequence: "+" }))).toBe("add-device");
    expect(decodeTuiAction(key({ name: "insert" }))).toBe("add-device");
    expect(decodeTuiAction(key({ name: "=", shift: true }))).toBe("add-device");
    expect(decodeTuiAction(key({ sequence: "+" }))).toBe("add-device");
  });

  it("maps [ ] and shift-[ / { to priority actions", () => {
    expect(decodeTuiAction(key({ sequence: "[" }))).toBe("prio-up");
    expect(decodeTuiAction(key({ sequence: "]" }))).toBe("prio-down");
    expect(decodeTuiAction(key({ sequence: "{" }))).toBe("prio-top");
    expect(decodeTuiAction(key({ name: "[", shift: true }))).toBe("prio-top");
    expect(decodeTuiAction(key({ sequence: "[", shift: true }))).toBe(
      "prio-top",
    );
  });

  it("maps shift-/ and ? to help", () => {
    expect(decodeTuiAction(key({ sequence: "?" }))).toBe("help");
    expect(decodeTuiAction(key({ name: "/", shift: true }))).toBe("help");
    expect(decodeTuiAction(key({ sequence: "/", shift: true }))).toBe("help");
  });

  it("maps the rest of the locked keymap", () => {
    expect(decodeTuiAction(key({ name: "q" }))).toBe("quit");
    expect(decodeTuiAction(key({ name: "c", ctrl: true }))).toBe("quit");
    expect(decodeTuiAction(key({ name: "escape" }))).toBe("escape");
    expect(decodeTuiAction(key({ name: "g" }))).toBe("toggle-locale");
    expect(decodeTuiAction(key({ name: "s" }))).toBe("switch");
    expect(decodeTuiAction(key({ name: "e" }))).toBe("enable");
    expect(decodeTuiAction(key({ name: "d" }))).toBe("disable");
    expect(decodeTuiAction(key({ name: "t" }))).toBe("tags");
    expect(decodeTuiAction(key({ name: "n" }))).toBe("note");
    expect(decodeTuiAction(key({ name: "f" }))).toBe("flag");
    expect(decodeTuiAction(key({ name: "u" }))).toBe("unflag");
    expect(decodeTuiAction(key({ name: "x" }))).toBe("remove");
    expect(decodeTuiAction(key({ name: "p" }))).toBe("prune");
    expect(decodeTuiAction(key({ name: "v" }))).toBe("toggle-live");
    expect(decodeTuiAction(key({ name: "1" }))).toBe("tab-codex");
    expect(decodeTuiAction(key({ name: "2" }))).toBe("tab-xai");
    expect(decodeTuiAction(key({ name: "tab" }))).toBe("tab-next");
  });

  it("table: case-sensitive letter decode matrix", () => {
    const rows: Array<{
      input: TuiKeyEvent;
      action: ReturnType<typeof decodeTuiAction>;
    }> = [
      { input: { name: "a" }, action: "add-device" },
      { input: { name: "A", shift: true }, action: "add-browser" },
      { input: { sequence: "a" }, action: "add-device" },
      { input: { sequence: "A" }, action: "add-browser" },
      { input: { name: "r" }, action: "refresh" },
      { input: { sequence: "R" }, action: "refresh-all" },
      { input: { name: "l" }, action: "label" },
      { input: { sequence: "L" }, action: "reload" },
      { input: { name: "up", sequence: "\x1b[A" }, action: undefined },
    ];
    for (const row of rows) {
      expect(decodeTuiAction(row.input), JSON.stringify(row.input)).toBe(
        row.action,
      );
    }
  });
});

describe("advanceConfirmation / clearConfirmation", () => {
  const none: ConfirmationState = { kind: "none" };

  it("first remove press arms without confirming", () => {
    const r = advanceConfirmation(none, "remove", {
      provider: "xai",
      accountId: "acc-1",
    });
    expect(r.confirmed).toBe(false);
    expect(r.next).toEqual({
      kind: "remove",
      provider: "xai",
      accountId: "acc-1",
    });
  });

  it("second remove press confirms only for same provider+id", () => {
    const armed: ConfirmationState = {
      kind: "remove",
      provider: "xai",
      accountId: "acc-1",
    };
    const ok = advanceConfirmation(armed, "remove", {
      provider: "xai",
      accountId: "acc-1",
    });
    expect(ok.confirmed).toBe(true);
    expect(ok.next).toEqual({ kind: "none" });

    const wrongId = advanceConfirmation(armed, "remove", {
      provider: "xai",
      accountId: "acc-2",
    });
    expect(wrongId.confirmed).toBe(false);
    expect(wrongId.next).toEqual({
      kind: "remove",
      provider: "xai",
      accountId: "acc-2",
    });

    const wrongProv = advanceConfirmation(armed, "remove", {
      provider: "codex",
      accountId: "acc-1",
    });
    expect(wrongProv.confirmed).toBe(false);
    expect(wrongProv.next).toEqual({
      kind: "remove",
      provider: "codex",
      accountId: "acc-1",
    });
  });

  it("remove without accountId never confirms", () => {
    const r = advanceConfirmation(none, "remove", { provider: "xai" });
    expect(r.confirmed).toBe(false);
    expect(r.next.kind).toBe("none");
  });

  it("first prune arms; second confirms same provider only", () => {
    const armed = advanceConfirmation(none, "prune", { provider: "codex" });
    expect(armed.confirmed).toBe(false);
    expect(armed.next).toEqual({ kind: "prune", provider: "codex" });

    const ok = advanceConfirmation(armed.next, "prune", { provider: "codex" });
    expect(ok.confirmed).toBe(true);
    expect(ok.next).toEqual({ kind: "none" });

    const other = advanceConfirmation(armed.next, "prune", {
      provider: "xai",
    });
    expect(other.confirmed).toBe(false);
    expect(other.next).toEqual({ kind: "prune", provider: "xai" });
  });

  it("switching action kind re-arms instead of confirming", () => {
    const removeArmed: ConfirmationState = {
      kind: "remove",
      provider: "xai",
      accountId: "a",
    };
    const toPrune = advanceConfirmation(removeArmed, "prune", {
      provider: "xai",
    });
    expect(toPrune.confirmed).toBe(false);
    expect(toPrune.next).toEqual({ kind: "prune", provider: "xai" });
  });

  it("clearConfirmation always returns none", () => {
    expect(clearConfirmation()).toEqual({ kind: "none" });
    expect(
      clearConfirmation({
        kind: "remove",
        provider: "xai",
        accountId: "z",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("normalizeTags", () => {
  it("splits on comma, trims, drops empty, keeps order and casing", () => {
    expect(normalizeTags("work, Primary, work")).toEqual([
      "work",
      "Primary",
    ]);
    expect(normalizeTags("  a , , b  ,a ")).toEqual(["a", "b"]);
  });

  it("keeps Unicode including Vietnamese", () => {
    expect(normalizeTags("Việt Nam, primary")).toEqual([
      "Việt Nam",
      "primary",
    ]);
  });

  it("dedupes exact case-sensitive matches only", () => {
    expect(normalizeTags("Work,work,Work")).toEqual(["Work", "work"]);
  });

  it("blank / whitespace → empty array", () => {
    expect(normalizeTags("")).toEqual([]);
    expect(normalizeTags("   ")).toEqual([]);
    expect(normalizeTags(", ,")).toEqual([]);
  });
});

describe("TUI_BINDINGS registry", () => {
  it("is immutable and covers every bound action once for footer/help", () => {
    expect(Object.isFrozen(TUI_BINDINGS)).toBe(true);
    const actions = TUI_BINDINGS.map((b) => b.action);
    const unique = new Set(actions);
    expect(unique.size).toBe(actions.length);
    // Core advertised actions must be present
    for (const a of [
      "quit",
      "add-device",
      "add-browser",
      "add-kiro-api-key",
      "add-kiro-idc-arn",
      "add-kiro-json",
      "add-kiro-export",
      "add-kiro-cli",
      "switch",
      "prio-up",
      "prio-down",
      "prio-top",
      "enable",
      "disable",
      "label",
      "tags",
      "note",
      "flag",
      "unflag",
      "remove",
      "prune",
      "clean-dead",
      "refresh",
      "refresh-all",
      "toggle-live",
      "reload",
      "toggle-locale",
      "help",
    ] as const) {
      expect(actions, a).toContain(a);
    }
    for (const b of TUI_BINDINGS) {
      expect(b.key.length).toBeGreaterThan(0);
      expect(b.labelKey.length).toBeGreaterThan(0);
    }
  });
});

describe("rowIndexFromMouse", () => {
  it("returns -1 when localY is outside the viewport height", () => {
    expect(rowIndexFromMouse(-1, 10, 2, 0, 5)).toBe(-1);
    expect(rowIndexFromMouse(10, 10, 2, 0, 5)).toBe(-1);
    expect(rowIndexFromMouse(11, 10, 2, 0, 5)).toBe(-1);
  });

  it("maps the first row (localY=0) to index 0 when not scrolled", () => {
    expect(rowIndexFromMouse(0, 10, 2, 0, 5)).toBe(0);
    expect(rowIndexFromMouse(1, 10, 2, 0, 5)).toBe(0);
  });

  it("uses linesPerItem=2 so the second visual item starts at localY=2", () => {
    expect(rowIndexFromMouse(2, 10, 2, 0, 5)).toBe(1);
    expect(rowIndexFromMouse(3, 10, 2, 0, 5)).toBe(1);
    expect(rowIndexFromMouse(4, 10, 2, 0, 5)).toBe(2);
  });

  it("applies scrollOffset to the computed row", () => {
    expect(rowIndexFromMouse(0, 10, 2, 3, 8)).toBe(3);
    expect(rowIndexFromMouse(2, 10, 2, 3, 8)).toBe(4);
  });

  it("returns -1 when index would be >= count or list is empty", () => {
    expect(rowIndexFromMouse(0, 10, 2, 0, 0)).toBe(-1);
    expect(rowIndexFromMouse(8, 10, 2, 0, 3)).toBe(-1);
    expect(rowIndexFromMouse(0, 10, 2, 5, 5)).toBe(-1);
  });

  it("guards linesPerItem=0 (and negative) to 1", () => {
    expect(rowIndexFromMouse(0, 10, 0, 0, 5)).toBe(0);
    expect(rowIndexFromMouse(1, 10, 0, 0, 5)).toBe(1);
    expect(rowIndexFromMouse(2, 10, -3, 0, 5)).toBe(2);
  });
});

describe("action menu hierarchy", () => {
  it("main level lists groups then top actions", () => {
    const main = createActionMenuLevel();
    const items = actionMenuItems(main);
    expect(items.some((i) => i.kind === "group" && i.id === "account")).toBe(
      true,
    );
    expect(items.some((i) => i.kind === "group" && i.id === "danger")).toBe(
      true,
    );
    expect(items.some((i) => i.kind === "top" && i.action === "quit")).toBe(
      true,
    );
    expect(items.some((i) => i.kind === "back")).toBe(false);
  });

  it("open group then back restores main", () => {
    let level = createActionMenuLevel();
    level = openActionMenuGroup(level, "quota");
    expect(level.kind).toBe("group");
    const items = actionMenuItems(level);
    expect(items[0]?.kind).toBe("back");
    expect(
      items.some(
        (i) => i.kind === "action" && i.binding.action === "refresh",
      ),
    ).toBe(true);
    level = actionMenuBack(level);
    expect(level.kind).toBe("main");
  });

  it("select values encode open / back / run", () => {
    const items = actionMenuItems(createActionMenuLevel());
    const account = items.find((i) => i.kind === "group" && i.id === "account");
    expect(account).toBeDefined();
    expect(actionMenuSelectValue(account!)).toEqual({
      type: "open",
      group: "account",
    });
    expect(actionMenuSelectValue({ kind: "back", labelKey: "menu_back" })).toEqual({
      type: "back",
    });
  });

  it("add group lists provider-specific login methods", () => {
    let level = openActionMenuGroup(createActionMenuLevel(), "add");
    const xaiItems = actionMenuItems(level, "xai");
    const xaiActions = xaiItems
      .filter((i) => i.kind === "action")
      .map((i) => (i.kind === "action" ? i.binding.action : ""));
    expect(xaiActions).toEqual(["add-device", "add-browser"]);

    const codexItems = actionMenuItems(level, "codex");
    const codexActions = codexItems
      .filter((i) => i.kind === "action")
      .map((i) => (i.kind === "action" ? i.binding.action : ""));
    expect(codexActions).toEqual([
      "add-device",
      "add-browser",
      "add-codex-json",
    ]);

    const kiroItems = actionMenuItems(level, "kiro");
    const kiroActions = kiroItems
      .filter((i) => i.kind === "action")
      .map((i) => (i.kind === "action" ? i.binding.action : ""));
    expect(kiroActions).toEqual([
      "add-device",
      "add-kiro-api-key",
      "add-kiro-idc-arn",
      "add-kiro-json",
      "add-kiro-export",
      "add-kiro-cli",
    ]);
  });

  it("decodes kiro/codex add hotkeys", () => {
    expect(decodeTuiAction(key({ name: "i" }))).toBe("add-kiro-api-key");
    expect(decodeTuiAction(key({ name: "i", shift: true }))).toBe(
      "add-kiro-idc-arn",
    );
    expect(decodeTuiAction(key({ name: "o" }))).toBe("add-codex-json");
    expect(decodeTuiAction(key({ name: "o", shift: true }))).toBe(
      "add-kiro-export",
    );
    // j/k reserved for list navigation — must not steal move-down/up
    expect(decodeTuiAction(key({ name: "j" }))).toBeUndefined();
    expect(decodeTuiAction(key({ name: "k" }))).toBeUndefined();
    expect(decodeTuiAction(key({ name: "c" }))).toBe("add-kiro-cli");
    expect(decodeTuiAction(key({ name: "c", ctrl: true }))).toBe("quit");
  });

  it("decodes Shift+F as Codex Fast toggle; bare f stays flag", () => {
    expect(decodeTuiAction(key({ name: "f" }))).toBe("flag");
    expect(decodeTuiAction(key({ name: "f", shift: true }))).toBe(
      "toggle-codex-fast",
    );
    expect(decodeTuiAction(key({ sequence: "F" }))).toBe("toggle-codex-fast");
  });
});
