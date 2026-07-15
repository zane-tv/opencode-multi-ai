#!/usr/bin/env bun
/**
 * Unified multi-AI CLI (op-ai / op-xai / op-codex).
 *
 * Usage:
 *   op-ai                        Open tabbed TUI (default)
 *   op-ai list                   List both providers
 *   op-ai --provider xai list
 *   op-xai list                  Forced xAI (alias)
 *   op-codex import --file ...
 *   bun scripts/cli.ts help
 */

import type { ToolContext } from "@opencode-ai/plugin";

import { AccountManager } from "../lib/core/accounts.js";
import type { ProviderKind } from "../lib/core/schemas.js";
import {
  buildCodexTools,
  buildTools,
  buildXaiTools,
} from "../lib/tools/registry.js";
import {
  isKnownCommand,
  numFlag,
  parseArgs,
  requiresProvider,
  resolveProvider,
  resolveProviderFromArgv0,
  strFlag,
  toolNameFor,
} from "../lib/cli/routing.js";

function usage(forced?: ProviderKind): string {
  const bin =
    forced === "xai" ? "op-xai" : forced === "codex" ? "op-codex" : "op-ai";
  const providerHint =
    forced === undefined
      ? "  --provider xai|codex   Required for mutating commands on op-ai"
      : `  (provider forced: ${forced} via bin name)`;

  const lines = [
    `${bin} — SuperGrok + ChatGPT/Codex multi-account CLI for OpenCode`,
    "",
    "Usage:",
    `  ${bin}                     Open TUI (default)`,
    `  ${bin} <command> [options]`,
    "  bun scripts/cli.ts <command> [options]",
    "",
    "Provider:",
    providerHint,
    "  Aliases: op-xai / xai-multi → xai;  op-codex / codex-multi → codex",
    "",
    "Commands:",
    "  help                    Show this help",
    "  tui [--lang vi|en] [--provider xai|codex]",
    "                          Tabbed OpenTUI account manager (default)",
    "  status [--provider …]   Compact pool status (both if omitted on op-ai)",
    "  list [--tag NAME] [--provider …]",
    "  add [--browser] [--provider …]",
    "  limits|quota [--probe] [--provider …]",
    "  health [--provider …]",
    "  switch --index N | --id PREFIX  [--provider …]",
    "  remove --index N --confirm      [--provider …]",
    "  enable|disable --index N | --id PREFIX",
    "  label --index N --label TEXT",
    "  tag --index N --tags a,b,c",
    "  note --index N --note TEXT",
    "  refresh --index N | --id PREFIX",
    "  flag|unflag --index N | --id PREFIX",
    "  priority --index N --direction up|down|top",
    "  priority --index N --priority N",
    "  prune [--tag NAME] [--execute]",
  ];

  if (forced === undefined || forced === "codex") {
    lines.push(
      "  import --file PATH     Codex only: import JSON (9router / auth.json)",
      "  import --json TEXT",
    );
  }

  lines.push(
    "",
    "Language: MULTI_AI_LANG=en|vi  or  --lang vi  (default: en)",
    "  In TUI press g to toggle language; Tab / 1 / 2 switch provider tabs.",
    "",
    "Examples:",
    `  ${bin}`,
    `  ${bin} list`,
    "  op-ai --provider xai limits --probe",
    "  op-xai switch --index 0",
    "  op-codex import --file ~/.codex/auth.json",
    "  op-codex remove --index 1 --confirm",
    "",
    "Add account:",
    "  opencode auth login   # pick xai-multi or codex-multi",
    "  op-xai add | op-codex add | op-ai --provider xai add",
    "",
    "Note: do not run `opencode xai-add` / `opencode codex-add` —",
    "OpenCode treats those as project paths.",
  );
  return lines.join("\n");
}

