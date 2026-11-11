import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationStateError,
} from "../src/domain/conversation.js";
import {
  initializeSqliteSchema,
  openSqliteDatabase,
  SQLiteConversationStore,
} from "../src/infrastructure/sqlite/index.js";
import { transcriptBytes } from "../src/transcript.js";

test("SQLite store persists views and ordered session messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-sqlite-store-"));
  const path = join(directory, "agent.sqlite");
  try {
    const firstDatabase = openSqliteDatabase(path);
    initializeSqliteSchema(firstDatabase);
    const firstStore = new SQLiteConversationStore(firstDatabase);
    const conversation = firstStore.createConversation(
      "/workspace/project",
      "workspace_sandbox",
    );
    const first = firstStore.beginRun(
      conversation.id,
      "first question",
      "run-1",
    );
    firstStore.appendRunMessages(
      conversation.id,
      first.turnId,
      first.runId,
      [{ role: "assistant", content: "first answer" }],
      { status: "completed", finalAnswer: "first answer" },
    );
    const second = firstStore.beginRun(
      conversation.id,
      "second question",
      "run-2",
    );
    firstStore.appendRunMessages(
      conversation.id,
      second.turnId,
      second.runId,
      [{ role: "assistant", content: "second answer" }],
      { status: "completed", finalAnswer: "second answer" },
    );

    assert.deepEqual(
      firstStore.loadConversationTranscript(conversation.id),
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
    );
    firstStore.close();

    const reopenedDatabase = openSqliteDatabase(path);
    initializeSqliteSchema(reopenedDatabase);
    const reopenedStore = new SQLiteConversationStore(reopenedDatabase);
    assert.deepEqual(
      reopenedStore.loadConversationTranscript(conversation.id),
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
    );
    const reopened = reopenedStore.getConversation(conversation.id);
    assert.equal(reopened.workspace.canonicalPath, "/workspace/project");
    assert.equal(reopened.executionMode, "workspace_sandbox");
    assert.equal(reopened.revision, 4);
    assert.deepEqual(
      reopened.turns.map((turn) => turn.assistantMessage),
      ["first answer", "second answer"],
    );
    reopenedStore.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allocate contiguous session-level seq starting from zero", async () => {
  await withStore(({ store, database }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const first = store.beginRun(conversation.id, "first", "run-1");

    const rows = database.prepare(`
      SELECT seq, run_id FROM transcript_messages
      WHERE conversation_id = $conversationId
      ORDER BY seq
    `).all({ "$conversationId": conversation.id });
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { seq: 0, run_id: "run-1" },
    ]);

    store.appendRunMessages(
      conversation.id,
      first.turnId,
      first.runId,
      [{ role: "assistant", content: "answer" }],
      { status: "completed", finalAnswer: "answer" },
    );

    const second = store.beginRun(conversation.id, "second", "run-2");
    const afterSecond = database.prepare(`
      SELECT seq, run_id FROM transcript_messages
      WHERE conversation_id = $conversationId
      ORDER BY seq
    `).all({ "$conversationId": conversation.id });
    assert.deepEqual(afterSecond.map((row) => row.seq), [0, 1, 2]);
    assert.equal(second.turnId === first.turnId, false);
  });
});

test("listRunSteeringMessages projects only non-opening user messages", async () => {
  await withStore(({ store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const run = store.beginRun(conversation.id, "original", "run-steering-projection");
    store.appendRunMessages(
      conversation.id,
      run.turnId,
      run.runId,
      [
        { role: "user", content: "first steering" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ callId: "c", name: "read", arguments: "{}" }],
        },
        {
          role: "tool",
          results: [{
            toolCallId: "c",
            result: { type: "tool_result", tool: "read", status: "success", output: "x" },
          }],
        },
        { role: "user", content: "second steering" },
        { role: "assistant", content: "answer" },
      ],
      { status: "completed", finalAnswer: "answer" },
    );

    assert.deepEqual(store.listRunSteeringMessages(run.runId), [
      { seq: 1, content: "first steering" },
      { seq: 4, content: "second steering" },
    ]);
  });
});

