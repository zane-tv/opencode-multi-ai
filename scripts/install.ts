/**
 * Dual-provider installer for opencode-multi-ai.
 *
 * Writes BOTH OpenCode provider entries (`xai-multi` + `codex-multi`) into the
 * user's global `opencode.json`, optionally registers BOTH plugin modules, and
 * replaces legacy single-package plugin entries (`opencode-multi-xai` /
 * `opencode-multi-codex`). Never touches built-in `xai` / `openai` providers.
 *
 * Run:
 *   bun scripts/install.ts
 *   bun scripts/install.ts --with-plugin-entry
 *   bun scripts/install.ts --config /path/to/opencode.json
 *
 * DESIGN
 * - Idempotent: second run is a no-op for already-complete config.
 * - Backs up existing opencode.json before rewrite (once per distinct content).
 * - Missing config → empty object; malformed JSON → throw (never overwrite).
 * - User renames / option overrides / model edits win over defaults.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  CODEX_BASE_URL,
  DUMMY_API_KEY,
  PROVIDER_ID as CODEX_PROVIDER_ID,
} from "../lib/providers/codex/constants.js";
import {
  CODEX_PROVIDER_DEFAULT_OPTIONS,
  resolveCodexMultiModels,
} from "../lib/providers/codex/models-sync.js";
import {
  DEFAULT_MODELS as XAI_DEFAULT_MODELS,
  PROVIDER_ID as XAI_PROVIDER_ID,
  XAI_API_BASE,
} from "../lib/providers/xai/constants.js";
import { resolveXaiMultiModels } from "../lib/providers/xai/models-sync.js";

/** npm package name (matches package.json "name"). */
export const PLUGIN_PACKAGE = "opencode-multi-ai";

/** Legacy single-provider packages this installer supersedes. */
export const LEGACY_PLUGIN_PACKAGES = [
  "opencode-multi-xai",
  "opencode-multi-codex",
] as const;

/** Built-in provider ids we must never write or overwrite. */
export const BUILTIN_PROVIDER_IDS = ["xai", "openai"] as const;

const XAI_PROVIDER_NPM = "@ai-sdk/xai";
const XAI_PROVIDER_NAME = "Grok Multi-Account";
const CODEX_PROVIDER_NPM = "@ai-sdk/openai";
const CODEX_PROVIDER_NAME = "Codex Multi-Account";

const CONFIG_SCHEMA = "https://opencode.ai/config.json";

/** Absolute package root (parent of scripts/). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Single package-root path; loads both providers via named exports in index.ts. */
export function defaultPluginEntries(root: string = packageRoot()): string[] {
  return [root];
}

/** Historical dual-module subpaths (still recognized; install rewrites to root). */
export const PLUGIN_PACKAGE_SUBPATHS = [
  `${PLUGIN_PACKAGE}/lib/plugin/xai`,
  `${PLUGIN_PACKAGE}/lib/plugin/codex`,
] as const;

export interface ProviderChange {
  id: string;
  added: boolean;
  updated: boolean;
}

export interface InstallResult {
  configPath: string;
  created: boolean;
  backedUp: boolean;
  backupPath: string | null;
  providers: ProviderChange[];
  pluginEntriesAdded: string[];
  legacyPluginsRemoved: string[];
  config: Record<string, unknown>;
}

export interface InstallOptions {
  /**
   * Register both plugin modules in the config `plugin` array.
   * Default false (local OpenCode plugins dir may already load them).
   */
  withPluginEntry?: boolean;
  /**
   * Absolute paths or package subpaths to write as plugin entries.
   * Defaults to absolute `lib/plugin/{xai,codex}.ts` under this package.
   */
  pluginEntries?: string[];
  /** Skip writing a `.bak` next to the config. Default false. */
  skipBackup?: boolean;
}

/** Default global OpenCode config path (OPENCODE_CONFIG wins when set). */
export function defaultConfigPath(): string {
  const fromEnv = process.env.OPENCODE_CONFIG?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readConfig(
  configPath: string,
): Promise<{ config: Record<string, unknown>; created: boolean; raw: string | null }> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: {}, created: true, raw: null };
    }
    throw err;
  }

  if (raw.trim().length === 0) {
    return { config: {}, created: false, raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Refusing to overwrite malformed JSON in ${configPath}: ${
        (err as Error).message
      }. Fix or remove the file, then re-run.`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `Refusing to overwrite ${configPath}: expected a JSON object at the top ` +
        `level but found ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    );
  }

  return { config: parsed, created: false, raw };
}

/**
 * Normalize a plugin array item to a comparable string.
 * Supports string entries and rare tuple/object forms `{ package: "…" }` /
 * `["name", opts]`.
 */
