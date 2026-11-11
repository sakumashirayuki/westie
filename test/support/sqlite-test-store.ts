import type { TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import {
  initializeSqliteSchema,
  openSqliteDatabase,
  SQLiteConversationStore,
} from "../../src/infrastructure/sqlite/index.js";

export interface SQLiteTestStore {
  readonly database: DatabaseSync;
  readonly store: SQLiteConversationStore;
}

export function createSQLiteTestStore(t: TestContext): SQLiteTestStore {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  t.after(() => store.close());
  return { database, store };
}
