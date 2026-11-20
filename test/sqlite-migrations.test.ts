import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VERSION_ZERO_SCHEMA } from "./support/version-zero-schema.js";
import test from "node:test";

import {
  LATEST_SCHEMA_VERSION,
  initializeSqliteSchema,
  migrateSqliteSchema,
  openSqliteDatabase,
  readSchemaVersion,
  SchemaVersionError,
} from "../src/infrastructure/sqlite/index.js";

test("initializes a new database with the latest schema", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);

    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    assert.deepEqual(columnNames(database), [
      "id",
      "revision",
      "workspace_root",
      "execution_mode",
      "active_run_id",
      "created_at",
      "updated_at",
      "title",
      "project_key",
      "project_root",
      "workspace_kind",
      "archived",
    ]);
    assert.match(
      String(
        database
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'conversations'")
          .get()?.sql,
      ),
      /title TEXT NULL/i,
    );
  });
});

test("initializing an already migrated database is idempotent", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    const before = columnNames(database);
    initializeSqliteSchema(database);

    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    assert.deepEqual(columnNames(database), before);
  });
});

test("upgrades a version 2 database with a project lookup index and preserves conversations", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    database.exec(`
      DROP INDEX conversations_project_key_updated_at_id_idx;
      ALTER TABLE conversations DROP COLUMN archived;
      PRAGMA user_version = 2;
      INSERT INTO conversations (id, workspace_root, execution_mode, created_at, updated_at, project_key, project_root)
      VALUES ('kept', '/project', 'workspace_sandbox', 'created', 'updated', 'git:project', '/project');
    `);
    initializeSqliteSchema(database);
    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    assert.equal(database.prepare("SELECT project_root FROM conversations WHERE id = 'kept'").get()?.project_root, "/project");
    assert.ok(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'conversations_project_key_updated_at_id_idx'").get());
  });
});

