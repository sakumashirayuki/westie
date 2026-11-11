import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";

import {
  ConversationBusyError,
} from "../src/conversation.js";
import { createSQLiteTestStore } from "./support/sqlite-test-store.js";

function openingSeqs(database: DatabaseSync, conversationId: string): number[] {
  return database
    .prepare(
      `SELECT opening_seq FROM turns WHERE conversation_id = $id ORDER BY position`,
    )
    .all({ "$id": conversationId })
    .map((row) => Number(row.opening_seq));
}

test("a later run loads the whole conversation transcript", (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace/project", "workspace_sandbox");
  const first = store.beginRun(conversation.id, "first question", "run-1");

  // beginRun 追加开场 user 消息，所以第一条已经在场。
  assert.deepEqual(store.loadConversationTranscript(conversation.id), [
    { role: "user", content: "first question" },
  ]);
  assert.equal(first.workspaceRoot, "/workspace/project");
  assert.deepEqual(openingSeqs(database, conversation.id), [0]);

  store.appendRunMessages(
    conversation.id,
    first.turnId,
    first.runId,
    [{ role: "assistant", content: "first answer" }],
    { status: "completed", finalAnswer: "first answer" },
  );

  store.beginRun(conversation.id, "second question", "run-2");
  assert.deepEqual(openingSeqs(database, conversation.id), [0, 2]);

  // 第二个 Run 开局看到的是整份会话记录，历史不需要重新投影。
  assert.deepEqual(store.loadConversationTranscript(conversation.id), [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
  ]);
});

test("messages appended by a failed run stay in the transcript", (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace/project", "workspace_sandbox");
  const failed = store.beginRun(conversation.id, "bad question", "run-1");

  store.appendRunMessages(
    conversation.id,
    failed.turnId,
    failed.runId,
    [{ role: "assistant", content: "partial work" }],
    { status: "failed", errorCode: "AGENT_RUN_FAILED", errorMessage: "failed" },
  );

  assert.equal(
    store.getConversation(conversation.id).turns[0].status,
    "failed",
  );

  // 重试接着已有记录继续，attempt >= 2 不追加新的开场 user 消息。
  store.beginRun(conversation.id, "bad question", "run-2", 2);
  assert.deepEqual(store.loadConversationTranscript(conversation.id), [
    { role: "user", content: "bad question" },
    { role: "assistant", content: "partial work" },
  ]);
  // 重试沿用 Turn 原有的开场 seq，没有新增一条 user 消息。
  assert.deepEqual(openingSeqs(database, conversation.id), [0]);
});

test("only one run can be active in a conversation", (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace/project", "workspace_sandbox");
  store.beginRun(conversation.id, "first", "run-1");

  assert.throws(
    () => store.beginRun(conversation.id, "second", "run-2"),
    ConversationBusyError,
  );
});

test("conversation keeps its required workspace for its lifetime", (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace/my-project", "workspace_sandbox");

  assert.deepEqual(conversation.workspace, {
    name: "my-project",
    canonicalPath: "/workspace/my-project",
  });

  const run = store.beginRun(conversation.id, "inspect it", "run-1");
  assert.equal(run.workspaceRoot, conversation.workspace.canonicalPath);
  assert.deepEqual(
    store.getConversation(conversation.id).workspace,
    conversation.workspace,
  );
});

test("filesystem root has a non-empty workspace display name", (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/", "workspace_sandbox");

  assert.deepEqual(conversation.workspace, {
    name: "/",
    canonicalPath: "/",
  });
});
