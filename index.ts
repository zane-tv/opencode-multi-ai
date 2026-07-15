/**
 * Package root for opencode-multi-ai.
 * NOT a PluginModule — OpenCode must load the two plugin entries:
 *   - opencode-multi-ai/lib/plugin/xai.ts   (id: xai-multi)
 *   - opencode-multi-ai/lib/plugin/codex.ts (id: codex-multi)
 * Root export is intentionally non-plugin so the legacy loader never
 * mis-invokes this file as a single auth provider.
 */
export const PACKAGE_NAME = "opencode-multi-ai" as const;
export const PLUGIN_ENTRIES = [
  "lib/plugin/xai.ts",
  "lib/plugin/codex.ts",
] as const;
