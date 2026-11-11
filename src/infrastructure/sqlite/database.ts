import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function openSqliteDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
  });

  database.exec("PRAGMA foreign_keys = ON");
  if (databasePath !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
  }
  database.exec("PRAGMA synchronous = NORMAL");
  return database;
}
