#!/usr/bin/env bun
/**
 * Unified multi-AI CLI (op-ai / op-xai / op-codex / op-kiro / op-opencode-go).
 *
 * Usage:
 *   op-ai                        Open tabbed TUI (default)
 *   op-ai list                   List all providers
 *   op-ai --provider xai list
 *   op-xai list                  Forced xAI (alias)
 *   op-codex import --file ...
 *   op-kiro import --api-key ksk_…
 *   op-opencode-go add --api-key …
 *   bun scripts/cli.ts help
 */

import crypto from "node:crypto";

import type { ToolContext } from "@opencode-ai/plugin";

import {
  AccountManager,
  createDefaultRefreshHandlers,
} from "../lib/core/accounts.js";
import type { ProviderKind } from "../lib/core/schemas.js";
import {
  buildCodexTools,
  buildKiroTools,
  buildOpenCodeGoTools,
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
import { normalizeAuthCookie } from "../lib/providers/opencode-go/dashboard.js";

function usage(forced?: ProviderKind): string {
  const bin =
    forced === "xai"
      ? "op-xai"
      : forced === "codex"
        ? "op-codex"
        : forced === "kiro"
          ? "op-kiro"
          : forced === "opencode-go"
            ? "op-opencode-go"
            : "op-ai";
  const providerHint =
    forced === undefined
      ? "  --provider xai|codex|kiro|opencode-go   Required for mutating commands on op-ai"
      : `  (provider forced: ${forced} via bin name)`;

  const lines = [
    `${bin} — SuperGrok + ChatGPT/Codex + Kiro + OpenCode Go multi-account CLI for OpenCode`,
    "",
    "Usage:",
    `  ${bin}                     Open TUI (default)`,
    `  ${bin} <command> [options]`,
    "  bun scripts/cli.ts <command> [options]",
    "",
    "Provider:",
    providerHint,
    "  Aliases: op-xai / xai-multi → xai;  op-codex / codex-multi → codex;  op-kiro / kiro-multi → kiro;  op-opencode-go → opencode-go",
    "",
    "Commands:",
    "  help                    Show this help",
    "  tui [--lang vi|en] [--provider xai|codex|kiro|opencode-go]",
    "                          Tabbed OpenTUI account manager (default)",
    "  status [--provider …]   Compact pool status (all if omitted on op-ai)",
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
    "  clean-dead [--execute]   Remove dead accounts only",
  ];

  if (forced === undefined || forced === "codex") {
    lines.push(
      "  import --file PATH     Codex: import JSON (9router / auth.json)",
      "  import --json TEXT",
    );
  }
  if (forced === undefined || forced === "kiro") {
    lines.push(
      "  add --api-key ksk_… [--region us-east-1]",
      "  add [--start-url URL] [--idc-region REG] [--profile-arn ARN]",
      "  import --file PATH     Kiro: JSON credentials",
      "  import --json TEXT",
      "  import --api-key ksk_… [--region us-east-1]",
      "  import --export-json TEXT   Kiro Account Manager export",
      "  import --kiro-cli [--kiro-cli-path PATH]",
      "  import --legacy-db PATH",
    );
  }
  if (forced === undefined || forced === "opencode-go") {
    lines.push(
      "  add --api-key KEY [--label LABEL] [--workspace-id ID] [--auth-cookie COOKIE]",
      "                          OpenCode Go: static pool key + optional per-account dashboard cred",
      "  set-cred --id ACCOUNT_ID [--workspace-id ID] [--auth-cookie COOKIE]",
      "                          OpenCode Go: repoint an account at the right workspace dashboard cred",
      "  (rotation: opencode-go-rotate agent tool — restarts opencode to apply)",
    );
  }

  lines.push(
    "",
    "Language: MULTI_AI_LANG=en|vi  or  --lang vi  (default: en)",
    "  In TUI press g to toggle language; Tab / 1 / 2 / 3 switch provider tabs.",
    "",
    "Examples:",
    `  ${bin}`,
    `  ${bin} list`,
    "  op-ai --provider xai limits --probe",
    "  op-xai switch --index 0",
    "  op-codex import --file ~/.codex/auth.json",
    "  op-kiro add",
    "  op-kiro import --api-key ksk_…",
    "  op-codex remove --index 1 --confirm",
    "",
    "Add account:",
    "  opencode auth login   # pick xai-multi / codex-multi / kiro-multi",
    "  op-xai add | op-codex add | op-kiro add",
    "  op-opencode-go add --api-key …   (static key; no OAuth)",
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
  return new AccountManager(storagePath, createDefaultRefreshHandlers());
}

function toolsFor(
  manager: AccountManager,
  provider: ProviderKind,
): Record<string, import("@opencode-ai/plugin").ToolDefinition> {
  if (provider === "xai") return buildXaiTools(manager);
  if (provider === "codex") return buildCodexTools(manager);
  if (provider === "kiro") return buildKiroTools(manager);
  return buildOpenCodeGoTools(manager);
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

  if (provider === "codex") {
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
    return;
  }

  if (provider === "opencode-go") {
    const manager = createManager();
    await manager.load();
    const apiKey = strFlag(flags, "api-key") ?? strFlag(flags, "apiKey");
    if (!apiKey) {
      console.error(
        "op-opencode-go add requires --api-key KEY [--label LABEL] " +
          "[--workspace-id ID] [--auth-cookie COOKIE]\n\n" +
          "The key is stored in the multi-ai pool. Run opencode-go-rotate " +
          "(or restart opencode after switching) to make it the active " +
          "auth.json key. Per-account --workspace-id/--auth-cookie are " +
          "optional dashboard creds; when omitted the probe falls back to " +
          "env (MULTI_AI_OPENCODE_GO_*).",
      );
      process.exitCode = 1;
      return;
    }
    const view = manager.providerView("opencode-go");
    const id = crypto.randomUUID();
    const label = strFlag(flags, "label");
    const workspaceId = strFlag(flags, "workspace-id");
    const authCookieInput = strFlag(flags, "auth-cookie");
    const authCookie =
      authCookieInput && authCookieInput.trim().length > 0
        ? normalizeAuthCookie(authCookieInput)
        : undefined;
    await view.add({
      provider: "opencode-go",
      accountId: id,
      refreshToken: apiKey,
      accessToken: apiKey,
      label: label && label.trim().length > 0 ? label.trim() : undefined,
      tags: [],
      enabled: true,
      priority: 0,
      addedAt: Date.now(),
      lastUsed: 0,
      lastSwitchReason: "initial",
      subscriptionStatus: "active",
      flaggedForRemoval: false,
      entitlementBlocked: false,
      // Per-account dashboard cred (omitted → env fallback at probe time).
      openCodeGoWorkspaceId:
        workspaceId && workspaceId.trim().length > 0
          ? workspaceId.trim()
          : undefined,
      openCodeGoAuthCookie: authCookie,
    });
    console.log(`Added OpenCode Go account ${id.slice(0, 12)}…`);
    return;
  }

  const {
    loginWithApiKey,
    loginWithIdcDevice,
  } = await import("../lib/providers/kiro/auth/login.js");
  const apiKey = strFlag(flags, "api-key") ?? strFlag(flags, "apiKey");
  const region = strFlag(flags, "region");
  if (apiKey) {
    console.log("Importing Kiro API key…");
    const account = await loginWithApiKey(apiKey, region);
    const outcome = await view.upsertFromOAuth(account);
    console.log(
      outcome === "added"
        ? `Added account ${account.email ?? account.accountId}`
        : `Updated account ${account.email ?? account.accountId}`,
    );
    return;
  }

  const startUrl = strFlag(flags, "start-url") ?? strFlag(flags, "startUrl");
  const profileArn =
    strFlag(flags, "profile-arn") ?? strFlag(flags, "profileArn");
  const idcRegion =
    strFlag(flags, "idc-region") ?? strFlag(flags, "idcRegion") ?? region;
  console.log(
    profileArn
      ? "Starting Kiro IDC device OAuth (with Profile ARN)…"
      : "Starting Kiro IDC device OAuth (AWS Builder ID / Identity Center)…",
  );
  const account = await loginWithIdcDevice(
    {
      startUrl,
      idcRegion,
      profileArn,
      openBrowser: useBrowser || true,
    },
    (prompt) => {
      console.log("");
      console.log(`Open: ${prompt.verificationUri}`);
      console.log(`Code: ${prompt.userCode}`);
      if (prompt.verificationUriComplete) {
        console.log(`One-click: ${prompt.verificationUriComplete}`);
      }
      console.log("Waiting for authorization…");
    },
  );
  const outcome = await view.upsertFromOAuth(account);
  console.log(
    outcome === "added"
      ? `Added account ${account.email ?? account.accountId}`
      : `Updated account ${account.email ?? account.accountId}`,
  );
}

async function runImport(
  provider: ProviderKind,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (provider === "codex") {
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
    return;
  }

  if (provider === "kiro") {
    await runToolCommand("kiro", "import", flags);
    return;
  }

  console.error("import is Codex- or Kiro-only. Use op-codex / op-kiro.");
  process.exitCode = 1;
}

async function runToolCommand(
  provider: ProviderKind,
  command: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const manager = createManager();
  await manager.load();
  const tools = toolsFor(manager, provider);
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
  if (command === "prune" || command === "clean-dead") {
    args.dryRun = flags.execute !== true && flags.execute !== "true";
    if (command === "prune") {
      const tag = strFlag(flags, "tag");
      if (tag) args.tag = tag;
    }
  }
  if (command === "import") {
    const file = strFlag(flags, "file") ?? strFlag(flags, "path");
    const json = strFlag(flags, "json");
    const apiKey = strFlag(flags, "api-key") ?? strFlag(flags, "apiKey");
    const region = strFlag(flags, "region");
    const exportJson =
      strFlag(flags, "export-json") ?? strFlag(flags, "exportJson");
    const kiroCliPath =
      strFlag(flags, "kiro-cli-path") ?? strFlag(flags, "kiroCliPath");
    const legacyDb =
      strFlag(flags, "legacy-db") ?? strFlag(flags, "legacyDb");
    if (file) args.file = file;
    if (json) args.json = json;
    if (apiKey) args.apiKey = apiKey;
    if (region) args.region = region;
    if (exportJson) args.exportJson = exportJson;
    if (flags["kiro-cli"] === true || flags.kiroCli === true) {
      args.kiroCli = true;
    }
    if (kiroCliPath) {
      args.kiroCli = true;
      args.kiroCliPath = kiroCliPath;
    }
    if (legacyDb) args.legacyDb = legacyDb;
    if (flags["skip-validate"] === true || flags.skipValidate === true) {
      args.skipValidate = true;
    }
  }

  const out = await tool.execute(args, toolCtx());
  console.log(out);
}

async function runStatusBoth(): Promise<void> {
  const manager = createManager();
  await manager.load();
  const { all } = buildTools(manager);
  for (const key of [
    "xai-status",
    "codex-status",
    "kiro-status",
    "opencode-go-status",
  ] as const) {
    const t = all[key];
    if (t) console.log(await t.execute({}, toolCtx()));
  }
}

async function runListBoth(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const manager = createManager();
  await manager.load();
  const { all } = buildTools(manager);
  const tag = strFlag(flags, "tag");
  const args = tag ? { tag } : {};
  let first = true;
  for (const key of [
    "xai-list",
    "codex-list",
    "kiro-list",
    "opencode-go-list",
  ] as const) {
    const t = all[key];
    if (!t) continue;
    if (!first) console.log("");
    first = false;
    console.log(await t.execute(args, toolCtx()));
  }
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
      initialTab: provider ?? forced ?? "codex",
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
    console.error(
      "import is Codex- or Kiro-only. Use op-codex / op-kiro or --provider codex|kiro.",
    );
    process.exitCode = 1;
    return;
  }

  if (requiresProvider(command, forced) && !provider) {
    console.error(
      `Command "${command}" requires --provider xai|codex|kiro|opencode-go\n` +
        `(or use op-xai / op-codex / op-kiro / op-opencode-go alias)\n`,
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
  if (command === "set-cred") {
    const accountId = strFlag(flags, "id");
    if (!accountId || !accountId.trim()) {
      console.error(
        "op-opencode-go set-cred requires --id ACCOUNT_ID " +
          "[--workspace-id WRK_ID] [--auth-cookie COOKIE]\n\n" +
          "Both --workspace-id and --auth-cookie are a PAIR: provide them " +
          "together to set (blank both to clear; omit to keep). The cookie's " +
          "auth= prefix is stripped automatically and it is never printed.",
      );
      process.exitCode = 1;
      return;
    }
    const manager = createManager();
    await manager.load();
    const trimmedId = accountId.trim();
    const workspaceId = strFlag(flags, "workspace-id");
    const authCookie = strFlag(flags, "auth-cookie");
    const partial: {
      workspaceId?: string;
      authCookie?: string;
    } = {};
    if (workspaceId !== undefined) {
      partial.workspaceId =
        workspaceId.trim().length > 0 ? workspaceId.trim() : undefined;
    }
    if (authCookie !== undefined) {
      partial.authCookie =
        authCookie.trim().length > 0
          ? normalizeAuthCookie(authCookie.trim())
          : undefined;
    }
    const view = manager.providerView("opencode-go");
    const updated = await view.setOpenCodeGoCred(trimmedId, partial);
    if (!updated) {
      console.error(
        `set-cred: opencode-go account ${trimmedId.slice(0, 12)}… not found ` +
          `or no longer accepts cred updates.`,
      );
      process.exitCode = 1;
      return;
    }
    const wsDisplay = updated.openCodeGoWorkspaceId
      ? `workspace=${updated.openCodeGoWorkspaceId.slice(0, 12)}…`
      : "workspace=(unchanged)";
    const cookieDisplay = authCookie !== undefined
      ? partial.authCookie
        ? "cookie=set"
        : "cookie=cleared"
      : "cookie=(unchanged)";
    console.log(
      `Updated opencode-go account ${trimmedId.slice(0, 12)}… (${wsDisplay}, ${cookieDisplay}). ` +
        `Press r to probe.`,
    );
    return;
  }
  if (command === "import") {
      await runImport(provider!, flags);
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
