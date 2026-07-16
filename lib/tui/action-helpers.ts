/**
 * Pure TUI action decoding + confirmation + tag normalization.
 * No OpenTUI, no i18n, no mutable globals — unit-testable interaction semantics.
 */

export type TuiAction =
  | "quit"
  | "escape"
  | "tab-xai"
  | "tab-codex"
  | "tab-next"
  | "toggle-locale"
  | "add-device"
  | "add-browser"
  | "switch"
  | "prio-up"
  | "prio-down"
  | "prio-top"
  | "enable"
  | "disable"
  | "label"
  | "tags"
  | "note"
  | "flag"
  | "unflag"
  | "remove"
  | "prune"
  | "refresh"
  | "refresh-all"
  | "toggle-live"
  | "reload"
  | "help";

/** Minimal key-event shape used by decodeTuiAction (OpenTUI-compatible). */
export type TuiKeyEvent = {
  name?: string;
  sequence?: string;
  shift?: boolean;
  ctrl?: boolean;
  /** OpenTUI may set eventType or type for press/release. */
  eventType?: string;
  type?: string;
};

export type TuiBinding = {
  readonly key: string;
  readonly action: TuiAction;
  /** i18n catalog key for the short label (e.g. "switch"). */
  readonly labelKey: string;
  /** i18n catalog key for the long description (e.g. "desc_switch"). */
  readonly descKey: string;
  /** When false, footer/help still list it but UI may soft-hide. */
  readonly available: boolean;
};

/**
 * Canonical binding registry for footer + help generation.
 * Order is display order. Frozen so callers cannot mutate.
 */
export const TUI_BINDINGS: readonly TuiBinding[] = Object.freeze([
  {
    key: "a",
    action: "add-device",
    labelKey: "add_device",
    descKey: "desc_add_device",
    available: true,
  },
  {
    key: "A",
    action: "add-browser",
    labelKey: "add_browser",
    descKey: "desc_add_browser",
    available: true,
  },
  {
    key: "s",
    action: "switch",
    labelKey: "switch",
    descKey: "desc_switch",
    available: true,
  },
  {
    key: "[",
    action: "prio-up",
    labelKey: "prio_up",
    descKey: "desc_prio_up",
    available: true,
  },
  {
    key: "]",
    action: "prio-down",
    labelKey: "prio_down",
    descKey: "desc_prio_down",
    available: true,
  },
  {
    key: "{",
    action: "prio-top",
    labelKey: "prio_top",
    descKey: "desc_prio_top",
    available: true,
  },
  {
    key: "e",
    action: "enable",
    labelKey: "enable",
    descKey: "desc_enable",
    available: true,
  },
  {
    key: "d",
    action: "disable",
    labelKey: "disable",
    descKey: "desc_disable",
    available: true,
  },
  {
    key: "l",
    action: "label",
    labelKey: "label",
    descKey: "desc_label",
    available: true,
  },
  {
    key: "t",
    action: "tags",
    labelKey: "tags",
    descKey: "desc_tags",
    available: true,
  },
  {
    key: "n",
    action: "note",
    labelKey: "note",
    descKey: "desc_note",
    available: true,
  },
  {
    key: "f",
    action: "flag",
    labelKey: "flag",
    descKey: "desc_flag",
    available: true,
  },
  {
    key: "u",
    action: "unflag",
    labelKey: "unflag",
    descKey: "desc_unflag",
    available: true,
  },
  {
    key: "x",
    action: "remove",
    labelKey: "remove",
    descKey: "desc_remove",
    available: true,
  },
  {
    key: "p",
    action: "prune",
    labelKey: "prune",
    descKey: "desc_prune",
    available: true,
  },
  {
    key: "r",
    action: "refresh",
    labelKey: "refresh",
    descKey: "desc_refresh",
    available: true,
  },
  {
    key: "R",
    action: "refresh-all",
    labelKey: "refresh_all",
    descKey: "desc_refresh_all",
    available: true,
  },
  {
    key: "v",
    action: "toggle-live",
    labelKey: "live_quota",
    descKey: "desc_live",
    available: true,
  },
  {
    key: "L",
    action: "reload",
    labelKey: "reload",
    descKey: "desc_reload",
    available: true,
  },
  {
    key: "g",
    action: "toggle-locale",
    labelKey: "lang",
    descKey: "desc_lang",
    available: true,
  },
  {
    key: "?",
    action: "help",
    labelKey: "how_to_add",
    descKey: "desc_how_to_add",
    available: true,
  },
  {
    key: "q",
    action: "quit",
    labelKey: "quit",
    descKey: "desc_quit",
    available: true,
  },
] as const satisfies readonly TuiBinding[]);

export type ConfirmationState =
  | { kind: "none" }
  | { kind: "remove"; provider: "xai" | "codex"; accountId: string }
  | { kind: "prune"; provider: "xai" | "codex" };

export type ConfirmationContext = {
  provider: "xai" | "codex";
  accountId?: string;
};

export type ConfirmationAdvanceResult = {
  next: ConfirmationState;
  confirmed: boolean;
};

function isRelease(key: TuiKeyEvent): boolean {
  const et = (key.eventType ?? key.type ?? "").toLowerCase();
  return et === "release" || et === "keyup";
}

