import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type SqliteRow = Record<string, unknown>;

export type SqliteQueryResult = {
  columns: string[];
  rows: SqliteRow[];
};

export function sqliteValueToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  return undefined;
}

export async function readSqliteQuery(
  dbPath: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<SqliteQueryResult> {
  await fs.access(dbPath);
  type DatabaseCtor = new (path: string) => {
    exec: (sql: string) => unknown;
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
      columns?: () => Array<{ name: string }>;
    };
    close: () => void;
  };

  let Database: DatabaseCtor | undefined;
  try {
    const mod = await import("libsql");
    const candidate =
      (mod as { default?: unknown }).default ??
      (mod as { Database?: unknown }).Database;
    if (typeof candidate === "function") {
      Database = candidate as DatabaseCtor;
    }
  } catch {
    throw new Error(
      "Optional dependency libsql is not installed. Install it to import from Kiro SQLite databases.",
    );
  }
  if (!Database) {
    throw new Error("libsql Database export not found");
  }

  const dbUri = pathToFileURL(dbPath);
  dbUri.searchParams.set("mode", "ro");
  const db = new Database(dbUri.href);
  try {
    db.exec("PRAGMA query_only = ON");
    const stmt = db.prepare(sql);
    const rowsRaw = stmt.all(...params);
    const columns =
      typeof stmt.columns === "function"
        ? stmt.columns().map((column) => column.name)
        : rowsRaw[0] &&
            typeof rowsRaw[0] === "object" &&
            rowsRaw[0] !== null &&
            !Array.isArray(rowsRaw[0])
          ? Object.keys(rowsRaw[0] as object)
          : [];
    const rows = rowsRaw.map((row) => {
      if (row !== null && typeof row === "object" && !Array.isArray(row)) {
        return row as SqliteRow;
      }
      return {};
    });
    return { columns, rows };
  } finally {
    db.close();
  }
}