function toolCtx(): ToolContext {
  return {
    sessionID: "cli",
    messageID: "cli",
    agent: "cli",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function createManager(storagePath?: string): AccountManager {
  // Refresh handlers are optional for list/status; health/refresh need them.
  // Wire real OAuth refresh so force-refresh tools work in CLI.
  return new AccountManager(storagePath, {
    xai: async (refreshToken) => {
      const { refreshTokens } = await import(
        "../lib/providers/xai/auth/oauth.js"
      );
      return refreshTokens(refreshToken);
    },
    codex: async (refreshToken) => {
      const { refreshTokens } = await import(
        "../lib/providers/codex/auth/oauth.js"
      );
      return refreshTokens(refreshToken);
    },
  });
}

async function runAdd(
  provider: ProviderKind,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const manager = createManager();
  await manager.load();
  const view = manager.providerView(provider);
  const useBrowser = flags.browser === true || flags.browser === "true";

  if (provider === "xai") {
    const { browserLogin, deviceCodeLoginFlow } = await import(
      "../lib/providers/xai/auth/login.js"
    );
    if (useBrowser) {
      console.log(
        "Starting browser OAuth (loopback http://127.0.0.1:56121/callback)…",
      );
      const result = await browserLogin(view, {
        onAuthorizeUrl: (url) => console.log(`Open: ${url}`),
      });
      console.log(
        result.outcome === "added"
          ? `Added account ${result.email ?? result.accountId}`
          : `Updated account ${result.email ?? result.accountId}`,
      );
    } else {
      console.log("Starting device OAuth…");
      const result = await deviceCodeLoginFlow(view, (prompt) => {
        console.log("");
        console.log(`Open: ${prompt.verificationUri}`);
        console.log(`Code: ${prompt.userCode}`);
        if (prompt.verificationUriComplete) {
          console.log(`One-click: ${prompt.verificationUriComplete}`);
        }
        console.log(`Expires in ~${prompt.expiresIn}s`);
        console.log("Waiting for authorization…");
      });
      console.log(
        result.outcome === "added"
          ? `Added account ${result.email ?? result.accountId}`
          : `Updated account ${result.email ?? result.accountId}`,
      );
    }
    return;
  }

  const { browserLogin, deviceCodeLoginFlow } = await import(
    "../lib/providers/codex/auth/login.js"
  );
  if (useBrowser) {
    console.log(
      "Starting browser OAuth (loopback http://localhost:1455/auth/callback)…",
    );
    const result = await browserLogin(view, {
      onAuthorizeUrl: (url) => console.log(`Open: ${url}`),
    });
    console.log(
      result.outcome === "added"
        ? `Added account ${result.email ?? result.accountId}`
        : `Updated account ${result.email ?? result.accountId}`,
    );
  } else {
    console.log("Starting device OAuth…");
    const result = await deviceCodeLoginFlow(view, (prompt) => {
      console.log("");
      console.log(`Open: ${prompt.verificationUri}`);
      console.log(`Code: ${prompt.userCode}`);
      if (prompt.verificationUriComplete) {
        console.log(`One-click: ${prompt.verificationUriComplete}`);
      }
      console.log(`Expires in ~${prompt.expiresIn}s`);
      console.log("Waiting for authorization…");
    });
    console.log(
      result.outcome === "added"
        ? `Added account ${result.email ?? result.accountId}`
        : `Updated account ${result.email ?? result.accountId}`,
    );
  }
}

async function runImport(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const manager = createManager();
  await manager.load();
  const view = manager.providerView("codex");
  const {
    importAccountsFromJsonFile,
    importAccountsFromJsonText,
  } = await import("../lib/providers/codex/auth/import-json.js");
  const file = strFlag(flags, "file") ?? strFlag(flags, "path");
  const json = strFlag(flags, "json");
  if (!file && !json) {
    console.error(
      "import requires --file PATH or --json TEXT\n\n" +
        "Examples:\n" +
        "  op-codex import --file ./accounts.json\n" +
        "  op-codex import --file ~/.codex/auth.json\n" +
        "  op-codex import --json '{\"accessToken\":\"…\",\"refreshToken\":\"…\"}'",
    );
    process.exitCode = 1;
    return;
  }
  const result = file
    ? await importAccountsFromJsonFile(view, file)
    : await importAccountsFromJsonText(view, json!);
  for (const row of result.results) {
    if (row.ok) {
      const who = row.email ?? row.accountId.slice(0, 12);
      console.log(
        row.outcome === "added"
          ? `[${row.index}] added ${who}`
          : `[${row.index}] updated ${who}`,
      );
    } else {
      console.error(`[${row.index}] failed: ${row.error}`);
    }
  }
  console.log(`Import done · ${result.success} ok · ${result.failed} failed`);
  if (result.failed > 0) process.exitCode = 1;
}

async function runToolCommand(
  provider: ProviderKind,
  command: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const manager = createManager();
  await manager.load();
  const tools =
    provider === "xai" ? buildXaiTools(manager) : buildCodexTools(manager);
  const name = toolNameFor(provider, command);
  const tool = tools[name];
  if (!tool) {
    console.error(`Tool not registered: ${name}`);
    process.exitCode = 1;
    return;
  }

  const args: Record<string, unknown> = {};
  const index = numFlag(flags, "index");
  const id = strFlag(flags, "id");
  if (index !== undefined) args.index = index;
  if (id !== undefined) args.id = id;

  if (command === "list") {
    const tag = strFlag(flags, "tag");
    if (tag) args.tag = tag;
  }
  if (command === "limits" || command === "quota") {
    if (flags.probe === true || flags.probe === "true") args.probe = true;
  }
  if (command === "remove") {
    args.confirm = flags.confirm === true || flags.confirm === "true";
  }
  if (command === "label") {
    args.label = strFlag(flags, "label") ?? "";
  }
  if (command === "tag") {
    args.tags = strFlag(flags, "tags") ?? "";
  }
  if (command === "note") {
    args.note = strFlag(flags, "note") ?? "";
  }
  if (command === "priority") {
    const direction = strFlag(flags, "direction");
    if (direction) args.direction = direction;
    const pr = numFlag(flags, "priority");
    if (pr !== undefined) args.priority = pr;
  }
  if (command === "prune") {
    args.dryRun = flags.execute !== true && flags.execute !== "true";
    const tag = strFlag(flags, "tag");
    if (tag) args.tag = tag;
  }
  if (command === "import") {
    const file = strFlag(flags, "file") ?? strFlag(flags, "path");
    const json = strFlag(flags, "json");
    if (file) args.file = file;
    if (json) args.json = json;
  }

  const out = await tool.execute(args, toolCtx());
  console.log(out);
}

async function runStatusBoth(): Promise<void> {
  const manager = createManager();
  await manager.load();
  const { all } = buildTools(manager);
  const xai = all["xai-status"];
  const codex = all["codex-status"];
  if (xai) console.log(await xai.execute({}, toolCtx()));
  if (codex) console.log(await codex.execute({}, toolCtx()));
}

async function runListBoth(flags: Record<string, string | boolean>): Promise<void> {
  const manager = createManager();
  await manager.load();
  const { all } = buildTools(manager);
  const tag = strFlag(flags, "tag");
  const args = tag ? { tag } : {};
  const xai = all["xai-list"];
  const codex = all["codex-list"];
  if (xai) console.log(await xai.execute(args, toolCtx()));
  console.log("");
  if (codex) console.log(await codex.execute(args, toolCtx()));
}

async function main(): Promise<void> {
  const argv0 = process.argv[1] ?? "op-ai";
  const forced = resolveProviderFromArgv0(argv0);
  const { command, flags } = parseArgs(process.argv.slice(2));
  const provider = resolveProvider({ argv0, flags });

  if (command === "help" || command === "-h" || command === "--help") {
    console.log(usage(forced));
    return;
  }

  if (command === "tui") {
    const lang = strFlag(flags, "lang");
    if (lang === "en" || lang === "vi") {
      const { setLocale } = await import("../lib/core/i18n.js");
      setLocale(lang);
    }
    const { runTui } = await import("../lib/tui/app.js");
    await runTui({
      initialTab: provider ?? forced ?? "xai",
      manager: createManager(),
    });
    return;
  }

  if (!isKnownCommand(command, provider ?? forced)) {
    console.error(`Unknown command: ${command}\n`);
    console.error(usage(forced));
    process.exitCode = 1;
    return;
  }

  if (command === "import" && (provider ?? forced) === "xai") {
    console.error("import is Codex-only. Use op-codex or --provider codex.");
    process.exitCode = 1;
    return;
  }

  if (requiresProvider(command, forced) && !provider) {
    console.error(
      `Command "${command}" requires --provider xai|codex\n` +
        `(or use op-xai / op-codex alias)\n`,
    );
    console.error(usage(undefined));
    process.exitCode = 1;
    return;
  }

  try {
    if (command === "add") {
      await runAdd(provider!, flags);
      return;
    }
    if (command === "import") {
      await runImport(flags);
      return;
    }
    if (!provider && (command === "status" || command === "list")) {
      if (command === "status") await runStatusBoth();
      else await runListBoth(flags);
      return;
    }
    await runToolCommand(provider!, command, flags);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

main();
