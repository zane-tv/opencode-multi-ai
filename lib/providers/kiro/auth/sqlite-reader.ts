import fs from "node:fs/promises";

export type SqliteRow = Record<string, unknown>;

export type SqliteQueryResult = {
  columns: string[];
  rows: SqliteRow[];
};

export async function readSqliteQuery(
  dbPath: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<SqliteQueryResult> {
  await fs.access(dbPath);
  type DatabaseCtor = new (
    path: string,
    opts?: { readonly?: boolean },
  ) => {
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

  const db = new Database(dbPath, { readonly: true });
  try {
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
