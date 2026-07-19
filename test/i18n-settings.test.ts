/**
 * Hermetic locale persistence test.
 * Uses MULTI_AI_SETTINGS_PATH so we never touch real ~/.config.
 */
import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-ai-i18n-"));
const sandboxSettings = path.join(sandboxDir, "multi-ai-settings.json");

const prev = {
  MULTI_AI_SETTINGS_PATH: process.env.MULTI_AI_SETTINGS_PATH,
  MULTI_AI_LANG: process.env.MULTI_AI_LANG,
  MULTI_XAI_LANG: process.env.MULTI_XAI_LANG,
  MULTI_CODEX_LANG: process.env.MULTI_CODEX_LANG,
};

process.env.MULTI_AI_SETTINGS_PATH = sandboxSettings;
delete process.env.MULTI_AI_LANG;
delete process.env.MULTI_XAI_LANG;
delete process.env.MULTI_CODEX_LANG;

describe("i18n locale persistence", () => {
  let setLocale: (locale: "vi" | "en", persist?: boolean) => void;
  let getLocale: () => "vi" | "en";
  let toggleLocale: (persist?: boolean) => "vi" | "en";
  let settingsPath: () => string;
  let t: (key: string) => string;
  let resetLocaleStateForTests: () => void;
  let p: string;

  beforeAll(async () => {
    const mod = await import("../lib/core/i18n.js");
    setLocale = mod.setLocale;
    getLocale = mod.getLocale;
    toggleLocale = mod.toggleLocale;
    settingsPath = mod.settingsPath;
    t = mod.t;
    resetLocaleStateForTests = mod.resetLocaleStateForTests;
    p = settingsPath();
    expect(p).toBe(sandboxSettings);
    expect(p.startsWith(sandboxDir)).toBe(true);
    expect(p.endsWith("multi-ai-settings.json")).toBe(true);
  });

  beforeEach(() => {
    delete process.env.MULTI_AI_LANG;
    delete process.env.MULTI_XAI_LANG;
    delete process.env.MULTI_CODEX_LANG;
    process.env.MULTI_AI_SETTINGS_PATH = sandboxSettings;
    if (fs.existsSync(p)) fs.unlinkSync(p);
    for (const name of fs.readdirSync(sandboxDir)) {
      if (name.startsWith("multi-ai-settings.json.tmp.")) {
        fs.unlinkSync(path.join(sandboxDir, name));
      }
    }
    resetLocaleStateForTests();
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("setLocale writes lang to multi-ai-settings.json", () => {
    expect(p).toBe(sandboxSettings);

    setLocale("vi", true);
    expect(getLocale()).toBe("vi");
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { lang?: string };
    expect(raw.lang).toBe("vi");

    setLocale("en", true);
    expect(JSON.parse(fs.readFileSync(p, "utf8")).lang).toBe("en");

    const next = toggleLocale(true);
    expect(next).toBe("vi");
    expect(JSON.parse(fs.readFileSync(p, "utf8")).lang).toBe("vi");

    setLocale("en", false);
    expect(t("brand")).toMatch(/OpenCode Multi AI|SuperGrok|Codex/i);
    expect(t("empty_hint")).toMatch(/xai-multi|codex-multi/);
  });

  it("accepts MULTI_AI_LANG over settings file", () => {
    fs.writeFileSync(p, JSON.stringify({ lang: "vi" }, null, 2));
    process.env.MULTI_AI_LANG = "en";
    resetLocaleStateForTests();
    expect(getLocale()).toBe("en");
  });

  it("falls back to MULTI_XAI_LANG then MULTI_CODEX_LANG", () => {
    process.env.MULTI_XAI_LANG = "vi";
    resetLocaleStateForTests();
    expect(getLocale()).toBe("vi");

    delete process.env.MULTI_XAI_LANG;
    process.env.MULTI_CODEX_LANG = "en";
    resetLocaleStateForTests();
    expect(getLocale()).toBe("en");
  });
});
