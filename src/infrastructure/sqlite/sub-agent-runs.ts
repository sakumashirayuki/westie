// sub_agent_runs 与 sub_agent_transcript_messages 两张表。子 Run 不参与会话级
// 的 active_run 状态机，只要父 Run 存在就能落库，所以单独成一个小仓储。

import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import {
  MAX_RUN_TRANSCRIPT_BYTES,
  type StoredRunUsage,
  type SubAgentRunRecord,
  type SubAgentStopReason,
} from "../../application/conversation-store.js";
import {
  ConversationStateError,
  type SubAgentRunStatus,
  type SubAgentRunView,
} from "../../domain/conversation.js";
import { emptyRunUsageTotals, type RunUsageTotals } from "../../run-usage.js";
import {
  serializeTranscriptMessage,
  transcriptBytes,
  type TranscriptMessage,
} from "../../transcript.js";
import {
  expectInteger,
  expectNullableString,
  expectString,
  invalidColumn,
  mapTranscriptMessageRow,
  readRunRow,
  type SQLiteRow,
} from "./rows.js";
import {
  aggregateSubAgentUsageTotals,
  insertRunModelCallSuffix,
} from "./run-model-calls.js";
import { immediateTransaction } from "./transaction.js";

const SUB_AGENT_RUN_SELECT = `
  SELECT
    sub_agent_runs.id,
    sub_agent_runs.parent_run_id,
    sub_agent_runs.tool_call_id,
    sub_agent_runs.description,
    sub_agent_runs.status,
    sub_agent_runs.stop_reason,
    sub_agent_runs.final_answer,
    sub_agent_runs.error_code,
    sub_agent_runs.error_message,
    sub_agent_runs.message_count,
    sub_agent_runs.created_at,
    sub_agent_runs.updated_at
  FROM sub_agent_runs
`;

export class SQLiteSubAgentRunStore {
  constructor(private readonly database: DatabaseSync) {}

