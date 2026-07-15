/**
 * Leveled logger → stderr with `[multi-ai]` prefix.
 * Quiet by default: only warn/error unless MULTI_AI_DEBUG (or legacy
 * MULTI_XAI_DEBUG / MULTI_CODEX_DEBUG) is truthy.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const PREFIX = "[multi-ai]";

function envTruthy(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return v !== "0" && v.toLowerCase() !== "false";
}

function debugEnabled(): boolean {
  return (
    envTruthy("MULTI_AI_DEBUG") ||
    envTruthy("MULTI_XAI_DEBUG") ||
    envTruthy("MULTI_CODEX_DEBUG")
  );
}

function threshold(): number {
  return debugEnabled() ? LEVEL_ORDER.debug : LEVEL_ORDER.warn;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(level: LogLevel, args: unknown[]): void {
  if (LEVEL_ORDER[level] < threshold()) return;
  const tag = `${PREFIX} ${level.toUpperCase()}`;
  process.stderr.write(`${tag} ${args.map(stringify).join(" ")}\n`);
}

export const logger = {
  debug: (...args: unknown[]) => write("debug", args),
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};

export type Logger = typeof logger;