/** CSI / multi-byte escape sequences are never single-letter actions. */
function isCsiOrEsc(seq: string): boolean {
  return seq.startsWith("\x1b") || seq.length > 1;
}

/**
 * Decode a key event into a TuiAction.
 * Uppercase A/R/L via shift or one-char sequence — never lowercased away.
 * Arrow CSI `\x1b[A` must NOT become add-browser.
 */
export function decodeTuiAction(key: TuiKeyEvent): TuiAction | undefined {
  if (isRelease(key)) return undefined;

  const nameRaw = key.name ?? "";
  const name = nameRaw.toLowerCase();
  const seq = key.sequence ?? "";
  const shift = Boolean(key.shift);
  const ctrl = Boolean(key.ctrl);

  if (ctrl && (name === "c" || seq === "\x03")) return "quit";

  // Prefer named navigation / control keys before sequence letter tricks.
  if (name === "escape" || seq === "\x1b") return "escape";
  if (name === "tab") return "tab-next";
  if (name === "up" || name === "down" || name === "left" || name === "right") {
    return undefined;
  }
  if (isCsiOrEsc(seq) && name !== "insert") {
    // Named insert may still carry an escape sequence on some terminals.
    if (name === "" || name === "undefined") return undefined;
    // If we have a recognized name that's not a letter action, fall through
    // only for known action names; otherwise ignore CSI.
    if (!/^[a-z]$/.test(name) && name !== "insert" && name !== "return") {
      return undefined;
    }
  }

  // Device add aliases: + / Insert / shift-=
  if (name === "insert" || seq === "+" || (shift && (name === "=" || seq === "="))) {
    return "add-device";
  }
  if (seq === "+") return "add-device";

  // Priority / help punctuation (sequence-first for reliable shift glyphs)
  if (seq === "{" || (shift && (name === "[" || seq === "["))) return "prio-top";
  if (seq === "[") return "prio-up";
  if (seq === "]") return "prio-down";
  if (seq === "?" || (shift && (name === "/" || seq === "/"))) return "help";

  // One-char sequence uppercase (terminals that omit name/shift)
  if (seq.length === 1 && seq >= "A" && seq <= "Z") {
    switch (seq) {
      case "A":
        return "add-browser";
      case "R":
        return "refresh-all";
      case "L":
        return "reload";
      case "Q":
        return "quit";
      default:
        // Fall through to lowercase letter handling via name/seq lower
        break;
    }
  }

  // Digit tabs
  if (name === "1" || seq === "1") return "tab-xai";
  if (name === "2" || seq === "2") return "tab-codex";

  // Letter actions — shift distinguishes A/R/L
  const letter =
    name.length === 1 && name >= "a" && name <= "z"
      ? name
      : seq.length === 1 && seq >= "a" && seq <= "z"
        ? seq
        : seq.length === 1 && seq >= "A" && seq <= "Z"
          ? seq.toLowerCase()
          : "";

  if (!letter) return undefined;

  if (letter === "q") return "quit";
  if (letter === "g") return "toggle-locale";
  if (letter === "s") return "switch";
  if (letter === "e") return "enable";
  if (letter === "d") return "disable";
  if (letter === "t") return "tags";
  if (letter === "n") return "note";
  if (letter === "f") return "flag";
  if (letter === "u") return "unflag";
  if (letter === "x") return "remove";
  if (letter === "p") return "prune";
  if (letter === "v") return "toggle-live";

  if (letter === "a") return shift || seq === "A" ? "add-browser" : "add-device";
  if (letter === "r") return shift || seq === "R" ? "refresh-all" : "refresh";
  if (letter === "l") return shift || seq === "L" ? "reload" : "label";

  return undefined;
}

/**
 * Two-press confirmation for remove (provider+accountId) and prune (provider).
 * A repeat press only confirms when the armed target still matches.
 * Mismatched target re-arms on the new selection (does not confirm).
 */
export function advanceConfirmation(
  current: ConfirmationState,
  action: "remove" | "prune",
  ctx: ConfirmationContext,
): ConfirmationAdvanceResult {
  if (action === "remove") {
    const accountId = ctx.accountId;
    if (!accountId) {
      return { next: { kind: "none" }, confirmed: false };
    }
    if (
      current.kind === "remove" &&
      current.provider === ctx.provider &&
      current.accountId === accountId
    ) {
      return { next: { kind: "none" }, confirmed: true };
    }
    return {
      next: {
        kind: "remove",
        provider: ctx.provider,
        accountId,
      },
      confirmed: false,
    };
  }

  // prune
  if (current.kind === "prune" && current.provider === ctx.provider) {
    return { next: { kind: "none" }, confirmed: true };
  }
  return {
    next: { kind: "prune", provider: ctx.provider },
    confirmed: false,
  };
}

export function clearConfirmation(
  _current?: ConfirmationState,
): ConfirmationState {
  return { kind: "none" };
}

/**
 * Comma-split tags: trim, drop empty, preserve order + original casing,
 * exact case-sensitive dedupe. Blank → [].
 */
export function normalizeTags(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (!tag) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