export function pluginEntryKey(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
  if (isPlainObject(entry)) {
    if (typeof entry.package === "string") return entry.package;
    if (typeof entry.path === "string") return entry.path;
    if (typeof entry.name === "string") return entry.name;
  }
  return null;
}

function isLegacyPluginKey(key: string): boolean {
  for (const legacy of LEGACY_PLUGIN_PACKAGES) {
    if (key === legacy) return true;
    // Absolute / relative paths that clearly point at the old packages.
    if (key.includes(`/${legacy}`) || key.includes(`\\${legacy}`)) return true;
    if (key.endsWith(legacy)) return true;
  }
  return false;
}

export function isOurPluginKey(key: string, desired: string[] = []): boolean {
  if (desired.includes(key)) return true;
  for (const sub of PLUGIN_PACKAGE_SUBPATHS) {
    if (key === sub) return true;
  }
  if (key === PLUGIN_PACKAGE) return true;
  const n = key.replace(/\\/g, "/");
  if (n.endsWith(`/${PLUGIN_PACKAGE}`) || n.endsWith(`/${PLUGIN_PACKAGE}/`)) {
    return true;
  }
  if (n.endsWith(`/${PLUGIN_PACKAGE}/index.ts`)) return true;
  if (n.includes(`/${PLUGIN_PACKAGE}/lib/plugin/`)) return true;
  if (key.includes(`${path.sep}lib${path.sep}plugin${path.sep}xai`)) return true;
  if (key.includes(`${path.sep}lib${path.sep}plugin${path.sep}codex`)) return true;
  if (key.includes("/lib/plugin/xai") || key.includes("/lib/plugin/codex")) {
    return true;
  }
  return false;
}

export function stripOurPluginEntries(
  config: Record<string, unknown>,
): string[] {
  const current = config.plugin;
  if (!Array.isArray(current)) return [];

  const removed: string[] = [];
  const next: unknown[] = [];
  for (const entry of current) {
    const key = pluginEntryKey(entry);
    if (key !== null && isOurPluginKey(key)) {
      removed.push(key);
      continue;
    }
    next.push(entry);
  }
  config.plugin = next;
  return removed;
}

/**
 * Strip legacy single-package plugin entries; preserve unrelated plugins.
 * Returns removed keys (display strings).
 */
export function stripLegacyPluginEntries(
  config: Record<string, unknown>,
): string[] {
  const current = config.plugin;
  if (!Array.isArray(current)) return [];

  const removed: string[] = [];
  const next: unknown[] = [];
  for (const entry of current) {
    const key = pluginEntryKey(entry);
    if (key !== null && isLegacyPluginKey(key)) {
      removed.push(key);
      continue;
    }
    next.push(entry);
  }
  config.plugin = next;
  return removed;
}

/**
 * Ensure each desired plugin entry appears exactly once.
 * Returns the list of entries that were newly appended.
 */
export function mergePluginEntries(
  config: Record<string, unknown>,
  desired: string[],
): string[] {
  const current = config.plugin;
  const list: unknown[] = Array.isArray(current) ? [...current] : [];
  const existingKeys = new Set(
    list
      .map((e) => pluginEntryKey(e))
      .filter((k): k is string => typeof k === "string"),
  );

  const added: string[] = [];
  for (const entry of desired) {
    // Already present as this exact string, or as a package-subpath equivalent.
    if (existingKeys.has(entry)) continue;
    let already = false;
    for (const key of existingKeys) {
      if (isOurPluginKey(key, [entry]) && pathsReferToSamePlugin(key, entry)) {
        already = true;
        break;
      }
    }
    if (already) continue;
    list.push(entry);
    existingKeys.add(entry);
    added.push(entry);
  }
  config.plugin = list;
  return added;
}

function pathsReferToSamePlugin(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\.ts$/, "");
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (isOurPluginKey(a) && isOurPluginKey(b)) return true;
  const aXai = na.includes("plugin/xai") || na.endsWith("/xai");
  const bXai = nb.includes("plugin/xai") || nb.endsWith("/xai");
  const aCodex = na.includes("plugin/codex") || na.endsWith("/codex");
  const bCodex = nb.includes("plugin/codex") || nb.endsWith("/codex");
  if (aXai && bXai) return true;
  if (aCodex && bCodex) return true;
  return false;
}

