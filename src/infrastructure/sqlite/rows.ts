// SQLite 行到内存结构的映射与列校验。所有 map* 函数只信任列类型，不做业务判断。

import { basename } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import {
  parseTranscriptMessage,
  type TranscriptMessage,
} from "../../transcript.js";
import type { StoredWorkspaceKind } from "../../application/conversation-store.js";
import {
  ConversationNotFoundError,
  type ConversationProjectView,
  type ConversationRunStatus,
  type ConversationSummaryView,
  type ExecutionMode,
  type RunSteeringMessageView,
} from "../../domain/conversation.js";

export type SQLiteRow = Record<string, SQLOutputValue>;

export interface ConversationRow {
  readonly id: string;
  readonly revision: number;
  readonly workspaceRoot: string;
  readonly executionMode: ExecutionMode;
  readonly title: string | null;
  readonly projectKey: string | null;
  readonly projectRoot: string | null;
  readonly workspaceKind: StoredWorkspaceKind | null;
  readonly activeRunId: string | null;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationSummaryRow {
  readonly id: string;
  readonly revision: number;
  readonly workspaceRoot: string;
  readonly executionMode: ExecutionMode;
  readonly title: string | null;
  readonly projectKey: string | null;
  readonly projectRoot: string | null;
  readonly workspaceKind: StoredWorkspaceKind | null;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TurnRow {
  readonly id: string;
  readonly conversationId: string;
  readonly position: number;
  readonly userMessage: string;
  readonly openingSeq: number;
  readonly status: ConversationRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunRow {
  readonly id: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly status: ConversationRunStatus;
  readonly finalAnswer: string | null;
  readonly messageCount: number | null;
  readonly transcriptBytes: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly internalError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function readConversationRow(
  database: DatabaseSync,
  conversationId: string,
): ConversationRow {
  const row = database.prepare(`
    SELECT
      id,
      revision,
      workspace_root,
      execution_mode,
      title,
      project_key,
      project_root,
      workspace_kind,
      active_run_id,
      archived,
      created_at,
      updated_at
    FROM conversations
    WHERE id = $conversationId
  `).get({ "$conversationId": conversationId });
  if (row === undefined) {
    throw new ConversationNotFoundError(conversationId);
  }
  return mapConversationRow(row);
}

/**
 * 按 id 读会话摘要行。摘要只需要 conversations 自身的列，不 join 轮次、Run
 * 与转录；改名等只影响摘要的操作走这里，不付 `getConversation()` 的代价。
 */
export function readConversationSummaryRow(
  database: DatabaseSync,
  conversationId: string,
): ConversationSummaryRow {
  const row = database.prepare(`
    SELECT
      id,
      revision,
      workspace_root,
      execution_mode,
      title,
      project_key,
      project_root,
      workspace_kind,
      archived,
      created_at,
      updated_at
    FROM conversations
    WHERE id = $conversationId
  `).get({ "$conversationId": conversationId });
  if (row === undefined) {
    throw new ConversationNotFoundError(conversationId);
  }
  return mapConversationSummaryRow(row);
}

export function readRunRow(
  database: DatabaseSync,
  runId: string,
): RunRow | undefined {
  const row = database.prepare(`
    SELECT
      id,
      turn_id,
      attempt,
      status,
      final_answer,
      message_count,
      transcript_bytes,
      error_code,
      error_message,
      internal_error,
      created_at,
      updated_at
    FROM runs
    WHERE id = $runId
  `).get({ "$runId": runId });
  return row === undefined ? undefined : mapRunRow(row);
}

export function mapConversationRow(row: SQLiteRow): ConversationRow {
  return {
    id: expectString(row.id, "id"),
    revision: expectInteger(row.revision, "revision"),
    workspaceRoot: expectString(row.workspace_root, "workspace_root"),
    executionMode: expectExecutionMode(row.execution_mode),
    title: expectNullableString(row.title, "title"),
    projectKey: expectNullableString(row.project_key, "project_key"),
    projectRoot: expectNullableString(row.project_root, "project_root"),
    workspaceKind: expectWorkspaceKind(row.workspace_kind),
    activeRunId: expectNullableString(row.active_run_id, "active_run_id"),
    archived: expectArchived(row.archived),
    createdAt: expectString(row.created_at, "created_at"),
    updatedAt: expectString(row.updated_at, "updated_at"),
  };
}

export function mapConversationSummaryRow(
  row: SQLiteRow,
): ConversationSummaryRow {
  return {
    id: expectString(row.id, "id"),
    revision: expectInteger(row.revision, "revision"),
    workspaceRoot: expectString(row.workspace_root, "workspace_root"),
    executionMode: expectExecutionMode(row.execution_mode),
    title: expectNullableString(row.title, "title"),
    projectKey: expectNullableString(row.project_key, "project_key"),
    projectRoot: expectNullableString(row.project_root, "project_root"),
    workspaceKind: expectWorkspaceKind(row.workspace_kind),
    archived: expectArchived(row.archived),
    createdAt: expectString(row.created_at, "created_at"),
    updatedAt: expectString(row.updated_at, "updated_at"),
  };
}

/**
 * 持久化字段转摘要。项目归属与工作目录的实时状态由 `ConversationService`
 * 补齐：前者可能在读取后异步回填，后者来自文件系统与 Git，都不落库。
 */
export function toConversationSummary(
  conversation: ConversationSummaryRow,
): ConversationSummaryView {
  return {
    id: conversation.id,
    revision: conversation.revision,
    executionMode: conversation.executionMode,
    title: conversation.title,
    workspace: {
      name: basename(conversation.workspaceRoot) ||
        conversation.workspaceRoot,
      canonicalPath: conversation.workspaceRoot,
    },
    project: toConversationProject(conversation),
    workspaceKind: conversation.workspaceKind,
    workspaceStatus: {
      kind: "unknown",
      branch: { status: "unknown" },
      availability: { status: "available" },
    },
    archived: conversation.archived,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

/** `project_key` 与 `project_root` 同时有值才算已识别项目；两者成对写入。 */
export function toConversationProject(
  conversation: Pick<ConversationSummaryRow, "projectKey" | "projectRoot">,
): ConversationProjectView | null {
  if (conversation.projectKey === null || conversation.projectRoot === null) {
    return null;
  }
  const root = conversation.projectRoot;
  return {
    key: conversation.projectKey,
    root,
    name: basename(root) || root,
  };
}

export function mapTurnRow(row: SQLiteRow): TurnRow {
  return {
    id: expectString(row.id, "id"),
    conversationId: expectString(row.conversation_id, "conversation_id"),
    position: expectInteger(row.position, "position"),
    userMessage: expectString(row.user_message, "user_message"),
    openingSeq: expectInteger(row.opening_seq, "opening_seq"),
    status: expectRunStatus(row.status),
    createdAt: expectString(row.created_at, "created_at"),
    updatedAt: expectString(row.updated_at, "updated_at"),
  };
}

export function mapRunRow(row: SQLiteRow): RunRow {
  return {
    id: expectString(row.id, "id"),
    turnId: expectString(row.turn_id, "turn_id"),
    attempt: expectInteger(row.attempt, "attempt"),
    status: expectRunStatus(row.status),
    finalAnswer: expectNullableString(row.final_answer, "final_answer"),
    messageCount: expectNullableInteger(row.message_count, "message_count"),
    transcriptBytes: expectNullableInteger(
      row.transcript_bytes,
      "transcript_bytes",
    ),
    errorCode: expectNullableString(row.error_code, "error_code"),
    errorMessage: expectNullableString(row.error_message, "error_message"),
    internalError: expectNullableString(row.internal_error, "internal_error"),
    createdAt: expectString(row.created_at, "created_at"),
    updatedAt: expectString(row.updated_at, "updated_at"),
  };
}

/** `role` 列与 `message_json` 里的 role 必须一致，否则视为损坏数据。 */
export function mapTranscriptMessageRow(row: SQLiteRow): TranscriptMessage {
  const role = expectTranscriptRole(row.role);
  const message = parseTranscriptMessage(
    expectString(row.message_json, "message_json"),
  );
  if (message.role !== role) throw invalidColumn("message_json");
  return message;
}

export function mapSteeringMessageRow(row: SQLiteRow): RunSteeringMessageView {
  const message = parseTranscriptMessage(
    expectString(row.message_json, "message_json"),
  );
  if (message.role !== "user") throw invalidColumn("message_json");
  return {
    seq: expectInteger(row.seq, "seq"),
    content: message.content,
  };
}

export function findLatestCompletedRun(
  runs: readonly RunRow[],
): RunRow | undefined {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index].status === "completed") return runs[index];
  }
  return undefined;
}

export function expectString(
  value: SQLOutputValue | undefined,
  field: string,
): string {
  if (typeof value !== "string") throw invalidColumn(field);
  return value;
}

export function expectNullableString(
  value: SQLOutputValue | undefined,
  field: string,
): string | null {
  if (value !== null && typeof value !== "string") throw invalidColumn(field);
  return value;
}

export function expectInteger(
  value: SQLOutputValue | undefined,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidColumn(field);
  }
  return value;
}

export function expectNullableInteger(
  value: SQLOutputValue | undefined,
  field: string,
): number | null {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isSafeInteger(value))
  ) {
    throw invalidColumn(field);
  }
  return value;
}

