import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  codexFastModeLabel,
  getCodexFastMode,
  resetCodexFastModeForTests,
  setCodexFastMode,
  toggleCodexFastMode,
} from "../lib/core/codex-fast-mode.js";
import { transformCodexBody } from "../lib/providers/codex/request/body-transform.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fast-"));
const settingsPath = path.join(tmpRoot, "multi-ai-settings.json");

afterEach(() => {
  resetCodexFastModeForTests();
  delete process.env.MULTI_AI_CODEX_FAST;
  delete process.env.MULTI_CODEX_FAST;
  try {
    fs.rmSync(settingsPath, { force: true });
  } catch {
    /* */
  }
});

describe("codex fast mode settings", () => {
  it("defaults off and toggles with persist", () => {
    process.env.MULTI_AI_SETTINGS_PATH = settingsPath;
    expect(getCodexFastMode()).toBe(false);
    expect(toggleCodexFastMode()).toBe(true);
    expect(getCodexFastMode()).toBe(true);
    expect(codexFastModeLabel()).toBe("fast");
    const disk = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      codexFastMode?: boolean;
    };
    expect(disk.codexFastMode).toBe(true);
    setCodexFastMode(false, true);
    expect(getCodexFastMode()).toBe(false);
    expect(codexFastModeLabel()).toBe("standard");
  });

  it("env MULTI_AI_CODEX_FAST overrides settings", () => {
    process.env.MULTI_AI_SETTINGS_PATH = settingsPath;
    setCodexFastMode(false, true);
    process.env.MULTI_AI_CODEX_FAST = "1";
    resetCodexFastModeForTests();
    expect(getCodexFastMode()).toBe(true);
  });
});

describe("transformCodexBody service_tier", () => {
  it("sets service_tier=fast when option requests it", () => {
    const out = transformCodexBody(
      { model: "gpt-5.4", service_tier: "auto", store: true },
      { serviceTier: "fast" },
    );
    expect(out.service_tier).toBe("fast");
    expect(out.store).toBe(false);
  });

  it("strips stray service_tier when fast is off", () => {
    const out = transformCodexBody(
      { model: "gpt-5.4", service_tier: "fast" },
      {},
    );
    expect(out.service_tier).toBeUndefined();
  });
});
