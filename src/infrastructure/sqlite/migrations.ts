import type { DatabaseSync } from "node:sqlite";

import { immediateTransaction } from "./transaction.js";

/**
 * 数据库结构版本，保存在 SQLite 的 `user_version` 里。
 *
 * 存量库从当前版本逐级升级到 `LATEST_SCHEMA_VERSION`。结构变更与版本号
 * 在同一事务中提交。
 */
export const LATEST_SCHEMA_VERSION = 5;

export class SchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaVersionError";
  }
}

interface Migration {
  readonly version: number;
  readonly apply: (database: DatabaseSync) => void;
}

/** 0 → 1：`conversations` 增加可空的 `title` 列，存量会话保持 NULL（显示工作区名）。 */
const addConversationTitle: Migration = {
  version: 1,
  apply(database) {
    database.exec(`
      ALTER TABLE conversations
        ADD COLUMN title TEXT NULL
          CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120);
    `);
  },
};

/**
 * 1 → 2：`conversations` 增加项目归属列，并新增 worktree 创建操作日志表。
 *
 * 存量会话的三个新列保持 NULL（项目归属在读取时异步识别，目录类型按实时
 * Git 状态推断）；`worktree_operations` 是新增表，没有存量行。迁移不访问文件
 * 系统，也不执行 Git。
 */
const addProjectMembership: Migration = {
  version: 2,
  apply(database) {
    database.exec(`
      ALTER TABLE conversations ADD COLUMN project_key TEXT NULL;
      ALTER TABLE conversations ADD COLUMN project_root TEXT NULL;
      ALTER TABLE conversations ADD COLUMN workspace_kind TEXT NULL
        CHECK (
          workspace_kind IN ('main', 'worktree', 'subdirectory', 'directory')
        );

      CREATE TABLE worktree_operations (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        project_root TEXT NOT NULL,
        target_path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        execution_mode TEXT NOT NULL
          CHECK (execution_mode IN ('workspace_sandbox', 'full_access')),
        status TEXT NOT NULL
          CHECK (
            status IN ('prepared', 'started', 'completed', 'needs_inspection')
          ),
        conversation_id TEXT NULL
          REFERENCES conversations(id) ON DELETE SET NULL
      ) STRICT;
    `);
  },
};

const MIGRATIONS: readonly Migration[] = [
  addConversationTitle,
  addProjectMembership,
  {
    version: 3,
    apply(database) {
      database.exec(`CREATE INDEX conversations_project_key_updated_at_id_idx
        ON conversations(project_key, updated_at DESC, id DESC);`);
    },
  },
  /**
   * 3 → 4：`worktree_operations` 增加可空的 `base_remote` 列，记录远端起点的
   * 远端名。存量行的起点都是本地分支，保持 NULL。列可空且无 CHECK、UNIQUE 或
   * 索引；远端起点的 `base_branch` 存 `<remote>/<branch>`。
   */
  {
    version: 4,
    apply(database) {
      // 列位置与 `initializeSqliteSchema` 的新建表一致：SQLite 不能插入列，
      // 只能重建表。操作日志只有本机创建记录，重建时按 id 原样拷贝；表结构
      // 不变，因此外键、UNIQUE 与 CHECK 一并按新定义重建。
      database.exec(`
        ALTER TABLE worktree_operations RENAME TO worktree_operations_v3;

        CREATE TABLE worktree_operations (
          id TEXT PRIMARY KEY,
          project_key TEXT NOT NULL,
          project_root TEXT NOT NULL,
          target_path TEXT NOT NULL UNIQUE,
          branch TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          base_remote TEXT NULL,
          base_commit TEXT NOT NULL,
          execution_mode TEXT NOT NULL
            CHECK (execution_mode IN ('workspace_sandbox', 'full_access')),
          status TEXT NOT NULL
            CHECK (
              status IN ('prepared', 'started', 'completed', 'needs_inspection')
            ),
          conversation_id TEXT NULL
            REFERENCES conversations(id) ON DELETE SET NULL
        ) STRICT;

        INSERT INTO worktree_operations (
          id, project_key, project_root, target_path, branch,
          base_branch, base_remote, base_commit, execution_mode, status,
          conversation_id
        )
        SELECT
          id, project_key, project_root, target_path, branch,
          base_branch, NULL, base_commit, execution_mode, status,
          conversation_id
        FROM worktree_operations_v3;

        DROP TABLE worktree_operations_v3;
      `);
    },
  },
  /**
   * 4 → 5：`conversations` 增加 `archived` 列，标记会话是否已归档。存量行用
   * 默认值 0（未归档）。归档只改变会话的可见性与可写性，不删除任何数据；
   * 该列无需索引（首版归档会话数量少，查询通常还带 project_key）。
   */
  {
    version: 5,
    apply(database) {
      database.exec(`
        ALTER TABLE conversations
          ADD COLUMN archived INTEGER NOT NULL DEFAULT 0
            CHECK (archived IN (0, 1));
      `);
    },
  },
];

export function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  const value = row?.user_version;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaVersionError("Could not read the database schema version.");
  }
  return value;
}

export function writeSchemaVersion(database: DatabaseSync, version: number): void {
  // PRAGMA 不接受参数绑定，版本号来自代码常量，只能内联。
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new SchemaVersionError(`Invalid schema version: ${version}.`);
  }
  database.exec(`PRAGMA user_version = ${version}`);
}

/**
 * 把库升级到最新结构。返回升级前的版本，供调用方记录日志；结构已是最新时
 * 返回该版本本身。
 *
 * 版本高于本代码支持的 `LATEST_SCHEMA_VERSION` 时抛出 `SchemaVersionError`。
 */
export function migrateSqliteSchema(database: DatabaseSync): number {
  if (!database.isTransaction) {
    return immediateTransaction(database, () => migrateSqliteSchema(database));
  }
  const current = readSchemaVersion(database);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `Database schema version ${current} is newer than supported version ` +
        `${LATEST_SCHEMA_VERSION}. Update the application.`,
    );
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > current);
  for (const migration of pending) {
    migration.apply(database);
    writeSchemaVersion(database, migration.version);
  }
  return current;
}