export function expectRunStatus(
  value: SQLOutputValue | undefined,
): ConversationRunStatus {
  if (
    value !== "running" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled"
  ) {
    throw invalidColumn("status");
  }
  return value;
}

export function expectExecutionMode(
  value: SQLOutputValue | undefined,
): ExecutionMode {
  if (value !== "workspace_sandbox" && value !== "full_access") {
    throw invalidColumn("execution_mode");
  }
  return value;
}

export function expectArchived(
  value: SQLOutputValue | undefined,
): boolean {
  if (value !== 0 && value !== 1) throw invalidColumn("archived");
  return value === 1;
}

export function expectWorkspaceKind(
  value: SQLOutputValue | undefined,
): StoredWorkspaceKind | null {
  if (value === null) return null;
  if (
    value !== "main" &&
    value !== "worktree" &&
    value !== "subdirectory" &&
    value !== "directory"
  ) {
    throw invalidColumn("workspace_kind");
  }
  return value;
}

export function expectTranscriptRole(
  value: SQLOutputValue | undefined,
): TranscriptMessage["role"] {
  if (value !== "user" && value !== "assistant" && value !== "tool") {
    throw invalidColumn("role");
  }
  return value;
}

export function invalidColumn(field: string): Error {
  return new Error(`SQLite column ${field} has an invalid value.`);
}
