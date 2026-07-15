import { describe, expect, it } from "vitest";

import {
  SETTINGS_CLI_BINS,
  SETTINGS_ENV,
  SETTINGS_FILE_KEYS,
  SETTINGS_FILES,
  SETTINGS_PROVIDERS,
} from "../lib/core/settings-inventory.js";

describe("settings inventory", () => {
  it("documents unified v2 files and both providers", () => {
    expect(SETTINGS_FILES.accounts).toBe("multi-ai-accounts.json");
    expect(SETTINGS_FILES.settings).toBe("multi-ai-settings.json");
    expect(SETTINGS_FILES.modelsXai).toBe("multi-ai-models-xai.json");
    expect(SETTINGS_FILES.modelsCodex).toBe("multi-ai-models-codex.json");
    expect(SETTINGS_PROVIDERS.xai.id).toBe("xai-multi");
    expect(SETTINGS_PROVIDERS.codex.id).toBe("codex-multi");
    expect(SETTINGS_PROVIDERS.xai.builtinNever).toBe("xai");
    expect(SETTINGS_PROVIDERS.codex.builtinNever).toBe("openai");
  });

  it("lists MULTI_AI_* env with historical fallbacks", () => {
    expect(SETTINGS_ENV.lang).toBe("MULTI_AI_LANG");
    expect(SETTINGS_ENV.langXaiFallback).toBe("MULTI_XAI_LANG");
    expect(SETTINGS_ENV.langCodexFallback).toBe("MULTI_CODEX_LANG");
    expect(SETTINGS_ENV.binDir).toBe("MULTI_AI_BIN_DIR");
    expect(SETTINGS_ENV.home).toBe("MULTI_AI_HOME");
    expect(SETTINGS_ENV.opencodeConfig).toBe("OPENCODE_CONFIG");
  });

  it("includes primary and historical CLI bins", () => {
    expect(SETTINGS_CLI_BINS).toContain("op-ai");
    expect(SETTINGS_CLI_BINS).toContain("op-xai");
    expect(SETTINGS_CLI_BINS).toContain("op-codex");
    expect(SETTINGS_CLI_BINS).toContain("opencode-multi-ai");
    expect(SETTINGS_FILE_KEYS.lang).toBe("lang");
  });
});
