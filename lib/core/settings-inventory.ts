/**
 * Settings / path / env inventory for opencode-multi-ai.
 *
 * Single reference for install docs, migration, and support. Values are
 * descriptive constants (not live readers) so this module stays free of I/O.
 *
 * Unified store (v2):
 *   ~/.config/opencode/multi-ai-accounts.json
 *   ~/.config/opencode/multi-ai-settings.json   (locale, …)
 *   ~/.config/opencode/multi-ai-models-xai.json
 *   ~/.config/opencode/multi-ai-models-codex.json
 *
 * Legacy (read by migrate, never deleted by install):
 *   multi-xai-accounts.json / multi-codex-accounts.json
 *   multi-xai-settings.json / multi-codex-settings.json
 *
 * OpenCode host config (written by scripts/install.ts):
 *   ~/.config/opencode/opencode.json   (or OPENCODE_CONFIG)
 *   providers: xai-multi, codex-multi  (never built-in xai / openai)
 *   plugin: both lib/plugin/xai.ts + lib/plugin/codex.ts
 *
 * i18n already multi-ai-settings — see lib/core/i18n.ts (MULTI_AI_LANG with
 * MULTI_XAI_LANG / MULTI_CODEX_LANG fallbacks).
 */

/** On-disk files under ~/.config/opencode/ that this package owns or migrates. */
export const SETTINGS_FILES = {
  /** Unified v2 account pool (both providers). */
  accounts: "multi-ai-accounts.json",
  /** UI settings (locale, …). */
  settings: "multi-ai-settings.json",
  /** Per-provider model catalog caches. */
  modelsXai: "multi-ai-models-xai.json",
  modelsCodex: "multi-ai-models-codex.json",
  /** Legacy v1 pools (migration source; left in place + optional .bak). */
  legacyAccountsXai: "multi-xai-accounts.json",
  legacyAccountsCodex: "multi-codex-accounts.json",
  legacySettingsXai: "multi-xai-settings.json",
  legacySettingsCodex: "multi-codex-settings.json",
  /** OpenCode host config (providers + plugin array). */
  opencodeConfig: "opencode.json",
} as const;

/**
 * Environment variables. Prefer MULTI_AI_*; historical MULTI_XAI_* /
 * MULTI_CODEX_* remain accepted as fallbacks where noted in code.
 */
export const SETTINGS_ENV = {
  /** Override unified account store path (tests / advanced). */
  storagePath: "MULTI_AI_STORAGE_PATH",
  /** Override multi-ai-settings.json path. */
  settingsPath: "MULTI_AI_SETTINGS_PATH",
  /** One-shot locale: en | vi (falls back to MULTI_XAI_LANG / MULTI_CODEX_LANG). */
  lang: "MULTI_AI_LANG",
  langXaiFallback: "MULTI_XAI_LANG",
  langCodexFallback: "MULTI_CODEX_LANG",
  /** Debug logging. */
  debug: "MULTI_AI_DEBUG",
  /** Global CLI shim install dir (falls back to MULTI_XAI_BIN_DIR / MULTI_CODEX_BIN_DIR). */
  binDir: "MULTI_AI_BIN_DIR",
  binDirXaiFallback: "MULTI_XAI_BIN_DIR",
  binDirCodexFallback: "MULTI_CODEX_BIN_DIR",
  /** curl|bash install home (falls back to MULTI_XAI_HOME / MULTI_CODEX_HOME). */
  home: "MULTI_AI_HOME",
  homeXaiFallback: "MULTI_XAI_HOME",
  homeCodexFallback: "MULTI_CODEX_HOME",
  /** Git remote for install.sh clone mode. */
  repoUrl: "MULTI_AI_REPO_URL",
  repoRef: "MULTI_AI_REPO_REF",
  /** OpenCode host config path override (install.ts). */
  opencodeConfig: "OPENCODE_CONFIG",
} as const;

/** OpenCode provider ids this package registers (never built-ins). */
export const SETTINGS_PROVIDERS = {
  xai: {
    id: "xai-multi",
    npm: "@ai-sdk/xai",
    displayName: "Grok Multi-Account",
    pluginModule: "lib/plugin/xai.ts",
    builtinNever: "xai",
  },
  codex: {
    id: "codex-multi",
    npm: "@ai-sdk/openai",
    displayName: "Codex Multi-Account",
    pluginModule: "lib/plugin/codex.ts",
    builtinNever: "openai",
  },
} as const;

/** CLI bin names installed by scripts/install-cli.sh. */
export const SETTINGS_CLI_BINS = [
  "op-ai",
  "op-xai",
  "op-codex",
  "opencode-multi-ai",
  "opencode-multi-xai",
  "opencode-multi-codex",
  "xai-multi",
  "codex-multi",
] as const;

/** Keys currently persisted in multi-ai-settings.json. */
export const SETTINGS_FILE_KEYS = {
  /** Locale: "en" | "vi". */
  lang: "lang",
} as const;

export type SettingsFileName =
  (typeof SETTINGS_FILES)[keyof typeof SETTINGS_FILES];
export type SettingsEnvName = (typeof SETTINGS_ENV)[keyof typeof SETTINGS_ENV];