  append(record: SubAgentRunRecord, usage: StoredRunUsage = {}): void {
    const bytes = transcriptBytes(record.transcript);
    if (bytes > MAX_RUN_TRANSCRIPT_BYTES) {
      throw new Error(
        `Sub agent transcript exceeds ${MAX_RUN_TRANSCRIPT_BYTES} bytes.`,
      );
    }
    if (record.description.trim() === "") {
      throw new Error("A sub agent run must include a non-empty description.");
    }
    if ((record.status === "completed") !== (record.finalAnswer !== undefined)) {
      throw new Error(
        "A completed sub agent run must carry a final answer, and only it may.",
      );
    }
    if ((record.status === "completed") !== (record.stopReason !== undefined)) {
      throw new Error(
        "A completed sub agent run must carry a stop reason, and only it may.",
      );
    }

    immediateTransaction(this.database, () => {
      if (readRunRow(this.database, record.parentRunId) === undefined) {
        throw new ConversationStateError(
          `Run ${record.parentRunId} does not exist for sub agent run ${record.id}.`,
        );
      }
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO sub_agent_runs (
          id, parent_run_id, tool_call_id, description, status, stop_reason,
          final_answer, error_code, error_message, internal_error,
          system_prompt, message_count, transcript_bytes, created_at, updated_at
        ) VALUES (
          $id, $parentRunId, $toolCallId, $description, $status, $stopReason,
          $finalAnswer, $errorCode, $errorMessage, $internalError,
          $systemPrompt, $messageCount, $transcriptBytes, $createdAt, $updatedAt
        )
      `).run({
        "$id": record.id,
        "$parentRunId": record.parentRunId,
        "$toolCallId": record.toolCallId,
        "$description": record.description,
        "$status": record.status,
        "$stopReason": record.stopReason ?? null,
        "$finalAnswer": record.finalAnswer ?? null,
        "$errorCode": record.errorCode ?? null,
        "$errorMessage": record.errorMessage ?? null,
        "$internalError": record.internalError ?? null,
        "$systemPrompt": record.systemPrompt,
        "$messageCount": record.transcript.length,
        "$transcriptBytes": bytes,
        "$createdAt": record.createdAt,
        "$updatedAt": now,
      });
      const insertMessage = this.database.prepare(`
        INSERT INTO sub_agent_transcript_messages (
          sub_agent_run_id, seq, role, message_json
        ) VALUES ($subAgentRunId, $seq, $role, $messageJson)
      `);
      for (const [seq, message] of record.transcript.entries()) {
        insertMessage.run({
          "$subAgentRunId": record.id,
          "$seq": seq,
          "$role": message.role,
          "$messageJson": serializeTranscriptMessage(message),
        });
      }
      // 子记录写成功后，再把父 Run 尚未保存的模型调用后缀补上：子用量要能立即
      // 读到，同时不能重复插入父 Run 已保存的前缀。
      insertRunModelCallSuffix(
        this.database,
        record.parentRunId,
        usage.modelCalls ?? [],
      );
    });
  }

  listByParentRun(runId: string): readonly SubAgentRunView[] {
    const rows = this.database.prepare(`
      ${SUB_AGENT_RUN_SELECT}
      WHERE sub_agent_runs.parent_run_id = $runId
      ORDER BY sub_agent_runs.created_at ASC, sub_agent_runs.id ASC
    `).all({ "$runId": runId });
    const usage = this.#usageFor(rows);
    return rows.map((row) => mapSubAgentRunRow(row, usage));
  }

  /** 一个 Conversation 内的全部子 Run，按父 Run id 分组。 */
  listByConversation(
    conversationId: string,
  ): Map<string, SubAgentRunView[]> {
    const rows = this.database.prepare(`
      ${SUB_AGENT_RUN_SELECT}
      INNER JOIN runs ON runs.id = sub_agent_runs.parent_run_id
      INNER JOIN turns ON turns.id = runs.turn_id
      WHERE turns.conversation_id = $conversationId
      ORDER BY sub_agent_runs.created_at ASC, sub_agent_runs.id ASC
    `).all({ "$conversationId": conversationId });
    const usage = this.#usageFor(rows);
    const result = new Map<string, SubAgentRunView[]>();
    for (const row of rows) {
      const parentRunId = expectString(row.parent_run_id, "parent_run_id");
      const view = mapSubAgentRunRow(row, usage);
      const group = result.get(parentRunId);
      if (group === undefined) result.set(parentRunId, [view]);
      else group.push(view);
    }
    return result;
  }

  loadTranscript(subAgentRunId: string): readonly TranscriptMessage[] {
    const exists = this.database.prepare(
      "SELECT id FROM sub_agent_runs WHERE id = $id",
    ).get({ "$id": subAgentRunId });
    if (exists === undefined) {
      throw new ConversationStateError(
        `Sub agent run ${subAgentRunId} was not found.`,
      );
    }
    return this.database.prepare(`
      SELECT role, message_json
      FROM sub_agent_transcript_messages
      WHERE sub_agent_run_id = $id
      ORDER BY seq ASC
    `).all({ "$id": subAgentRunId }).map(mapTranscriptMessageRow);
  }

  #usageFor(rows: readonly SQLiteRow[]): Map<string, RunUsageTotals> {
    return aggregateSubAgentUsageTotals(
      this.database,
      rows.map((row) => expectString(row.id, "id")),
    );
  }
}

function mapSubAgentRunRow(
  row: SQLiteRow,
  usage: ReadonlyMap<string, RunUsageTotals>,
): SubAgentRunView {
  const id = expectString(row.id, "id");
  const finalAnswer = expectNullableString(row.final_answer, "final_answer");
  const errorCode = expectNullableString(row.error_code, "error_code");
  const errorMessage = expectNullableString(row.error_message, "error_message");
  const stopReason = expectNullableString(row.stop_reason, "stop_reason");
  return {
    id,
    toolCallId: expectString(row.tool_call_id, "tool_call_id"),
    description: expectString(row.description, "description"),
    status: expectSubAgentRunStatus(row.status),
    ...(stopReason === null
      ? {}
      : { stopReason: expectSubAgentStopReason(stopReason) }),
    ...(finalAnswer === null ? {} : { finalAnswer }),
    ...(errorCode === null || errorMessage === null
      ? {}
      : { error: { code: errorCode, message: errorMessage } }),
    usage: usage.get(id) ?? emptyRunUsageTotals(),
    messageCount: expectInteger(row.message_count, "message_count"),
    createdAt: expectString(row.created_at, "created_at"),
    updatedAt: expectString(row.updated_at, "updated_at"),
  };
}

function expectSubAgentRunStatus(
  value: SQLOutputValue | undefined,
): SubAgentRunStatus {
  if (value === "completed" || value === "failed" || value === "cancelled") {
    return value;
  }
  throw invalidColumn("status");
}

function expectSubAgentStopReason(value: string): SubAgentStopReason {
  if (value === "final" || value === "step_limit") return value;
  throw invalidColumn("stop_reason");
}
