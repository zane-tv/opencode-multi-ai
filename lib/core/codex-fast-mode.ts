/**
 * Codex Fast mode (ChatGPT service_tier=fast).
 *
 * Load order:
 *   MULTI_AI_CODEX_FAST env
 *   > multi-ai-settings.json `codexFastMode`
 *   > false
 *
 * When on, codex body transform sets `service_tier: "fast"` (1.5x speed,
 * higher credit burn — ChatGPT subscription path only).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached: boolean | undefined;
let cachedAt = 0;
const CACHE_MS = 2_000;

export function defaultSettingsPath(): string {
  const override = process.env.MULTI_AI_SETTINGS_PATH?.trim();
  if (override) return override;
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-ai-settings.json",
  );
}

function normalizeBool(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on" || v === "fast") {
    return true;
  }
  if (v === "0" || v === "false" || v === "no" || v === "off" || v === "standard") {
    return false;
  }
  return null;
}

function readSettingsFast(): boolean | null {
  try {
    const p = defaultSettingsPath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
      string,
      unknown
    >;
    return normalizeBool(data.codexFastMode ?? data.codex_fast_mode);
  } catch {
    return null;
  }
}

function writeSettingsFast(on: boolean): void {
  try {
    const p = defaultSettingsPath();
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    let prev: Record<string, unknown> = {};
    try {
      if (fs.existsSync(p)) {
        prev = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
          string,
          unknown
        >;
      }
    } catch {
      prev = {};
    }
    const next = { ...prev, codexFastMode: on };
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, p);
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* ignore */
    }
  } catch {
    /* non-fatal */
  }
}

export function getCodexFastMode(): boolean {
  const now = Date.now();
  if (cached !== undefined && now - cachedAt < CACHE_MS) return cached;

  const fromEnv = normalizeBool(
    process.env.MULTI_AI_CODEX_FAST ?? process.env.MULTI_CODEX_FAST,
  );
  const on = fromEnv ?? readSettingsFast() ?? false;
  cached = on;
  cachedAt = now;
  return on;
}

export function setCodexFastMode(on: boolean, persist = true): void {
  cached = on;
  cachedAt = Date.now();
  if (persist) writeSettingsFast(on);
}

export function toggleCodexFastMode(): boolean {
  const next = !getCodexFastMode();
  setCodexFastMode(next, true);
  return next;
}

export function codexFastModeLabel(on: boolean = getCodexFastMode()): string {
  return on ? "fast" : "standard";
}

export function resetCodexFastModeForTests(): void {
  cached = undefined;
  cachedAt = 0;
}
