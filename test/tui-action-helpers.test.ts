import { describe, expect, it } from "vitest";

import {
  TUI_BINDINGS,
  advanceConfirmation,
  clearConfirmation,
  decodeTuiAction,
  normalizeTags,
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
    expect(decodeTuiAction(key({ name: "1" }))).toBe("tab-xai");
    expect(decodeTuiAction(key({ name: "2" }))).toBe("tab-codex");
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
