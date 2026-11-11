import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exportConversationDiagnostic,
  resolveDatabasePath,
  runDiagnoseConversationCli,
} from "../src/cli/diagnose-conversation.js";
import {
  initializeSqliteSchema,
  openSqliteDatabase,
} from "../src/infrastructure/sqlite/index.js";

test("exportConversationDiagnostic exports structural data without sensitive content by default", (t) => {
  const fixture = createFixture(t);

  const diagnostic = exportConversationDiagnostic(
    fixture.databasePath,
    fixture.conversationId,
  );
  const serialized = JSON.stringify(diagnostic);
  const conversation = diagnostic.conversation as {
    workspace: Record<string, unknown>;
    turns: Array<Record<string, unknown>>;
    transcript: Array<Record<string, unknown>>;
    contextCompactions: Array<Record<string, unknown>>;
    usage: Record<string, unknown>;
  };
  const turn = conversation.turns[0];
  const run = (turn.runs as Array<Record<string, unknown>>)[0];
  const message = conversation.transcript[0];
  const compaction = conversation.contextCompactions[0];

  assert.deepEqual(conversation.workspace, { name: "secret-project" });
  assert.equal(turn.userMessageBytes, Buffer.byteLength("secret user message"));
  assert.equal(turn.openingSeq, 0);
  assert.equal(run.errorCode, "PROVIDER_FAILED");
  assert.equal(run.errorMessage, "Provider request failed.");
  assert.equal(
    run.systemPromptBytes,
    Buffer.byteLength("secret system prompt"),
  );
  assert.equal(message.role, "tool");
  assert.equal(
    message.messageBytes,
    Buffer.byteLength(JSON.stringify(toolMessage())),
  );
  assert.equal(message.runId, fixture.runId);
  assert.equal(compaction.coveredThroughSeq, 0);
  assert.equal(compaction.summaryBytes, Buffer.byteLength("secret summary"));
  assert.equal(diagnostic.diagnosticVersion, 7);
  assert.deepEqual(run.modelCalls, [
    {
      seq: 0,
      kind: "step",
      step: 1,
      subAgentRunId: null,
      model: "test-model",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 5,
      createdAt: "2026-08-04T00:00:00.000Z",
    },
    {
      seq: 1,
      kind: "context_compaction",
      step: null,
      subAgentRunId: null,
      model: "test-model",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      createdAt: "2026-08-04T00:00:00.000Z",
    },
    {
      seq: 2,
      kind: "sub_agent",
      step: null,
      subAgentRunId: SUB_AGENT_RUN_ID,
      model: "test-model",
      inputTokens: 30,
      cachedInputTokens: 0,
      outputTokens: 7,
      reasoningTokens: 0,
      createdAt: "2026-08-04T00:00:00.000Z",
    },
  ]);
  const expectedUsage = {
    calls: 3,
    unmeasuredCalls: 1,
    inputTokens: 130,
    cachedInputTokens: 40,
    outputTokens: 27,
    reasoningTokens: 5,
  };
  assert.deepEqual(run.usage, expectedUsage);
  assert.deepEqual(conversation.usage, expectedUsage);
  const subAgentRun = (run.subAgentRuns as Array<Record<string, unknown>>)[0];
  assert.equal(subAgentRun.id, SUB_AGENT_RUN_ID);
  assert.equal(subAgentRun.toolCallId, "secret-agent-call");
  assert.equal(subAgentRun.status, "completed");
  assert.equal(subAgentRun.messageCount, 1);
  assert.equal(subAgentRun.transcriptBytes, 64);
  assert.equal(
    subAgentRun.systemPromptBytes,
    Buffer.byteLength("secret child prompt"),
  );
  assert.deepEqual(subAgentRun.usage, {
    calls: 1,
    unmeasuredCalls: 0,
    inputTokens: 30,
    cachedInputTokens: 0,
    outputTokens: 7,
    reasoningTokens: 0,
  });
  const childMessage = (subAgentRun.transcript as Array<Record<string, unknown>>)[0];
  assert.equal(childMessage.role, "user");
  assert.equal(childMessage.message, undefined);
  assert.doesNotMatch(serialized, /secret child answer/);
  assert.doesNotMatch(serialized, /secret child prompt/);
  assert.doesNotMatch(serialized, /secret child task/);
  assert.doesNotMatch(serialized, /\/Users\/person\/secret-project/);
  assert.doesNotMatch(serialized, /secret user message/);
  assert.doesNotMatch(serialized, /secret-tool-token/);
  assert.doesNotMatch(serialized, /secret-call-id/);
  assert.doesNotMatch(serialized, /secret stack/);
  assert.doesNotMatch(serialized, /secret system prompt/);
  assert.doesNotMatch(serialized, /secret summary/);
});

test("exportConversationDiagnostic includes content only when explicitly requested", (t) => {
  const fixture = createFixture(t);

  const diagnostic = exportConversationDiagnostic(
    fixture.databasePath,
    fixture.conversationId,
    { includeContent: true },
  );
  const serialized = JSON.stringify(diagnostic);

  assert.match(serialized, /\/Users\/person\/secret-project/);
  assert.match(serialized, /secret user message/);
  assert.match(serialized, /secret-tool-token/);
  assert.match(serialized, /secret-call-id/);
  assert.match(serialized, /secret stack/);
  assert.match(serialized, /secret system prompt/);
  assert.match(serialized, /secret summary/);
  assert.match(serialized, /secret child answer/);
  assert.match(serialized, /secret child prompt/);
  assert.match(serialized, /secret child task/);
});

