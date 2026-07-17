/**
 * Pure CLI routing helpers (argv0 alias + --provider + parseArgs).
 * Unit-tested without touching AccountManager or OpenTUI.
 */

import type { ProviderKind } from "../core/schemas.js";

type CliProviderKind = ProviderKind;

export type CliCommand =
  | "help"
  | "tui"
  | "status"
  | "list"
  | "add"
  | "import"
  | "limits"
  | "quota"
  | "health"
  | "switch"
  | "remove"
  | "enable"
  | "disable"
  | "label"
  | "tag"
  | "note"
  | "refresh"
  | "flag"
  | "unflag"
  | "priority"
  | "prune"
  | "clean-dead";

export const SHARED_COMMANDS = [
  "help",
  "tui",
  "status",
  "list",
  "add",
  "limits",
  "quota",
  "health",
  "switch",
  "remove",
  "enable",
  "disable",
  "label",
  "tag",
  "note",
  "refresh",
  "flag",
  "unflag",
  "priority",
  "prune",
  "clean-dead",
] as const satisfies readonly CliCommand[];

export const CODEX_ONLY_COMMANDS = ["import"] as const satisfies readonly CliCommand[];

export const IMPORT_PROVIDERS = ["codex", "kiro"] as const satisfies readonly ProviderKind[];

/** Commands that may run without --provider when argv0 is op-ai (show both). */
export const PROVIDER_OPTIONAL_COMMANDS = new Set<string>([
  "help",
  "tui",
  "status",
  "list",
]);

/** Mutating / single-provider commands require an explicit provider on op-ai. */
export const PROVIDER_REQUIRED_COMMANDS = new Set<string>([
  "add",
  "import",
  "limits",
  "quota",
  "health",
  "switch",
  "remove",
  "enable",
  "disable",
  "label",
  "tag",
  "note",
  "refresh",
  "flag",
  "unflag",
  "priority",
  "prune",
  "clean-dead",
]);

/**
 * Infer forced provider from process argv0 / bin name.
 * - op-xai / xai-multi / opencode-multi-xai → xai
 * - op-codex / codex-multi / opencode-multi-codex → codex
 * - op-ai / opencode-multi-ai / bare scripts/cli.ts → undefined (use --provider)
 */
export function resolveProviderFromArgv0(
  argv0: string,
): CliProviderKind | undefined {
  const base = argv0
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.ts$/, "")
    .replace(/\.js$/, "")
    .replace(/\.mjs$/, "")
    .replace(/\.cjs$/, "") ?? "";

  if (
    base.includes("op-xai") ||
    base.includes("xai-multi") ||
    base === "opencode-multi-xai" ||
    base.endsWith("multi-xai")
  ) {
    return "xai";
  }
  if (
    base.includes("op-codex") ||
    base.includes("codex-multi") ||
    base === "opencode-multi-codex" ||
    base.endsWith("multi-codex")
  ) {
    return "codex";
  }
  if (
    base.includes("op-kiro") ||
    base.includes("kiro-multi") ||
    base === "opencode-multi-kiro" ||
    base.endsWith("multi-kiro")
  ) {
    return "kiro";
  }
  return undefined;
}

export function parseProviderFlag(
  flags: Record<string, string | boolean>,
): CliProviderKind | undefined {
  const raw = flags.provider;
  if (raw === undefined || raw === true) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "xai" || v === "x" || v === "grok" || v === "supergrok") return "xai";
  if (v === "codex" || v === "c" || v === "chatgpt" || v === "openai") return "codex";
  if (v === "kiro" || v === "k" || v === "codewhisperer") return "kiro";
  return undefined;
}

/**
 * Resolve effective provider for a CLI invocation.
 * Argv0 force wins over --provider (aliases always pin their provider).
 */
export function resolveProvider(opts: {
  argv0: string;
  flags: Record<string, string | boolean>;
}): CliProviderKind | undefined {
  const fromArgv0 = resolveProviderFromArgv0(opts.argv0);
  if (fromArgv0) return fromArgv0;
  return parseProviderFlag(opts.flags);
}

export function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const first = argv[0];
  const startsWithFlags = !first || first.startsWith("-");
  const command = startsWithFlags ? "tui" : first!;
  const rest = startsWithFlags ? argv : argv.slice(1);
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

export function numFlag(
  flags: Record<string, string | boolean>,
  key: string,
): number | undefined {
  const v = flags[key];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function strFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const v = flags[key];
  if (v === undefined || v === true) return undefined;
  return String(v);
}

export function toolNameFor(
  provider: ProviderKind,
  command: string,
): string {
  if (command === "quota") return `${provider}-limits`;
  if (command === "clean-dead") return `${provider}-clean-dead`;
  return `${provider}-${command}`;
}

export function isKnownCommand(
  command: string,
  provider: ProviderKind | undefined,
): boolean {
  if ((SHARED_COMMANDS as readonly string[]).includes(command)) return true;
  if (
    command === "import" &&
    (provider === undefined ||
      (IMPORT_PROVIDERS as readonly string[]).includes(provider))
  ) {
    return true;
  }
  return false;
}

/**
 * Whether this command needs a resolved provider before running tools.
 * help never needs one; tui/status/list can default both or accept optional.
 */
export function requiresProvider(
  command: string,
  forcedFromArgv0: ProviderKind | undefined,
): boolean {
  if (forcedFromArgv0) return false;
  if (command === "help" || command === "-h" || command === "--help") return false;
  if (PROVIDER_OPTIONAL_COMMANDS.has(command)) return false;
  return PROVIDER_REQUIRED_COMMANDS.has(command);
}
