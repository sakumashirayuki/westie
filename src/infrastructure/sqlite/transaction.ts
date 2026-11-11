import type { DatabaseSync } from "node:sqlite";

export function immediateTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      if (database.isTransaction) database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "SQLite operation and rollback both failed.",
      );
    }
    throw error;
  }
}