test("upgrades a version 3 database with a nullable remote base column", async () => {
  await withTemporaryDatabase((database) => {
    // 构造版本 3 的存量库：worktree_operations 有 10 列，没有 base_remote；
    // conversations 还没有 archived，需要降级回去才能复现版本 3 的真实状态。
    initializeSqliteSchema(database);
    database.exec(`
      ALTER TABLE conversations DROP COLUMN archived;
      DROP TABLE worktree_operations;
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
      PRAGMA user_version = 3;
      INSERT INTO worktree_operations (
        id, project_key, project_root, target_path, branch,
        base_branch, base_commit, execution_mode, status, conversation_id
      ) VALUES (
        'kept', 'git:/project/.git', '/project', '/worktrees/kept', 'feat/kept',
        'main', 'commit-1', 'workspace_sandbox', 'completed', NULL
      );
    `);
    assert.equal(readSchemaVersion(database), 3);

    assert.equal(migrateSqliteSchema(database), 3);

    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    assert.deepEqual(operationColumnNames(database), [
      "id",
      "project_key",
      "project_root",
      "target_path",
      "branch",
      "base_branch",
      "base_remote",
      "base_commit",
      "execution_mode",
      "status",
      "conversation_id",
    ]);
    // 存量行是本地起点，远端列保持 NULL。
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT base_branch, base_remote FROM worktree_operations WHERE id = 'kept'
        `).get(),
      },
      { base_branch: "main", base_remote: null },
    );
  });
});

test("initializes a version 0 database through the real startup path", async () => {
  await withTemporaryDatabase((database) => {
    database.exec(VERSION_ZERO_SCHEMA);
    database.prepare(`
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode, active_run_id,
        created_at, updated_at
      ) VALUES ('legacy', 1, '/workspace/legacy', 'workspace_sandbox', NULL, 'created', 'updated')
    `).run();
    database.exec(`
      INSERT INTO turns (id, conversation_id, position, user_message, opening_seq, status, created_at, updated_at)
      VALUES ('turn', 'legacy', 0, 'question', 0, 'completed', 'created', 'updated');
      INSERT INTO runs (id, turn_id, attempt, status, final_answer, message_count, transcript_bytes, created_at, updated_at)
      VALUES ('run', 'turn', 1, 'completed', 'answer', 1, 0, 'created', 'updated');
      INSERT INTO transcript_messages (conversation_id, seq, run_id, role, message_json)
      VALUES ('legacy', 0, 'run', 'user', '{"role":"user","content":"question"}');
    `);

    initializeSqliteSchema(database);

    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    assert.equal(
      database.prepare("SELECT title FROM conversations WHERE id = 'legacy'").get()?.title,
      null,
    );
    assert.equal(database.prepare("SELECT final_answer FROM runs WHERE id = 'run'").get()?.final_answer, "answer");
    assert.equal(database.prepare("SELECT count(*) AS count FROM transcript_messages WHERE conversation_id = 'legacy'").get()?.count, 1);
  });
});

test("rejects a non-empty database without the application schema", async () => {
  await withTemporaryDatabase((database) => {
    database.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY) STRICT;");

    assert.throws(
      () => initializeSqliteSchema(database),
      (error: unknown) =>
        error instanceof SchemaVersionError && error.message === "Unrecognized database schema.",
    );
  });
});

test("migrates a version 0 database to the latest schema without losing rows", async () => {
  await withTemporaryDatabase((database) => {
    database.exec(VERSION_ZERO_SCHEMA);
    database.exec(`
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode, active_run_id,
        created_at, updated_at
      ) VALUES
        ('kept-1', 3, '/workspace/alpha', 'workspace_sandbox', NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('kept-2', 0, '/workspace/beta', 'full_access', NULL,
          '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
    `);
    assert.equal(readSchemaVersion(database), 0);

    assert.equal(migrateSqliteSchema(database), 0);

    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    assert.deepEqual(columnNames(database), [
      "id",
      "revision",
      "workspace_root",
      "execution_mode",
      "active_run_id",
      "created_at",
      "updated_at",
      "title",
      "project_key",
      "project_root",
      "workspace_kind",
      "archived",
    ]);
    assert.deepEqual(
      database.prepare(`
        SELECT id, revision, workspace_root, title
        FROM conversations
        ORDER BY id
      `).all().map((row) => ({ ...row })),
      [
        {
          id: "kept-1",
          revision: 3,
          workspace_root: "/workspace/alpha",
          title: null,
        },
        {
          id: "kept-2",
          revision: 0,
          workspace_root: "/workspace/beta",
          title: null,
        },
      ],
    );
  });
});

test("migrating twice is a no-op and reports the current version", async () => {
  await withTemporaryDatabase((database) => {
    database.exec(VERSION_ZERO_SCHEMA);
    migrateSqliteSchema(database);
    const before = columnNames(database);

    assert.equal(migrateSqliteSchema(database), LATEST_SCHEMA_VERSION);
    assert.deepEqual(columnNames(database), before);
    assert.deepEqual(operationColumnNames(database), [
      "id",
      "project_key",
      "project_root",
      "target_path",
      "branch",
      "base_branch",
      "base_remote",
      "base_commit",
      "execution_mode",
      "status",
      "conversation_id",
    ]);
  });
});

test("new and upgraded databases have equivalent structure", async () => {
  await withTemporaryDatabase((existing) => {
    const fresh = new DatabaseSync(":memory:");
    try {
      existing.exec(VERSION_ZERO_SCHEMA);
      initializeSqliteSchema(existing);
      initializeSqliteSchema(fresh);
      const names = existing.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all().map((row) => String(row.name));
      assert.deepEqual(names, fresh.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all().map((row) => String(row.name)));
      for (const name of names) {
        for (const pragma of ["table_info", "foreign_key_list", "index_list"]) {
          const query = `SELECT * FROM pragma_${pragma}(?)`;
          const rows = (database: DatabaseSync) =>
            database
              .prepare(query)
              .all(name)
              .map((row) => ({ ...row }))
              // ALTER TABLE ADD COLUMN 把新列追加到末尾，与新建表的列顺序不同；
              // 列的定义必须一致，否则这里会比出差异。
              .sort(compareColumnOrIndexRows);
          assert.deepEqual(rows(existing), rows(fresh), `${name}: ${pragma}`);
        }
      }
      for (const database of [existing, fresh]) {
        database.exec("INSERT INTO conversations (id, workspace_root, execution_mode, created_at, updated_at) VALUES ('c', '/workspace', 'workspace_sandbox', 'now', 'now')");
        for (const value of ["", "x".repeat(121)]) {
          assert.throws(() => database.prepare("UPDATE conversations SET title = ? WHERE id = 'c'").run(value), /CHECK constraint failed/);
        }
      }
    } finally {
      fresh.close();
    }
  });
});

test("rolls back migration and version when initialization fails", async () => {
  await withTemporaryDatabase((database) => {
    database.exec(VERSION_ZERO_SCHEMA);
    database.exec("DROP INDEX conversations_updated_at_id_idx; CREATE TABLE conversations_updated_at_id_idx (id TEXT) STRICT;");
    assert.throws(() => initializeSqliteSchema(database));
    assert.equal(readSchemaVersion(database), 0);
    assert.equal(columnNames(database).includes("title"), false);
    database.exec("DROP TABLE conversations_updated_at_id_idx;");
    initializeSqliteSchema(database);
    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    assert.equal(columnNames(database).includes("title"), true);
  });
});

test("initialization refuses a newer schema before changing it", async () => {
  await withTemporaryDatabase((database) => {
    database.exec(VERSION_ZERO_SCHEMA);
    database.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    assert.throws(() => initializeSqliteSchema(database), SchemaVersionError);
    assert.equal(columnNames(database).includes("title"), false);
  });
});

test("the title column keeps the 1..120 character contract", async () => {
  await withTemporaryDatabase((database) => {
    database.exec(VERSION_ZERO_SCHEMA);
    migrateSqliteSchema(database);
    database.exec(`
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode, active_run_id,
        created_at, updated_at
      ) VALUES (
        'c', 0, '/workspace', 'workspace_sandbox', NULL, 'now', 'now'
      );
    `);

    assert.doesNotThrow(() =>
      database.prepare("UPDATE conversations SET title = 'ok' WHERE id = 'c'").run()
    );
    assert.doesNotThrow(() =>
      database.prepare("UPDATE conversations SET title = NULL WHERE id = 'c'").run()
    );
    for (const invalid of ["", "x".repeat(121)]) {
      assert.throws(
        () =>
          database.prepare("UPDATE conversations SET title = ? WHERE id = 'c'")
            .run(invalid),
        /CHECK constraint failed/,
        `title ${JSON.stringify(invalid)} should be rejected`,
      );
    }
  });
});

test("refuses to open a database from a newer application version", async () => {
  await withTemporaryDatabase((database) => {
    database.exec(VERSION_ZERO_SCHEMA);
    database.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);

    assert.throws(
      () => migrateSqliteSchema(database),
      (error: unknown) =>
        error instanceof SchemaVersionError &&
        error.message.includes(String(LATEST_SCHEMA_VERSION + 1)),
    );
  });
});

test("migrates a version 1 database to project membership without losing sessions", async () => {
  await withTemporaryDatabase((database) => {
    // 只升级到版本 1：手工执行 0 → 1 的 DDL，构造版本 1 的存量库。
    database.exec(VERSION_ZERO_SCHEMA);
    database.exec(`
      ALTER TABLE conversations
        ADD COLUMN title TEXT NULL
          CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120);
      PRAGMA user_version = 1;
    `);
    assert.equal(readSchemaVersion(database), 1);
    database.exec(`
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode, active_run_id,
        created_at, updated_at, title
      ) VALUES ('kept', 4, '/workspace/kept', 'full_access', NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '标题');
    `);

    assert.equal(migrateSqliteSchema(database), 1);
    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    // 存量会话保留原有列，新列一律为 NULL（读取时再识别），操作日志没有存量行。
    assert.deepEqual(
      database.prepare(`
        SELECT id, revision, workspace_root, execution_mode, title,
          project_key, project_root, workspace_kind
        FROM conversations
      `).all().map((row) => ({ ...row })),
      [{
        id: "kept",
        revision: 4,
        workspace_root: "/workspace/kept",
        execution_mode: "full_access",
        title: "标题",
        project_key: null,
        project_root: null,
        workspace_kind: null,
      }],
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM worktree_operations").get()?.count,
      0,
    );
    // 新增的 CHECK 只接受四种目录类型。
    assert.throws(
      () =>
        database.prepare(
          "UPDATE conversations SET workspace_kind = 'bare' WHERE id = 'kept'",
        ).run(),
      /CHECK constraint failed/,
    );
    for (const kind of ["main", "worktree", "subdirectory", "directory"]) {
      assert.doesNotThrow(() =>
        database.prepare(
          "UPDATE conversations SET workspace_kind = ? WHERE id = 'kept'",
        ).run(kind)
      );
    }
  });
});

function columnNames(database: DatabaseSync, table = "conversations"): string[] {
  return database
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => String(row.name));
}

/** 按列名 / 索引名排序：比较列与索引定义时不依赖 `cid` 顺序。 */
function compareColumnOrIndexRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftKey = String(left.name ?? left.from ?? "");
  const rightKey = String(right.name ?? right.from ?? "");
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function operationColumnNames(database: DatabaseSync): string[] {
  return columnNames(database, "worktree_operations");
}

async function withTemporaryDatabase(
  operation: (database: DatabaseSync) => void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-sqlite-migration-"));
  const database = openSqliteDatabase(join(directory, "agent.sqlite"));
  try {
    operation(database);
  } finally {
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("migrates a version 4 database to version 6 with archived column and the two lark tables", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    // 构造版本 4 的存量库：删掉两张 lark 表与 archived 列并把版本降回 4。
    database.exec(`
      DROP TABLE lark_inbound_messages;
      DROP TABLE lark_chat_bindings;
      ALTER TABLE conversations DROP COLUMN archived;
      PRAGMA user_version = 4;
      INSERT INTO conversations (id, workspace_root, execution_mode, created_at, updated_at)
      VALUES ('kept', '/project', 'workspace_sandbox', 'created', 'updated');
    `);
    assert.equal(readSchemaVersion(database), 4);

    assert.equal(migrateSqliteSchema(database), 4);

    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    assert.deepEqual(
      database.prepare(`
        SELECT name FROM pragma_table_info('lark_chat_bindings') ORDER BY cid
      `).all().map((row) => String(row.name)),
      ["chat_id", "open_id", "conversation_id", "created_at"],
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name FROM pragma_table_info('lark_inbound_messages') ORDER BY cid
      `).all().map((row) => String(row.name)),
      ["message_id", "chat_id", "received_at"],
    );
    // v5 迁移补上的归档列，存量行取默认值 0。
    assert.equal(
      database.prepare("SELECT archived FROM conversations WHERE id = 'kept'").get()
        ?.archived,
      0,
    );
    // 存量会话不受影响。
    assert.equal(
      database.prepare("SELECT id FROM conversations WHERE id = 'kept'").get()?.id,
      "kept",
    );
    // 会话删除时绑定行级联删除。
    database.prepare(`
      INSERT INTO lark_chat_bindings (chat_id, open_id, conversation_id, created_at)
      VALUES ('oc-1', 'ou-1', 'kept', 'now')
    `).run();
    database.exec("DELETE FROM conversations WHERE id = 'kept'");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM lark_chat_bindings").get()?.n,
      0,
    );
  });
});