test("SQLite store round-trips full access in views, summaries, and run snapshots", (t) => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  t.after(() => store.close());

  const conversation = store.createConversation("/workspace", "full_access");
  assert.equal(conversation.executionMode, "full_access");
  assert.equal(
    store.listConversations({ limit: 1 })[0].executionMode,
    "full_access",
  );
  assert.equal(
    store.beginRun(conversation.id, "question", "run-full").executionMode,
    "full_access",
  );
});

test("SQLite store round-trips canonical tool calls and results", async () => {
  await withStore(({ store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const run = store.beginRun(conversation.id, "read README", "run");
    const transcript = [
      { role: "user", content: "read README" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{
          callId: "call-1",
          name: "read",
          arguments: '{"path":"README.md"}',
        }],
      },
      {
        role: "tool",
        results: [{
          toolCallId: "call-1",
          result: {
          type: "tool_result",
          tool: "read",
          status: "success",
          output: { content: "hello" },
          },
        }],
      },
      { role: "assistant", content: "hello" },
    ] as const;

    // 开场 user 消息由 beginRun 写入，appendRunMessages 追加其余消息。
    store.appendRunMessages(
      conversation.id,
      run.turnId,
      run.runId,
      transcript.slice(1),
      { status: "completed", finalAnswer: "hello" },
    );

    assert.deepEqual(store.loadConversationTranscript(conversation.id), transcript);
  });
});

test("SQLite store persists context compactions with the terminal transcript", async () => {
  await withStore(({ database, store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const run = store.beginRun(conversation.id, "question", "run-compacted");
    const appended = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ callId: "call-1", name: "read", arguments: "{}" }],
      },
      {
        role: "tool",
        results: [{
          toolCallId: "call-1",
          result: {
          type: "tool_result",
          tool: "read",
          status: "success",
          output: "result",
          },
        }],
      },
      { role: "assistant", content: "answer" },
    ] as const;

    store.appendRunMessages(
      conversation.id,
      run.turnId,
      run.runId,
      appended,
      {
        status: "completed",
        finalAnswer: "answer",
        contextCompactions: [{
          position: 0,
          coveredThroughSeq: 2,
          summary: "summary",
          createdAt: "2026-08-12T00:00:00.000Z",
        }],
      },
    );

    assert.deepEqual(database.prepare(`
      SELECT position, covered_through_seq, summary_text, created_at
      FROM conversation_context_compactions
      WHERE conversation_id = $conversationId
    `).all({ "$conversationId": conversation.id }).map((row) => ({ ...row })), [{
      position: 0,
      covered_through_seq: 2,
      summary_text: "summary",
      created_at: "2026-08-12T00:00:00.000Z",
    }]);
  });
});

test("SQLite store persists adopted compactions for failed runs", async () => {
  await withStore(({ database, store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const run = store.beginRun(conversation.id, "question", "run-failed-compaction");
    const appended = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ callId: "call-1", name: "read", arguments: "{}" }],
      },
      {
        role: "tool",
        results: [{
          toolCallId: "call-1",
          result: {
          type: "tool_result",
          tool: "read",
          status: "success",
          output: "result",
          },
        }],
      },
    ] as const;

    store.appendRunMessages(
      conversation.id,
      run.turnId,
      run.runId,
      appended,
      {
        status: "failed",
        contextCompactions: [{
          position: 0,
          coveredThroughSeq: 2,
          summary: "summary before failure",
          createdAt: "2026-08-12T00:00:00.000Z",
        }],
      },
    );

    assert.deepEqual(database.prepare(`
      SELECT position, covered_through_seq, summary_text
      FROM conversation_context_compactions
      WHERE conversation_id = $conversationId
    `).all({ "$conversationId": conversation.id }).map((row) => ({ ...row })), [{
      position: 0,
      covered_through_seq: 2,
      summary_text: "summary before failure",
    }]);
  });
});

