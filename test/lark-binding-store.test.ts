import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConversationNotFoundError } from "../src/domain/conversation.js";
import {
  initializeSqliteSchema,
  LarkBindingStore,
  openSqliteDatabase,
} from "../src/infrastructure/sqlite/index.js";

test("binding store enforces one-to-one chat<->conversation and cascades on delete", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    const store = new LarkBindingStore(database);
    database.exec(`
      INSERT INTO conversations (id, workspace_root, execution_mode, created_at, updated_at)
      VALUES ('c1', '/w1', 'workspace_sandbox', 'now', 'now'),
             ('c2', '/w2', 'workspace_sandbox', 'now', 'now');
    `);

    assert.deepEqual(store.bind({
      chatId: "oc-1",
      openId: "ou-1",
      conversationId: "c1",
      createdAt: "now",
    }), { status: "bound" });
    assert.ok(store.findByChatId("oc-1"));
    assert.ok(store.findByConversationId("c1"));

    // 同一 chat 再绑 -> chat_already_bound；同一会话再被其它 chat 绑 -> conversation_already_bound。
    assert.deepEqual(store.bind({
      chatId: "oc-1", openId: "ou-1", conversationId: "c2", createdAt: "now",
    }), { status: "chat_already_bound" });
    assert.deepEqual(store.bind({
      chatId: "oc-2", openId: "ou-2", conversationId: "c1", createdAt: "now",
    }), { status: "conversation_already_bound" });

    assert.deepEqual(store.findBoundConversationIds(["c1", "c2", "c3"]), new Set(["c1"]));

    // 删除会话级联删除绑定。
    database.exec("DELETE FROM conversations WHERE id = 'c1'");
    assert.equal(store.findByChatId("oc-1"), undefined);
  });
});

test("bind to a missing conversation converts FK failure to ConversationNotFoundError", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    const store = new LarkBindingStore(database);

    // conversations 表为空：外键约束失败必须转成领域错误，不能让 SQLite 原始错误穿透。
    assert.throws(
      () => store.bind({
        chatId: "oc-ghost",
        openId: "ou-1",
        conversationId: "ghost",
        createdAt: "now",
      }),
      (error: unknown) => error instanceof ConversationNotFoundError
        && error.message === "Conversation ghost was not found.",
    );
    // 失败的插入不留绑定行。
    assert.equal(store.findByChatId("oc-ghost"), undefined);

    // 会话真正创建后，同一 chat 可以重新绑定成功。
    database.exec(`
      INSERT INTO conversations (id, workspace_root, execution_mode, created_at, updated_at)
      VALUES ('c1', '/w1', 'workspace_sandbox', 'now', 'now');
    `);
    assert.deepEqual(
      store.bind({ chatId: "oc-ghost", openId: "ou-1", conversationId: "c1", createdAt: "now" }),
      { status: "bound" },
    );
    assert.ok(store.findByChatId("oc-ghost"));
  });
});

test("inbound dedup only records once and can be purged", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    const store = new LarkBindingStore(database);
    assert.equal(store.ensureInboundMessageSeen("om-1", "oc-1", "2026-01-01T00:00:00.000Z"), true);
    assert.equal(store.ensureInboundMessageSeen("om-1", "oc-1", "2026-01-01T00:00:00.000Z"), false);
    assert.equal(store.purgeOldInboundMessages("2026-01-02T00:00:00.000Z"), 1);
  });
});

test("unbindByConversationId is idempotent", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    const store = new LarkBindingStore(database);
    database.exec(`
      INSERT INTO conversations (id, workspace_root, execution_mode, created_at, updated_at)
      VALUES ('c1', '/w1', 'workspace_sandbox', 'now', 'now');
    `);
    store.bind({ chatId: "oc-1", openId: "ou-1", conversationId: "c1", createdAt: "now" });
    assert.ok(store.unbindByConversationId("c1"));
    assert.equal(store.unbindByConversationId("c1"), false);
    assert.equal(store.findByChatId("oc-1"), undefined);
  });
});

async function withTemporaryDatabase(
  operation: (database: import("node:sqlite").DatabaseSync) => void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-lark-binding-"));
  const database = openSqliteDatabase(join(directory, "agent.sqlite"));
  try {
    operation(database);
  } finally {
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  }
}