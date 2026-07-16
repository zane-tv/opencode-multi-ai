/**
 * OpenCode plugin entry for the whole package.
 *
 * Config may list a single path/package:
 *   "plugin": ["/absolute/path/to/opencode-multi-ai"]
 *   "plugin": ["opencode-multi-ai"]
 *
 * OpenCode's legacy loader walks named exports and loads every `{ id, server }`
 * PluginModule. There is intentionally NO default export — a default would
 * short-circuit to only one provider.
 *
 * Per-provider modules remain the canonical PluginModules:
 *   lib/plugin/xai.ts   → id: xai-multi
 *   lib/plugin/codex.ts → id: codex-multi
 */
export { default as xai } from "./lib/plugin/xai.js";
export { default as codex } from "./lib/plugin/codex.js";