test("repairs a legacy version 5 lark database by adding the archived column", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    // 复现历史重写前的开发库：user_version=5，已含两张 lark 表但没有 archived 列。
    database.exec(`
      ALTER TABLE conversations DROP COLUMN archived;
      INSERT INTO conversations (id, workspace_root, execution_mode, created_at, updated_at)
      VALUES ('legacy', '/project', 'workspace_sandbox', 'created', 'updated');
      INSERT INTO lark_chat_bindings (chat_id, open_id, conversation_id, created_at)
      VALUES ('oc-legacy', 'ou-1', 'legacy', 'now');
      PRAGMA user_version = 5;
    `);
    assert.equal(readSchemaVersion(database), 5);

    assert.equal(migrateSqliteSchema(database), 5);

    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    // 缺的 archived 列已补齐，存量行取默认值 0。
    assert.equal(
      database.prepare("SELECT archived FROM conversations WHERE id = 'legacy'").get()
        ?.archived,
      0,
    );
    // 已存在的 lark 表与数据原样保留。
    assert.equal(
      database
        .prepare("SELECT conversation_id AS id FROM lark_chat_bindings WHERE chat_id = 'oc-legacy'")
        .get()?.id,
      "legacy",
    );
    // 再跑一次迁移保持幂等。
    assert.equal(migrateSqliteSchema(database), LATEST_SCHEMA_VERSION);
  });
});