test("compaction records are loaded as the initial #adopted across runs", async () => {
  await withStore(({ store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const first = store.beginRun(conversation.id, "question", "run-1");
    store.appendRunMessages(
      conversation.id,
      first.turnId,
      first.runId,
      [
        {
          role: "assistant",
          content: null,
          toolCalls: [{ callId: "call-1", name: "read", arguments: "{}" }],
        },
        {
          role: "tool",
          results: [{
            toolCallId: "call-1",
            result: { type: "tool_result", tool: "read", status: "success", output: "result" },
          }],
        },
      ],
      {
        status: "completed",
        finalAnswer: "answer",
        contextCompactions: [{
          position: 0,
          coveredThroughSeq: 2,
          summary: "cumulative summary",
          createdAt: "2026-08-12T00:00:00.000Z",
        }],
      },
    );

    assert.deepEqual(store.loadConversationCompactions(conversation.id), [{
      position: 0,
      coveredThroughSeq: 2,
      summary: "cumulative summary",
      createdAt: "2026-08-12T00:00:00.000Z",
    }]);
  });
});

test("SQLite store records one system prompt for the active run", async () => {
  await withStore(({ database, store }) => {
    const conversation = store.createConversation(
      "/workspace",
      "workspace_sandbox",
    );
    const run = store.beginRun(conversation.id, "question", "run");

    store.recordRunSystemPrompt(
      conversation.id,
      run.turnId,
      run.runId,
      "system prompt",
    );

    assert.equal(
      database.prepare(`
        SELECT system_prompt
        FROM runs
        WHERE id = $runId
      `).get({ "$runId": run.runId })?.system_prompt,
      "system prompt",
    );
    assert.throws(() =>
      store.recordRunSystemPrompt(
        conversation.id,
        run.turnId,
        run.runId,
        "replacement",
      )
    );
  });
});

test("SQLite store preserves active-run state semantics", async () => {
  await withStore(({ database, store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const active = store.beginRun(conversation.id, "first", "run-1");

    assert.throws(
      () => store.beginRun(conversation.id, "second", "run-2"),
      ConversationBusyError,
    );
    store.appendRunMessages(
      conversation.id,
      active.turnId,
      active.runId,
      [],
      {
        status: "cancelled",
        errorCode: "CANCELLED_BY_USER",
        errorMessage: "The user stopped the run.",
        internalError: "AbortError: stopped",
      },
    );
    assert.equal(
      store.getConversation(conversation.id).turns[0]?.status,
      "cancelled",
    );
    assert.deepEqual(
      store.getConversation(conversation.id).turns[0]?.runs[0]?.error,
      {
        code: "CANCELLED_BY_USER",
        message: "The user stopped the run.",
      },
    );
    assert.deepEqual(
      { ...database.prepare(`
        SELECT error_code, error_message, internal_error
        FROM runs
        WHERE id = $runId
      `).get({ "$runId": active.runId }) },
      {
        error_code: "CANCELLED_BY_USER",
        error_message: "The user stopped the run.",
        internal_error: "AbortError: stopped",
      },
    );
    assert.deepEqual(
      database.prepare(`
        SELECT role, message_json
        FROM transcript_messages
        WHERE conversation_id = $conversationId
        ORDER BY seq
      `).all({ "$conversationId": conversation.id }).map((row) => ({ ...row })),
      [{
        role: "user",
        message_json: JSON.stringify({ role: "user", content: "first" }),
      }],
    );
    assert.throws(
      () =>
        store.appendRunMessages(
          conversation.id,
          active.turnId,
          active.runId,
          [],
          { status: "failed" },
        ),
      ConversationStateError,
    );
  });
});

test("SQLite store deletes a conversation and all persisted child records", async () => {
  await withStore(({ database, store }) => {
    const deletedConversation = store.createConversation(
      "/workspace/deleted",
      "workspace_sandbox",
    );
    const retainedConversation = store.createConversation(
      "/workspace/retained",
      "workspace_sandbox",
    );
    const run = store.beginRun(
      deletedConversation.id,
      "question",
      "deleted-run",
    );
    store.appendRunMessages(
      deletedConversation.id,
      run.turnId,
      run.runId,
      [{ role: "assistant", content: "answer" }],
      { status: "completed", finalAnswer: "answer" },
    );

    store.deleteConversation(deletedConversation.id);

    assert.throws(
      () => store.getConversation(deletedConversation.id),
      ConversationNotFoundError,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM turns").get()?.count,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count,
      0,
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM transcript_messages",
      ).get()?.count,
      0,
    );
    assert.equal(
      store.getConversation(retainedConversation.id).id,
      retainedConversation.id,
    );
    assert.throws(
      () => store.deleteConversation(deletedConversation.id),
      ConversationNotFoundError,
    );
  });
});

test("SQLite store rejects deleting a conversation with an active run", async () => {
  await withStore(({ store }) => {
    const conversation = store.createConversation(
      "/workspace",
      "workspace_sandbox",
    );
    const run = store.beginRun(conversation.id, "question", "active-run");

    assert.throws(
      () => store.deleteConversation(conversation.id),
      ConversationBusyError,
    );
    assert.equal(store.getConversation(conversation.id).turns.length, 1);

    store.appendRunMessages(
      conversation.id,
      run.turnId,
      run.runId,
      [],
      { status: "cancelled" },
    );
  });
});

test("appendRunMessages rolls back all messages when one insert fails", async () => {
  await withStore(({ database, store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const run = store.beginRun(conversation.id, "question", "run");
    database.exec(`
      CREATE TRIGGER reject_second_message
      BEFORE INSERT ON transcript_messages
      WHEN NEW.seq = 1
      BEGIN
        SELECT RAISE(ABORT, 'reject test message');
      END
    `);

    assert.throws(
      () =>
        store.appendRunMessages(
          conversation.id,
          run.turnId,
          run.runId,
          [
            { role: "assistant", content: "one" },
            { role: "assistant", content: "two" },
          ],
          { status: "completed", finalAnswer: "two" },
        ),
      /reject test message/,
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM transcript_messages WHERE conversation_id = $conversationId
      `).get({ "$conversationId": conversation.id })?.count,
      1,
    );
    assert.equal(
      database.prepare(`
        SELECT status FROM runs WHERE id = 'run'
      `).get()?.status,
      "running",
    );

    database.exec("DROP TRIGGER reject_second_message");
  });
});

test("SQLite store records run model calls for completed and failed runs", async () => {
  await withStore(({ database, store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const completed = store.beginRun(conversation.id, "question", "run-completed");
    store.appendRunMessages(
      conversation.id,
      completed.turnId,
      completed.runId,
      [{ role: "assistant", content: "answer" }],
      {
        status: "completed",
        finalAnswer: "answer",
        modelCalls: [
          {
            seq: 0,
            kind: "step",
            step: 1,
            model: "test-model",
            usage: {
              model: "test-model",
              inputTokens: 100,
              cachedInputTokens: 40,
              outputTokens: 20,
              reasoningTokens: 5,
            },
            createdAt: "2026-08-19T00:00:00.000Z",
          },
        ],
      },
    );

    assert.deepEqual(database.prepare(`
      SELECT seq, kind, step, model, input_tokens, cached_input_tokens,
             output_tokens, reasoning_tokens, created_at
      FROM run_model_calls
      WHERE run_id = 'run-completed'
    `).all().map((row) => ({ ...row })), [{
      seq: 0,
      kind: "step",
      step: 1,
      model: "test-model",
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 20,
      reasoning_tokens: 5,
      created_at: "2026-08-19T00:00:00.000Z",
    }]);

    const failed = store.beginRun(conversation.id, "failed", "run-failed");
    store.appendRunMessages(
      conversation.id,
      failed.turnId,
      failed.runId,
      [],
      {
        status: "failed",
        modelCalls: [
          {
            seq: 0,
            kind: "context_compaction",
            model: "test-model",
            createdAt: "2026-08-19T00:00:01.000Z",
          },
        ],
      },
    );

    assert.deepEqual(database.prepare(`
      SELECT seq, kind, step, model, input_tokens
      FROM run_model_calls
      WHERE run_id = 'run-failed'
    `).all().map((row) => ({ ...row })), [{
      seq: 0,
      kind: "context_compaction",
      step: null,
      model: "test-model",
      input_tokens: null,
    }]);
  });
});

test("conversation usage sums every run including failed retries", async () => {
  await withStore(({ store }) => {
    const conversation = store.createConversation(
      "/workspace",
      "workspace_sandbox",
    );
    const usage = (inputTokens: number) => ({
      model: "m",
      inputTokens,
      cachedInputTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
    });
    const failed = store.beginRun(conversation.id, "question", "run-attempt-1");
    store.appendRunMessages(
      conversation.id,
      failed.turnId,
      failed.runId,
      [],
      {
        status: "failed",
        errorCode: "AGENT_RUN_FAILED",
        errorMessage: "Agent run failed.",
        modelCalls: [{
          seq: 0,
          kind: "step",
          step: 1,
          model: "m",
          usage: usage(100),
          createdAt: "now",
        }],
      },
    );
    const retried = store.beginRun(conversation.id, "question", "run-attempt-2", 2);
    store.appendRunMessages(
      conversation.id,
      retried.turnId,
      retried.runId,
      [{ role: "assistant", content: "answer" }],
      {
        status: "completed",
        finalAnswer: "answer",
        modelCalls: [{
          seq: 0,
          kind: "step",
          step: 1,
          model: "m",
          usage: usage(300),
          createdAt: "now",
        }],
      },
    );

    const view = store.getConversation(conversation.id);
    assert.deepEqual(view.usage, {
      calls: 2,
      unmeasuredCalls: 0,
      inputTokens: 400,
      cachedInputTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
    });
  });
});

test("run usage totals are zero for a run without model calls", async () => {
  await withStore(({ store }) => {
    const conversation = store.createConversation(
      "/workspace",
      "workspace_sandbox",
    );
    const run = store.beginRun(conversation.id, "question", "run-no-calls");
    store.appendRunMessages(
      conversation.id,
      run.turnId,
      run.runId,
      [{ role: "assistant", content: "answer" }],
      { status: "completed", finalAnswer: "answer" },
    );

    assert.deepEqual(store.getRunUsageTotals(run.runId), {
      calls: 0,
      unmeasuredCalls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
  });
});

test("cascades model calls and transcript messages when the conversation is deleted", async () => {
  await withStore(({ database, store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const run = store.beginRun(conversation.id, "question", "run");
    store.appendRunMessages(
      conversation.id,
      run.turnId,
      run.runId,
      [{ role: "assistant", content: "answer" }],
      {
        status: "completed",
        finalAnswer: "answer",
        modelCalls: [{
          seq: 0,
          kind: "step",
          step: 1,
          model: "m",
          createdAt: "now",
        }],
      },
    );
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM run_model_calls
    `).get()?.count, 1);

    store.deleteConversation(conversation.id);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM run_model_calls
    `).get()?.count, 0);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM transcript_messages
    `).get()?.count, 0);
  });
});