async function mergeXaiProvider(
  config: Record<string, unknown>,
): Promise<ProviderChange> {
  if (!isPlainObject(config.provider)) {
    config.provider = {};
  }
  const provider = config.provider as Record<string, unknown>;

  // Never touch built-ins.
  void BUILTIN_PROVIDER_IDS;

  const existing = isPlainObject(provider[XAI_PROVIDER_ID])
    ? (provider[XAI_PROVIDER_ID] as Record<string, unknown>)
    : undefined;

  const added = existing === undefined;
  let updated = false;
  const entry: Record<string, unknown> = { ...(existing ?? {}) };

  if (entry.npm === undefined) {
    entry.npm = XAI_PROVIDER_NPM;
    if (!added) updated = true;
  }
  if (entry.name === undefined) {
    entry.name = XAI_PROVIDER_NAME;
    if (!added) updated = true;
  }

  const options = isPlainObject(entry.options)
    ? { ...(entry.options as Record<string, unknown>) }
    : {};
  if (options.baseURL === undefined) {
    options.baseURL = XAI_API_BASE;
    if (!added) updated = true;
  }
  if (
    options.apiKey === undefined ||
    options.apiKey === null ||
    options.apiKey === ""
  ) {
    // Dummy only — real bearer is injected by the plugin customFetch.
    options.apiKey = "multi-xai-dummy-key";
    if (!added) updated = true;
  }
  entry.options = options;

  const prevModels = isPlainObject(entry.models)
    ? (entry.models as Record<string, unknown>)
    : {};
  const nextModels = await resolveXaiMultiModels({
    allowNetwork: false,
    userModels: prevModels,
  });
  // Ensure bundled defaults seed when cache is empty/missing.
  for (const [id, def] of Object.entries(XAI_DEFAULT_MODELS)) {
    if (!(id in nextModels)) {
      nextModels[id] = def;
    }
  }
  if (JSON.stringify(prevModels) !== JSON.stringify(nextModels)) {
    if (!added) updated = true;
  }
  entry.models = nextModels;

  provider[XAI_PROVIDER_ID] = entry;
  return { id: XAI_PROVIDER_ID, added, updated };
}

async function mergeCodexProvider(
  config: Record<string, unknown>,
): Promise<ProviderChange> {
  if (!isPlainObject(config.provider)) {
    config.provider = {};
  }
  const provider = config.provider as Record<string, unknown>;

  const existing = isPlainObject(provider[CODEX_PROVIDER_ID])
    ? (provider[CODEX_PROVIDER_ID] as Record<string, unknown>)
    : undefined;

  const added = existing === undefined;
  let updated = false;
  const entry: Record<string, unknown> = { ...(existing ?? {}) };

  if (entry.npm === undefined) {
    entry.npm = CODEX_PROVIDER_NPM;
    if (!added) updated = true;
  }
  if (entry.name === undefined) {
    entry.name = CODEX_PROVIDER_NAME;
    if (!added) updated = true;
  }

  const options = isPlainObject(entry.options)
    ? { ...(entry.options as Record<string, unknown>) }
    : {};
  if (options.baseURL === undefined) {
    options.baseURL = CODEX_BASE_URL;
    if (!added) updated = true;
  }
  if (
    options.apiKey === undefined ||
    options.apiKey === null ||
    options.apiKey === ""
  ) {
    options.apiKey = DUMMY_API_KEY;
    if (!added) updated = true;
  }
  for (const [key, value] of Object.entries(CODEX_PROVIDER_DEFAULT_OPTIONS)) {
    if (options[key] === undefined) {
      options[key] = value;
      if (!added) updated = true;
    }
  }
  entry.options = options;

  const prevModels = isPlainObject(entry.models)
    ? (entry.models as Record<string, unknown>)
    : {};
  const defaultModels = await resolveCodexMultiModels({ allowNetwork: false });
  const nextModels = await resolveCodexMultiModels({
    allowNetwork: false,
    userModels: prevModels,
  });
  for (const [id, def] of Object.entries(defaultModels)) {
    const cur = nextModels[id];
    if (!isPlainObject(cur) || !isPlainObject(def)) continue;
    const defVariants = (def as Record<string, unknown>).variants;
    if (isPlainObject(defVariants)) {
      (cur as Record<string, unknown>).variants = { ...defVariants };
    }
  }
  if (JSON.stringify(prevModels) !== JSON.stringify(nextModels)) {
    if (!added) updated = true;
  }
  entry.models = nextModels;

  provider[CODEX_PROVIDER_ID] = entry;
  return { id: CODEX_PROVIDER_ID, added, updated };
}