test("CLI rejects invalid and unknown conversation IDs with a non-zero result", (t) => {
  const fixture = createFixture(t);
  const invalid = captureCli(["not-a-uuid"], fixture.databasePath);
  const missing = captureCli([randomUUID()], fixture.databasePath);

  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid conversation ID/);
  assert.equal(invalid.stdout, "");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /was not found/);
  assert.equal(missing.stdout, "");
});

test("CLI warns on stderr before exporting sensitive content", (t) => {
  const fixture = createFixture(t);

  const result = captureCli(
    [fixture.conversationId, "--include-content"],
    fixture.databasePath,
  );

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Treat the JSON as sensitive/);
  assert.match(result.stderr, /context summaries/);
  assert.match(result.stdout, /secret-tool-token/);
});

test("diagnostic database connection is read-only and does not create a missing file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-diagnostic-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "missing.sqlite");

  assert.throws(
    () => exportConversationDiagnostic(databasePath, randomUUID()),
    /unable to open database file/,
  );
});

test("resolveDatabasePath resolves the same environment setting used by the service", () => {
  assert.equal(
    resolveDatabasePath({ AGENT_DATABASE_PATH: "state/test.sqlite" }, "/workspace"),
    "/workspace/state/test.sqlite",
  );
  assert.equal(
    resolveDatabasePath({ AGENT_DATABASE_PATH: "/state/test.sqlite" }, "/workspace"),
    "/state/test.sqlite",
  );
});

interface Fixture {
  readonly databasePath: string;
  readonly conversationId: string;
  readonly runId: string;
}

const SUB_AGENT_RUN_ID = "11111111-2222-4333-8444-555555555555";

function createFixture(t: test.TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "agent-diagnostic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "agent.sqlite");
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const runId = randomUUID();
  const database = openSqliteDatabase(databasePath);
  initializeSqliteSchema(database);
  const now = "2026-08-04T00:00:00.000Z";
  database.prepare(`
    INSERT INTO conversations (
      id, revision, workspace_root, execution_mode,
      active_run_id, created_at, updated_at
    ) VALUES (?, 3, ?, 'workspace_sandbox', NULL, ?, ?)
  `).run(conversationId, "/Users/person/secret-project", now, now);
  database.prepare(`
    INSERT INTO turns (
      id, conversation_id, position, user_message, opening_seq,
      status, created_at, updated_at
    ) VALUES (?, ?, 0, ?, 0, 'failed', ?, ?)
  `).run(turnId, conversationId, "secret user message", now, now);
  database.prepare(`
    INSERT INTO runs (
      id, turn_id, attempt, status, final_answer,
      message_count, transcript_bytes, created_at, updated_at,
      error_code, error_message, internal_error, system_prompt
    ) VALUES (?, ?, 1, 'failed', NULL, 1, 128, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    turnId,
    now,
    now,
    "PROVIDER_FAILED",
    "Provider request failed.",
    "secret stack /Users/person/secret-project/file.ts",
    "secret system prompt",
  );
  database.prepare(`
    INSERT INTO transcript_messages (conversation_id, seq, run_id, role, message_json)
    VALUES (?, 0, ?, 'tool', ?)
  `).run(conversationId, runId, JSON.stringify(toolMessage()));
  database.prepare(`
    INSERT INTO conversation_context_compactions (
      conversation_id, position, covered_through_seq, summary_text, created_at
    ) VALUES (?, 0, 0, 'secret summary', ?)
  `).run(conversationId, now);
  database.prepare(`
    INSERT INTO run_model_calls (
      run_id, seq, kind, step, model,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
      created_at
    ) VALUES (?, 0, 'step', 1, 'test-model', 100, 40, 20, 5, ?)
  `).run(runId, now);
  database.prepare(`
    INSERT INTO run_model_calls (
      run_id, seq, kind, step, model,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
      created_at
    ) VALUES (?, 1, 'context_compaction', NULL, 'test-model', NULL, NULL, NULL, NULL, ?)
  `).run(runId, now);
  database.prepare(`
    INSERT INTO sub_agent_runs (
      id, parent_run_id, tool_call_id, description, status, stop_reason, final_answer,
      error_code, error_message, internal_error, system_prompt,
      message_count, transcript_bytes, created_at, updated_at
    ) VALUES (?, ?, 'secret-agent-call', 'secret description', 'completed', 'final',
      'secret child answer', NULL, NULL, NULL, 'secret child prompt', 1, 64, ?, ?)
  `).run(SUB_AGENT_RUN_ID, runId, now, now);
  database.prepare(`
    INSERT INTO sub_agent_transcript_messages (
      sub_agent_run_id, seq, role, message_json
    ) VALUES (?, 0, 'user', ?)
  `).run(
    SUB_AGENT_RUN_ID,
    JSON.stringify({ role: "user", content: "secret child task" }),
  );
  database.prepare(`
    INSERT INTO run_model_calls (
      run_id, seq, kind, step, sub_agent_run_id, model,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
      created_at
    ) VALUES (?, 2, 'sub_agent', NULL, ?, 'test-model', 30, 0, 7, 0, ?)
  `).run(runId, SUB_AGENT_RUN_ID, now);
  if (database.isOpen) database.close();
  return { databasePath, conversationId, runId };
}

function toolMessage() {
  return {
    role: "tool",
    results: [{
      toolCallId: "secret-call-id",
      result: {
      type: "tool_result",
      tool: "read",
      status: "success",
      output: { token: "secret-tool-token" },
      },
    }],
  } as const;
}

function captureCli(
  args: readonly string[],
  databasePath: string,
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  let stdout = "";
  let stderr = "";
  const status = runDiagnoseConversationCli(
    args,
    { AGENT_DATABASE_PATH: databasePath },
    process.cwd(),
    { write(chunk) { stdout += String(chunk); return true; } },
    { write(chunk) { stderr += String(chunk); return true; } },
  );
  return { status, stdout, stderr };
}
