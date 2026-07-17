/**
 * Leveled logger → stderr with `[multi-ai]` prefix.
 * Quiet by default: only warn/error unless MULTI_AI_DEBUG (or legacy
 * MULTI_XAI_DEBUG / MULTI_CODEX_DEBUG) is truthy.
 * All args are secret-redacted before serialization.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const PREFIX = "[multi-ai]";
const REDACTED = "[REDACTED]";

/** Case-insensitive exact key names that always redact their value. */
const SECRET_KEYS = new Set(
  [
    "token",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "apikey",
    "api_key",
    "authorization",
    "clientsecret",
    "client_secret",
    "password",
    "secret",
  ].map((k) => k.toLowerCase()),
);

const BEARER_RE = /\bBearer\s+\S+/gi;
const KSK_RE = /\bksk_[A-Za-z0-9_-]+\b/g;
const SK_RE = /\bsk-(?:ant-)?[A-Za-z0-9_-]+\b/g;
  const JWT_RE =
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

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

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

function redactString(s: string): string {
  return s
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(KSK_RE, REDACTED)
    .replace(SK_RE, REDACTED)
    .replace(JWT_RE, REDACTED);
}

/**
 * Deep-redact secrets in any log argument. Never throws; cycle-safe.
 */
function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  try {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return redactString(value);
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return value;
    }
    if (typeof value === "symbol" || typeof value === "function") {
      return String(value);
    }

    if (value instanceof Error) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const out: Record<string, unknown> = {
        name: value.name,
        message: redactString(value.message),
      };
      const withStatus = value as Error & { status?: unknown; code?: unknown };
      if (withStatus.status !== undefined) out.status = withStatus.status;
      if (withStatus.code !== undefined) out.code = withStatus.code;
      if (value.cause !== undefined) out.cause = redact(value.cause, seen);
      return out;
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      return value.map((item) => redact(item, seen));
    }

    if (typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (isSecretKey(k)) {
          out[k] = REDACTED;
        } else {
          out[k] = redact(v, seen);
        }
      }
      return out;
    }

    return value;
  } catch {
    return REDACTED;
  }
}

function stringify(v: unknown): string {
  const safe = redact(v);
  if (typeof safe === "string") return safe;
  if (safe instanceof Error) return safe.stack ?? safe.message;
  try {
    return JSON.stringify(safe);
  } catch {
    return String(safe);
  }
}

function write(level: LogLevel, args: unknown[]): void {
  try {
    if (LEVEL_ORDER[level] < threshold()) return;
    const tag = `${PREFIX} ${level.toUpperCase()}`;
    process.stderr.write(`${tag} ${args.map(stringify).join(" ")}\n`);
  } catch {
    // Logger must never throw into call sites.
  }
}

export const logger = {
  debug: (...args: unknown[]) => write("debug", args),
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};

export type Logger = typeof logger;