async function maybeBackup(
  configPath: string,
  raw: string | null,
  skip: boolean | undefined,
): Promise<{ backedUp: boolean; backupPath: string | null }> {
  if (skip || raw === null) {
    return { backedUp: false, backupPath: null };
  }
  const backupPath = `${configPath}.bak`;
  try {
    // Never clobber an existing .bak (user may want the first original).
    await readFile(backupPath, "utf8");
    return { backedUp: false, backupPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  await copyFile(configPath, backupPath);
  return { backedUp: true, backupPath };
}

/**
 * Write dual provider config (+ optional dual plugin entries) into opencode.json.
 */
export async function installProvider(
  configPath: string = defaultConfigPath(),
  options: InstallOptions = {},
): Promise<InstallResult> {
  const resolved = path.resolve(configPath);
  const { config, created, raw } = await readConfig(resolved);

  if (created && config.$schema === undefined) {
    config.$schema = CONFIG_SCHEMA;
  }

  const xai = await mergeXaiProvider(config);
  const codex = await mergeCodexProvider(config);

  // Guard: never write built-in keys as our multi providers.
  if (isPlainObject(config.provider)) {
    for (const builtin of BUILTIN_PROVIDER_IDS) {
      // We never create them; leave any user-owned built-in entry alone.
      void builtin;
    }
  }

  const legacyPluginsRemoved = stripLegacyPluginEntries(config);

  let pluginEntriesAdded: string[] = [];
  if (options.withPluginEntry) {
    const desired = options.pluginEntries ?? defaultPluginEntries();
    const prior = Array.isArray(config.plugin)
      ? config.plugin
          .map((e) => pluginEntryKey(e))
          .filter((k): k is string => typeof k === "string")
      : [];
    stripOurPluginEntries(config);
    mergePluginEntries(config, desired);
    // Report only truly new package registrations (not dual→root rewrites / reruns).
    pluginEntriesAdded = desired.filter(
      (entry) =>
        !prior.some(
          (key) =>
            key === entry ||
            (isOurPluginKey(key) && pathsReferToSamePlugin(key, entry)),
        ),
    );
  }

  const body = `${JSON.stringify(config, null, 2)}\n`;
  const unchanged = raw !== null && raw === body;

  let backedUp = false;
  let backupPath: string | null = null;
  if (!created && !unchanged) {
    const bak = await maybeBackup(resolved, raw, options.skipBackup);
    backedUp = bak.backedUp;
    backupPath = bak.backupPath;
  }

  await mkdir(path.dirname(resolved), { recursive: true });
  if (!unchanged) {
    await writeFile(resolved, body, "utf8");
  }

  return {
    configPath: resolved,
    created,
    backedUp,
    backupPath,
    providers: [xai, codex],
    pluginEntriesAdded,
    legacyPluginsRemoved,
    config,
  };
}

function printSummary(result: InstallResult): void {
  const {
    configPath,
    created,
    backedUp,
    backupPath,
    providers,
    pluginEntriesAdded,
    legacyPluginsRemoved,
    config,
  } = result;

  console.log("multi-ai dual-provider installer");
  console.log("─".repeat(56));
  console.log(`config: ${configPath}`);
  console.log(created ? "  created a new config file" : "  updated existing config");
  if (backedUp && backupPath) {
    console.log(`  backup: ${backupPath}`);
  }

  for (const p of providers) {
    if (p.added) {
      console.log(`  + added provider "${p.id}"`);
    } else if (p.updated) {
      console.log(`  ~ provider "${p.id}" filled missing fields`);
    } else {
      console.log(`  = provider "${p.id}" already configured`);
    }
  }

  if (legacyPluginsRemoved.length > 0) {
    console.log(
      `  - removed legacy plugin entries: ${legacyPluginsRemoved.join(", ")}`,
    );
  }
  for (const entry of pluginEntriesAdded) {
    console.log(`  + registered plugin "${entry}"`);
  }

  // Sanity: built-ins must not appear as our multi ids.
  const provider = isPlainObject(config.provider)
    ? (config.provider as Record<string, unknown>)
    : {};
  if (provider.xai === provider[XAI_PROVIDER_ID] && provider.xai !== undefined) {
    console.log("  ! warning: unexpected alias of built-in xai");
  }

  console.log("─".repeat(56));
  console.log(
    "Done. Restart OpenCode, then `opencode auth login` for xai-multi and/or codex-multi.",
  );
  console.log("CLI: op-ai tui | op-xai list | op-codex list");
}

function parseArgs(argv: string[]): {
  configPath?: string;
  withPluginEntry: boolean;
} {
  let configPath: string | undefined;
  let withPluginEntry = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--with-plugin-entry") {
      withPluginEntry = true;
    } else if (arg === "--config") {
      configPath = argv[++i];
      if (configPath === undefined) {
        throw new Error("--config requires a path argument");
      }
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    }
  }

  return { configPath, withPluginEntry };
}

async function main(): Promise<void> {
  const { configPath, withPluginEntry } = parseArgs(process.argv.slice(2));
  const result = await installProvider(configPath, { withPluginEntry });
  printSummary(result);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isMain = invokedPath === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`install failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