async function withStore(
  operation: (
    resources: {
      database: DatabaseSync;
      store: SQLiteConversationStore;
    },
  ) => void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-sqlite-store-"));
  const database = openSqliteDatabase(join(directory, "agent.sqlite"));
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  try {
    operation({ database, store });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("SQLite store persists a finished sub agent run beside the parent's linear transcript", async () => {
  await withStore(({ database, store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const parent = store.beginRun(conversation.id, "delegate", "run-parent");
    const childTranscript = [
      { role: "user" as const, content: "Find the marker." },
      {
        role: "assistant" as const,
        content: null,
        toolCalls: [{ callId: "child-read", name: "read", arguments: "{}" }],
      },
      {
        role: "tool" as const,
        results: [{
          toolCallId: "child-read",
          result: {
            type: "tool_result" as const,
            tool: "read",
            status: "success" as const,
            output: { content: "marker" },
          },
        }],
      },
      { role: "assistant" as const, content: "Found it." },
    ];

    store.appendSubAgentRun({
      id: "child-1",
      parentRunId: parent.runId,
      toolCallId: "call-agent",
      description: "find marker",
      status: "completed",
      stopReason: "final",
      finalAnswer: "Found it.",
      systemPrompt: "child prompt",
      transcript: childTranscript,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    store.appendSubAgentRun({
      id: "child-2",
      parentRunId: parent.runId,
      toolCallId: "call-agent-2",
      description: "run tests",
      status: "failed",
      errorCode: "AGENT_RUN_FAILED",
      errorMessage: "Agent run failed.",
      internalError: "stack",
      systemPrompt: "child prompt",
      transcript: [{ role: "user", content: "Run tests." }],
      createdAt: "2026-09-18T00:00:01.000Z",
    });
    store.appendRunMessages(
      conversation.id,
      parent.turnId,
      parent.runId,
      [{ role: "assistant", content: "parent answer" }],
      {
        status: "completed",
        finalAnswer: "parent answer",
        modelCalls: [
          { seq: 0, kind: "step", step: 1, model: "m", createdAt: "2026-09-18T00:00:00.000Z" },
          {
            seq: 1,
            kind: "sub_agent",
            subAgentRunId: "child-1",
            model: "m",
            usage: { model: "m", inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, reasoningTokens: 0 },
            createdAt: "2026-09-18T00:00:00.000Z",
          },
          {
            seq: 2,
            kind: "sub_agent",
            subAgentRunId: "child-1",
            model: "m",
            usage: { model: "m", inputTokens: 50, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0 },
            createdAt: "2026-09-18T00:00:00.000Z",
          },
        ],
      },
    );

    // 主线 transcript 只有父 Run 的消息。
    assert.deepEqual(store.loadConversationTranscript(conversation.id), [
      { role: "user", content: "delegate" },
      { role: "assistant", content: "parent answer" },
    ]);
    assert.deepEqual(store.loadSubAgentTranscript("child-1"), childTranscript);

    const listed = store.listSubAgentRuns(parent.runId);
    assert.deepEqual(
      listed.map((run) => ({
        id: run.id,
        toolCallId: run.toolCallId,
        status: run.status,
        finalAnswer: run.finalAnswer,
        error: run.error,
        messageCount: run.messageCount,
        usage: run.usage,
      })),
      [
        {
          id: "child-1",
          toolCallId: "call-agent",
          status: "completed",
          finalAnswer: "Found it.",
          error: undefined,
          messageCount: 4,
          usage: {
            calls: 2,
            unmeasuredCalls: 0,
            inputTokens: 150,
            cachedInputTokens: 10,
            outputTokens: 25,
            reasoningTokens: 0,
          },
        },
        {
          id: "child-2",
          toolCallId: "call-agent-2",
          status: "failed",
          finalAnswer: undefined,
          error: { code: "AGENT_RUN_FAILED", message: "Agent run failed." },
          messageCount: 1,
          usage: {
            calls: 0,
            unmeasuredCalls: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
        },
      ],
    );

    const view = store.getConversation(conversation.id);
    const run = view.turns[0]!.runs[0]!;
    assert.deepEqual(run.subAgentRuns.map((child) => child.id), ["child-1", "child-2"]);
    assert.equal(run.usage.calls, 3);
    assert.equal(view.usage.inputTokens, 150);

    assert.equal(
      database.prepare("SELECT sub_agent_run_id FROM run_model_calls WHERE seq = 1").get()
        ?.sub_agent_run_id,
      "child-1",
    );

    store.deleteConversation(conversation.id);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sub_agent_runs").get()?.n, 0);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM sub_agent_transcript_messages").get()?.n,
      0,
    );
  });
});

test("SQLite store rejects sub agent runs that break the record contract", async () => {
  await withStore(({ store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const parent = store.beginRun(conversation.id, "delegate", "run-parent");
    const base = {
      id: "child-1",
      parentRunId: parent.runId,
      toolCallId: "call-agent",
      description: "d",
      systemPrompt: "p",
      transcript: [{ role: "user" as const, content: "t" }],
      createdAt: "2026-09-18T00:00:00.000Z",
    };

    assert.throws(
      () => store.appendSubAgentRun({ ...base, parentRunId: "missing", status: "cancelled" }),
      ConversationStateError,
    );
    assert.throws(() =>
      store.appendSubAgentRun({ ...base, status: "completed" })
    );
    assert.throws(() =>
      store.appendSubAgentRun({ ...base, status: "failed", finalAnswer: "x" })
    );
    assert.throws(() =>
      store.appendSubAgentRun({ ...base, status: "cancelled", description: " " })
    );
    assert.throws(() => store.loadSubAgentTranscript("missing"), ConversationStateError);

    store.appendSubAgentRun({ ...base, status: "cancelled" });
    assert.throws(() =>
      store.appendSubAgentRun({ ...base, id: "child-2", status: "cancelled" }),
      /UNIQUE/,
    );
  });
});

test("SQLite child persistence writes usage prefixes once and rejects divergence", async () => {
  await withStore(({ database, store }) => {
    const conversation = store.createConversation("/workspace", "workspace_sandbox");
    const parent = store.beginRun(conversation.id, "delegate", "run-parent");
    const call = (seq: number, inputTokens: number) => ({
      seq, kind: "sub_agent" as const, subAgentRunId: `child-${seq}`,
      model: "m", usage: { model: "m", inputTokens, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const prefix = [call(0, 10)];
    const child = (id: string) => ({
      id, parentRunId: parent.runId, toolCallId: id, description: "inspect",
      status: "cancelled" as const, systemPrompt: "child", transcript: [{ role: "user" as const, content: "x" }],
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    store.appendSubAgentRun(child("child-0"), { modelCalls: prefix });
    assert.equal(store.getRunUsageTotals(parent.runId).calls, 1);
    assert.equal(store.getConversation(conversation.id).turns[0]!.runs[0]!.status, "running");
    assert.equal(store.listSubAgentRuns(parent.runId)[0]!.usage.inputTokens, 10);
    store.appendSubAgentRun(child("child-1"), { modelCalls: [prefix[0]!, call(1, 20)] });
    assert.equal(store.getRunUsageTotals(parent.runId).inputTokens, 30);
    assert.throws(() => store.appendSubAgentRun(child("child-bad"), {
      modelCalls: [{ ...prefix[0]!, usage: { ...prefix[0]!.usage, inputTokens: 99 } }],
    }));
    assert.equal(store.listSubAgentRuns(parent.runId).some((run) => run.id === "child-bad"), false);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sub_agent_transcript_messages WHERE sub_agent_run_id = ?").get("child-bad")?.n, 0);
    const parentCall = { seq: 2, kind: "step" as const, step: 2, model: "m", createdAt: "2026-09-18T00:00:01.000Z" };
    store.appendRunMessages(conversation.id, parent.turnId, parent.runId, [{ role: "assistant", content: "done" }], {
      status: "completed", finalAnswer: "done", modelCalls: [prefix[0]!, call(1, 20), parentCall],
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM run_model_calls WHERE run_id = ?").get(parent.runId)?.n, 3);
    assert.equal(store.getRunUsageTotals(parent.runId).unmeasuredCalls, 1);
    const unknown = database.prepare("SELECT input_tokens, output_tokens FROM run_model_calls WHERE run_id = ? AND seq = 2").get(parent.runId);
    assert.equal(unknown?.input_tokens, null);
    assert.equal(unknown?.output_tokens, null);
  });
});
