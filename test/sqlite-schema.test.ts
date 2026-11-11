import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  initializeSqliteSchema,
  openSqliteDatabase,
} from "../src/infrastructure/sqlite/index.js";

test("schema initialization creates the current strict conversation schema", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);

    assert.deepEqual(
      database.prepare(`
          SELECT name, strict
          FROM pragma_table_list
          WHERE name IN (
            'conversations',
            'turns',
            'runs',
            'transcript_messages',
            'conversation_context_compactions',
            'run_model_calls',
            'sub_agent_runs',
            'sub_agent_transcript_messages'
          )
          ORDER BY name
        `).all().map((row) => ({
          name: row.name,
          strict: row.strict,
        })),
      [
        { name: "conversation_context_compactions", strict: 1 },
        { name: "conversations", strict: 1 },
        { name: "run_model_calls", strict: 1 },
        { name: "runs", strict: 1 },
        { name: "sub_agent_runs", strict: 1 },
        { name: "sub_agent_transcript_messages", strict: 1 },
        { name: "transcript_messages", strict: 1 },
        { name: "turns", strict: 1 },
      ],
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('sub_agent_runs')
        ORDER BY cid
      `).all().map((row) => ({ ...row })),
      [
        { name: "id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "parent_run_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "tool_call_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "description", type: "TEXT", notnull: 1, pk: 0 },
        { name: "status", type: "TEXT", notnull: 1, pk: 0 },
        { name: "stop_reason", type: "TEXT", notnull: 0, pk: 0 },
        { name: "final_answer", type: "TEXT", notnull: 0, pk: 0 },
        { name: "error_code", type: "TEXT", notnull: 0, pk: 0 },
        { name: "error_message", type: "TEXT", notnull: 0, pk: 0 },
        { name: "internal_error", type: "TEXT", notnull: 0, pk: 0 },
        { name: "system_prompt", type: "TEXT", notnull: 1, pk: 0 },
        { name: "message_count", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "transcript_bytes", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
        { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
      ],
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('sub_agent_transcript_messages')
        ORDER BY cid
      `).all().map((row) => ({ ...row })),
      [
        { name: "sub_agent_run_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "seq", type: "INTEGER", notnull: 1, pk: 2 },
        { name: "role", type: "TEXT", notnull: 1, pk: 0 },
        { name: "message_json", type: "TEXT", notnull: 1, pk: 0 },
      ],
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS n FROM pragma_table_info('run_model_calls')
      `).get()?.n,
      11,
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('conversation_context_compactions')
        ORDER BY cid
      `).all().map((row) => ({ ...row })),
      [
        { name: "conversation_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "position", type: "INTEGER", notnull: 1, pk: 2 },
        { name: "covered_through_seq", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "summary_text", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
      ],
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('turns')
        ORDER BY cid
      `).all().map((row) => ({ ...row })),
      [
        { name: "id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "conversation_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "position", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "user_message", type: "TEXT", notnull: 1, pk: 0 },
        { name: "opening_seq", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "status", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
        { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
      ],
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('transcript_messages')
        ORDER BY cid
      `).all().map((row) => ({ ...row })),
      [
        { name: "conversation_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "seq", type: "INTEGER", notnull: 1, pk: 2 },
        { name: "run_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "role", type: "TEXT", notnull: 1, pk: 0 },
        { name: "message_json", type: "TEXT", notnull: 1, pk: 0 },
      ],
    );
    assert.equal(
      database.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
      1,
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('runs')
        ORDER BY cid
      `).all().map((row) => ({
        name: row.name,
        type: row.type,
        notnull: row.notnull,
        pk: row.pk,
      })),
      [
        { name: "id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "turn_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "attempt", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "status", type: "TEXT", notnull: 1, pk: 0 },
        { name: "final_answer", type: "TEXT", notnull: 0, pk: 0 },
        { name: "message_count", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "transcript_bytes", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "error_code", type: "TEXT", notnull: 0, pk: 0 },
        { name: "error_message", type: "TEXT", notnull: 0, pk: 0 },
        { name: "internal_error", type: "TEXT", notnull: 0, pk: 0 },
        { name: "system_prompt", type: "TEXT", notnull: 0, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
        { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
      ],
    );
    assert.throws(() =>
      database.prepare(`
        INSERT INTO conversations (
          id, revision, workspace_root, active_run_id, created_at, updated_at
        ) VALUES ('missing-mode', 0, '/workspace', NULL, 'now', 'now')
      `).run()
    );

    initializeSqliteSchema(database);
  });
});

test("foreign keys cascade transcript messages with their run", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    database.exec(`
      BEGIN IMMEDIATE;
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode,
        active_run_id, created_at, updated_at
      ) VALUES (
        'conversation', 0, '/workspace', 'workspace_sandbox',
        NULL, 'now', 'now'
      );
      INSERT INTO turns (
        id, conversation_id, position, user_message, opening_seq, status,
        created_at, updated_at
      ) VALUES (
        'turn', 'conversation', 0, 'question', 0, 'completed', 'now', 'now'
      );
      INSERT INTO runs (
        id, turn_id, attempt, status, final_answer, message_count,
        transcript_bytes, created_at, updated_at
      ) VALUES (
        'run', 'turn', 1, 'completed', 'answer', 1, 5, 'now', 'now'
      );
      INSERT INTO transcript_messages (conversation_id, seq, run_id, role, message_json)
      VALUES ('conversation', 0, 'run', 'user', '{"role":"user","content":"hello"}');
      INSERT INTO conversation_context_compactions (
        conversation_id, position, covered_through_seq, summary_text, created_at
      ) VALUES ('conversation', 0, 0, 'summary', 'now');

      COMMIT;
    `);

    database.exec("DELETE FROM runs WHERE id = 'run'");
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM transcript_messages
      `).get()?.count,
      0,
    );
    // 压缩记录改挂在 conversation 上，删掉一个 Run 不影响它。
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM conversation_context_compactions
      `).get()?.count,
      1,
    );
  });
});

test("transcript schema rejects invalid JSON and mismatched roles", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    database.exec(`
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode,
        active_run_id, created_at, updated_at
      ) VALUES (
        'conversation', 0, '/workspace', 'workspace_sandbox',
        NULL, 'now', 'now'
      );
      INSERT INTO turns (
        id, conversation_id, position, user_message, opening_seq, status,
        created_at, updated_at
      ) VALUES (
        'turn', 'conversation', 0, 'question', 0, 'running', 'now', 'now'
      );
      INSERT INTO runs (
        id, turn_id, attempt, status, created_at, updated_at
      ) VALUES ('run', 'turn', 1, 'running', 'now', 'now');
    `);
    const insert = database.prepare(`
      INSERT INTO transcript_messages (conversation_id, seq, run_id, role, message_json)
      VALUES ('conversation', $seq, 'run', $role, $messageJson)
    `);
    for (const [seq, role, messageJson] of [
      [0, "user", "not-json"],
      [1, "user", "[]"],
      [2, "user", '{"content":"missing role"}'],
      [3, "user", '{"role":"tool"}'],
    ] as const) {
      assert.throws(() => insert.run({
        "$seq": seq,
        "$role": role,
        "$messageJson": messageJson,
      }));
    }
  });
});

test("context compaction schema enforces row constraints and unique coverage", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    database.exec(`
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode,
        active_run_id, created_at, updated_at
      ) VALUES (
        'conversation', 0, '/workspace', 'workspace_sandbox',
        NULL, 'now', 'now'
      );
      INSERT INTO turns (
        id, conversation_id, position, user_message, opening_seq, status,
        created_at, updated_at
      ) VALUES (
        'turn', 'conversation', 0, 'question', 0, 'running', 'now', 'now'
      );
      INSERT INTO runs (
        id, turn_id, attempt, status, created_at, updated_at
      ) VALUES ('run', 'turn', 1, 'running', 'now', 'now');
      INSERT INTO conversation_context_compactions (
        conversation_id, position, covered_through_seq, summary_text, created_at
      ) VALUES ('conversation', 0, 2, 'summary', 'now');
    `);
    const insert = database.prepare(`
      INSERT INTO conversation_context_compactions (
        conversation_id, position, covered_through_seq, summary_text, created_at
      ) VALUES ('conversation', $position, $coverage, $summary, 'now')
    `);
    assert.throws(() => insert.run({
      "$position": -1,
      "$coverage": 4,
      "$summary": "summary",
    }));
    assert.throws(() => insert.run({
      "$position": 1,
      "$coverage": 4,
      "$summary": "   ",
    }));
    assert.throws(() => insert.run({
      "$position": 1,
      "$coverage": 2,
      "$summary": "duplicate coverage",
    }));
  });
});

test("run model call schema enforces its CHECK constraints", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    database.exec(`
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode,
        active_run_id, created_at, updated_at
      ) VALUES (
        'conversation', 0, '/workspace', 'workspace_sandbox',
        NULL, 'now', 'now'
      );
      INSERT INTO turns (
        id, conversation_id, position, user_message, opening_seq, status,
        created_at, updated_at
      ) VALUES (
        'turn', 'conversation', 0, 'question', 0, 'running', 'now', 'now'
      );
      INSERT INTO runs (
        id, turn_id, attempt, status, created_at, updated_at
      ) VALUES ('run', 'turn', 1, 'running', 'now', 'now');
    `);
    const insert = database.prepare(`
      INSERT INTO run_model_calls (
        run_id, seq, kind, step, model,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
        created_at
      ) VALUES (
        'run', $seq, $kind, $step, $model,
        $input, $cached, $output, $reasoning, 'now'
      )
    `);

    // cached_input_tokens > input_tokens
    assert.throws(() => insert.run({
      "$seq": 0,
      "$kind": "step",
      "$step": 1,
      "$model": "model",
      "$input": 10,
      "$cached": 11,
      "$output": 5,
      "$reasoning": 0,
    }));

    // kind <> 'step' carries a step
    assert.throws(() => insert.run({
      "$seq": 0,
      "$kind": "context_compaction",
      "$step": 1,
      "$model": "model",
      "$input": null,
      "$cached": null,
      "$output": null,
      "$reasoning": null,
    }));

    // kind = 'step' without a step
    assert.throws(() => insert.run({
      "$seq": 0,
      "$kind": "step",
      "$step": null,
      "$model": "model",
      "$input": null,
      "$cached": null,
      "$output": null,
      "$reasoning": null,
    }));

    // four token columns partially NULL
    assert.throws(() => insert.run({
      "$seq": 0,
      "$kind": "step",
      "$step": 1,
      "$model": "model",
      "$input": 10,
      "$cached": null,
      "$output": 5,
      "$reasoning": 0,
    }));

    // a valid measured row is accepted
    insert.run({
      "$seq": 0,
      "$kind": "step",
      "$step": 1,
      "$model": "model",
      "$input": 10,
      "$cached": 5,
      "$output": 4,
      "$reasoning": 1,
    });
  });
});

test("SQLite schema binds sub_agent model calls to a persisted sub agent run", async () => {
  await withTemporaryDatabase((database) => {
    initializeSqliteSchema(database);
    database.exec(`
      INSERT INTO conversations (
        id, revision, workspace_root, execution_mode, active_run_id,
        created_at, updated_at
      ) VALUES ('conversation', 0, '/workspace', 'workspace_sandbox', NULL, 'now', 'now');
      INSERT INTO turns (
        id, conversation_id, position, user_message, opening_seq, status,
        created_at, updated_at
      ) VALUES ('turn', 'conversation', 0, 'question', 0, 'running', 'now', 'now');
      INSERT INTO runs (
        id, turn_id, attempt, status, created_at, updated_at
      ) VALUES ('run', 'turn', 1, 'running', 'now', 'now');
    `);
    const insertChild = database.prepare(`
      INSERT INTO sub_agent_runs (
        id, parent_run_id, tool_call_id, description, status, stop_reason, final_answer,
        system_prompt, message_count, transcript_bytes, created_at, updated_at
      ) VALUES (
        $id, 'run', $toolCallId, $description, $status, $stopReason, $finalAnswer,
        'child prompt', 0, 0, 'now', 'now'
      )
    `);
    insertChild.run({
      "$id": "child-1",
      "$toolCallId": "call-1",
      "$description": "查错误码",
      "$status": "completed",
      "$stopReason": "final",
      "$finalAnswer": "done",
    });
    // completed without an answer, failed with an answer, blank description, duplicate call
    assert.throws(() => insertChild.run({
      "$id": "child-2", "$toolCallId": "call-2", "$description": "x",
      "$status": "completed", "$finalAnswer": null,
      "$stopReason": "final",
    }));
    assert.throws(() => insertChild.run({
      "$id": "child-2", "$toolCallId": "call-2", "$description": "x",
      "$status": "failed", "$finalAnswer": "oops",
    }));
    assert.throws(() => insertChild.run({
      "$id": "child-2", "$toolCallId": "call-2", "$description": "   ",
      "$status": "failed", "$finalAnswer": null,
    }));
    assert.throws(() => insertChild.run({
      "$id": "child-2", "$toolCallId": "call-1", "$description": "dup",
      "$status": "failed", "$finalAnswer": null,
    }));
    assert.throws(() => insertChild.run({
      "$id": "child-2", "$toolCallId": "call-2", "$description": "x",
      "$status": "running", "$finalAnswer": null,
    }));

    const insertMessage = database.prepare(`
      INSERT INTO sub_agent_transcript_messages (
        sub_agent_run_id, seq, role, message_json
      ) VALUES ($runId, $seq, $role, $json)
    `);
    insertMessage.run({
      "$runId": "child-1", "$seq": 0, "$role": "user",
      "$json": JSON.stringify({ role: "user", content: "task" }),
    });
    assert.throws(() => insertMessage.run({
      "$runId": "child-1", "$seq": 1, "$role": "assistant",
      "$json": JSON.stringify({ role: "user", content: "mismatch" }),
    }));
    assert.throws(() => insertMessage.run({
      "$runId": "missing", "$seq": 0, "$role": "user",
      "$json": JSON.stringify({ role: "user", content: "orphan" }),
    }));

    const insertCall = database.prepare(`
      INSERT INTO run_model_calls (
        run_id, seq, kind, step, sub_agent_run_id, model,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
        created_at
      ) VALUES (
        'run', $seq, $kind, $step, $subAgentRunId, 'model',
        NULL, NULL, NULL, NULL, 'now'
      )
    `);
    insertCall.run({
      "$seq": 0, "$kind": "sub_agent", "$step": null, "$subAgentRunId": "child-1",
    });
    // sub_agent without a child, a child on a non-sub_agent kind, a step on sub_agent
    assert.throws(() => insertCall.run({
      "$seq": 1, "$kind": "sub_agent", "$step": null, "$subAgentRunId": null,
    }));
    assert.throws(() => insertCall.run({
      "$seq": 1, "$kind": "context_compaction", "$step": null, "$subAgentRunId": "child-1",
    }));
    assert.throws(() => insertCall.run({
      "$seq": 1, "$kind": "sub_agent", "$step": 1, "$subAgentRunId": "child-1",
    }));
    assert.throws(() => insertCall.run({
      "$seq": 1, "$kind": "sub_agent", "$step": null, "$subAgentRunId": "missing",
    }));

    // deleting the conversation cascades through runs, sub agent runs and their messages
    database.exec("DELETE FROM conversations WHERE id = 'conversation'");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM sub_agent_runs").get()?.n,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM sub_agent_transcript_messages").get()?.n,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM run_model_calls").get()?.n,
      0,
    );
  });
});

async function withTemporaryDatabase(
  operation: (database: DatabaseSync) => void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-sqlite-schema-"));
  const database = openSqliteDatabase(join(directory, "agent.sqlite"));
  try {
    operation(database);
  } finally {
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
