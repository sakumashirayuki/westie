import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  initializeSqliteSchema,
  openSqliteDatabase,
  readSchemaVersion,
  LATEST_SCHEMA_VERSION,
} from "../src/infrastructure/sqlite/index.js";
import {
  SQLitePersistentServiceStore,
  LIVE_SERVICE_STATUSES,
} from "../src/infrastructure/sqlite/persistent-service-store.js";

test("new database creates the persistent_services table with 18 columns", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    const columns = database.prepare(`
      SELECT name, type, "notnull", pk
      FROM pragma_table_info('persistent_services')
      ORDER BY cid
    `).all().map((row) => ({ ...row }));

    assert.equal(columns.length, 18);
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "id",
        "workspace_root",
        "name",
        "command",
        "cwd",
        "execution_mode",
        "status",
        "pid",
        "artifacts_dir",
        "exit_code",
        "exit_signal",
        "final_log_tail",
        "log_truncated",
        "created_by_conversation_id",
        "created_by_tool_call_id",
        "created_at",
        "updated_at",
        "ended_at",
      ],
    );
    assert.deepEqual(columns[0], {
      name: "id",
      type: "TEXT",
      notnull: 1,
      pk: 1,
    });
  });
});

test("a version 6 database upgrades to version 7 with a new empty table", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    // 降回版本 6：删掉新增表（索引随表一起删除）。
    database.exec(`
      DROP TABLE persistent_services;
      PRAGMA user_version = 6;
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode, created_at, updated_at
      ) VALUES ('kept', 0, '/project', 'workspace_sandbox', 'now', 'now');
    `);
    assert.equal(readSchemaVersion(database), 6);

    initializeSqliteSchema(database);

    assert.equal(readSchemaVersion(database), LATEST_SCHEMA_VERSION);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM persistent_services").get()?.n,
      0,
    );
    assert.equal(
      database.prepare("SELECT id FROM conversations WHERE id = 'kept'").get()?.id,
      "kept",
    );
    assert.ok(
      database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'persistent_services_workspace_status_idx'",
      ).get(),
    );
  });
});

test("persistent service CHECK constraints enforce live/terminal consistency", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    const store = new SQLitePersistentServiceStore(database);
    const base = {
      workspaceRoot: "/workspace",
      name: null,
      command: "true",
      cwd: ".",
      executionMode: "workspace_sandbox" as const,
      artifactsDir: "/tmp/artifacts",
      createdByConversationId: null,
      createdByToolCallId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    // live 行必须有 pid 且没有 ended_at
    assert.throws(() =>
      store.insert({
        ...base,
        id: "s-1",
        status: "starting",
        pid: null,
        exitCode: null,
        exitSignal: null,
      })
    );
    // exited/stopped 行必须带退出码或信号
    assert.throws(() =>
      store.insert({
        ...base,
        id: "s-2",
        status: "exited",
        pid: null,
        exitCode: null,
        exitSignal: null,
      })
    );
    // command 长度上限
    assert.throws(() =>
      store.insert({
        ...base,
        id: "s-3",
        command: "x".repeat(4097),
        status: "starting",
        pid: 1,
        exitCode: null,
        exitSignal: null,
      })
    );
    // 合法 live 行可以写入
    assert.doesNotThrow(() =>
      store.insert({
        ...base,
        id: "s-4",
        status: "starting",
        pid: 1,
        exitCode: null,
        exitSignal: null,
      })
    );
    assert.equal(store.read("s-4")?.status, "starting");
  });
});

test("markInterrupted only touches live rows and clears pid", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    const store = new SQLitePersistentServiceStore(database);
    const base = {
      workspaceRoot: "/workspace",
      name: null,
      command: "true",
      cwd: ".",
      executionMode: "workspace_sandbox" as const,
      artifactsDir: "/tmp/artifacts",
      createdByConversationId: null,
      createdByToolCallId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    store.insert({
      ...base,
      id: "live",
      status: "starting",
      pid: 2,
      exitCode: null,
      exitSignal: null,
    });
    store.markRunning("live", "2026-01-01T00:00:01.000Z");
    store.insert({
      ...base,
      id: "done",
      status: "exited",
      pid: null,
      exitCode: 1,
      exitSignal: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    store.markInterrupted("live", "2026-02-01T00:00:00.000Z");
    store.markInterrupted("done", "2026-02-01T00:00:00.000Z");

    assert.equal(store.read("live")?.status, "interrupted");
    assert.equal(store.read("live")?.pid, null);
    assert.equal(store.read("done")?.status, "exited");
  });
});

test("listForWorkspace isolates workspaces", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    const store = new SQLitePersistentServiceStore(database);
    const base = {
      name: null,
      command: "true",
      cwd: ".",
      executionMode: "workspace_sandbox" as const,
      artifactsDir: "/tmp/artifacts",
      createdByConversationId: null,
      createdByToolCallId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    store.insert({
      ...base,
      id: "a",
      workspaceRoot: "/a",
      status: "starting",
      pid: 1,
      exitCode: null,
      exitSignal: null,
    });
    store.insert({
      ...base,
      id: "b",
      workspaceRoot: "/b",
      status: "starting",
      pid: 2,
      exitCode: null,
      exitSignal: null,
    });

    assert.deepEqual(
      store.listForWorkspace("/a", 10).map((row) => row.id),
      ["a"],
    );
    assert.equal(store.countLive("/a"), 1);
    assert.equal(store.countLive("/b"), 1);
  });
});

test("foreign key clears created_by_conversation_id when the conversation is deleted", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    database.exec(`
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode, created_at, updated_at
      ) VALUES ('conv', 0, '/workspace', 'workspace_sandbox', 'now', 'now');
    `);
    const store = new SQLitePersistentServiceStore(database);
    store.insert({
      id: "s",
      workspaceRoot: "/workspace",
      name: null,
      command: "true",
      cwd: ".",
      executionMode: "workspace_sandbox",
      status: "exited",
      pid: null,
      exitCode: 0,
      exitSignal: null,
      artifactsDir: "/tmp/artifacts",
      createdByConversationId: "conv",
      createdByToolCallId: "call",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    database.exec("DELETE FROM conversations WHERE id = 'conv'");
    assert.equal(
      store.read("s")?.createdByConversationId,
      null,
    );
  });
});

async function withTemporaryDatabase(
  operation: (database: DatabaseSync) => void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-service-sqlite-"));
  const database = openSqliteDatabase(join(directory, "agent.sqlite"));
  try {
    operation(database);
  } finally {
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
