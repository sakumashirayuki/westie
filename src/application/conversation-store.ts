import type { TranscriptMessage } from "../transcript.js";
import type { RunModelCall, RunUsageTotals } from "../run-usage.js";
import type {
  ConversationSummaryView,
  ConversationView,
  ExecutionMode,
  RunSteeringMessageView,
  SubAgentRunStatus,
  SubAgentRunView,
} from "../domain/conversation.js";

export const MAX_RUN_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
/** 摘要文本的绝对上界，只用于存储层校验；实际预算由 ContextBudget 推导。 */
export const MAX_CONTEXT_SUMMARY_BYTES = 64 * 1024;

export interface RunContextCompaction {
  readonly position: number;
  readonly coveredThroughSeq: number;
  readonly summary: string;
  readonly createdAt: string;
}

export interface BegunConversationRun {
  readonly conversationId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly executionMode: ExecutionMode;
  /** 会话已保存的项目归属；历史会话可能尚未识别，此时为 null。 */
  readonly projectKey: string | null;
  readonly projectRoot: string | null;
  /** 会话工作目录的已知类型；历史会话可能为 null。 */
  readonly workspaceKind: StoredWorkspaceKind | null;
}

export interface StoredRunUsage {
  readonly contextCompactions?: readonly RunContextCompaction[];
  readonly modelCalls?: readonly RunModelCall[];
}

export interface RunOutcome extends StoredRunUsage {}

export interface AppendRunMessagesOutcome extends RunOutcome {
  readonly status: "completed" | "failed" | "cancelled";
  readonly finalAnswer?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly internalError?: string;
}

/** 子 Run 结束时一次写入的完整记录；transcript 归属子 Run 自己的 id。 */
export interface SubAgentRunRecord {
  readonly id: string;
  readonly parentRunId: string;
  readonly toolCallId: string;
  readonly description: string;
  readonly status: SubAgentRunStatus;
  /** 仅 completed 非空：正常结束为 final，达到步数上限为 step_limit。 */
  readonly stopReason?: SubAgentStopReason;
  readonly finalAnswer?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly internalError?: string;
  readonly systemPrompt: string;
  readonly transcript: readonly TranscriptMessage[];
  readonly createdAt: string;
}

export type SubAgentStopReason = "final" | "step_limit";

/** 新建会话时一并写入的项目归属；省略表示该会话尚未识别。 */
export interface ConversationProjectAssignment {
  readonly projectKey: string;
  readonly projectRoot: string;
}

/**
 * 会话工作目录的已知类型。创建会话时按用户选择写入；历史会话为 NULL，
 * 由读取时的实时探测推断。
 */
export type StoredWorkspaceKind =
  | "main"
  | "worktree"
  | "subdirectory"
  | "directory";

/** 同一事务里创建会话并关联 worktree 操作记录；两者必须同时生效。 */
export interface WorktreeConversationCommit {
  readonly canonicalWorkspaceRoot: string;
  readonly executionMode: ExecutionMode;
  readonly project: ConversationProjectAssignment;
  readonly workspaceKind: StoredWorkspaceKind;
  readonly worktreeOperationId: string;
}

export interface ConversationListPosition {
  readonly updatedAt: string;
  readonly id: string;
}

export interface ConversationListQuery {
  readonly limit: number;
  readonly after?: ConversationListPosition;
  /** 按归档状态过滤；省略返回全部会话。 */
  readonly archived?: boolean;
}

export interface ConversationStore {
  createConversation(
    canonicalWorkspaceRoot: string,
    executionMode: ExecutionMode,
    project?: ConversationProjectAssignment,
    workspaceKind?: StoredWorkspaceKind,
  ): ConversationView;
  /** 创建会话、写入项目归属并把 worktree 操作标记为 `completed`，三者同一事务。 */
  createWorktreeConversation(commit: WorktreeConversationCommit): ConversationView;
  getConversation(conversationId: string): ConversationView;
  /**
   * 回填项目归属。只在该会话两列仍为 NULL 时写入，不改变 `revision`、
   * `updated_at`、标题或运行状态；已被其它请求回填时返回 false。
   */
  recordConversationProject(
    conversationId: string,
    project: ConversationProjectAssignment,
  ): boolean;
  /** 仅当会话此时仍无归属时写入项目归属和目录类型；任一列已有值则不写。 */
  recordConversationMembership(
    conversationId: string,
    project: ConversationProjectAssignment,
    workspaceKind: StoredWorkspaceKind,
  ): boolean;
  /** 设置工作目录类型；历史会话第一次读取探测成功后再写入。 */
  recordConversationWorkspaceKind(
    conversationId: string,
    kind: StoredWorkspaceKind,
  ): void;
  /** 设置标题，`null` 清除；运行中的会话抛 `ConversationBusyError`。返回会话摘要。 */
  renameConversation(
    conversationId: string,
    title: string | null,
  ): ConversationSummaryView;
  getActiveRunId(conversationId: string): string | undefined;
  deleteConversation(conversationId: string): void;
  /** 从最近更新的会话中查找已保存的项目归属。 */
  findConversationProject(projectKey: string): ConversationProjectAssignment | undefined;
  listConversations(
    query: ConversationListQuery,
  ): readonly ConversationSummaryView[];
  /**
   * 归档一个没有活动 Run 的会话：把 `archived` 置为 1，`revision` 自增，
   * `updated_at` 更新。已有活动 Run 抛 `ConversationBusyError`，已归档抛
   * `ConversationArchivedError`。
   */
  archiveConversation(conversationId: string): void;
  /** 是否存在另一个未归档会话，其 canonical workspace_root 等于给定目录。 */
  hasActiveConversationAt(
    exceptConversationId: string,
    workspaceRoot: string,
  ): boolean;
  beginRun(
    conversationId: string,
    input: string,
    runId: string,
    attempt?: number,
  ): BegunConversationRun;
  recordRunSystemPrompt(
    conversationId: string,
    turnId: string,
    runId: string,
    systemPrompt: string,
  ): void;
  loadConversationTranscript(
    conversationId: string,
  ): readonly TranscriptMessage[];
  loadConversationCompactions(
    conversationId: string,
  ): readonly RunContextCompaction[];
  listRunSteeringMessages(
    runId: string,
  ): readonly RunSteeringMessageView[];
  appendRunMessages(
    conversationId: string,
    turnId: string,
    runId: string,
    messages: readonly TranscriptMessage[],
    outcome: AppendRunMessagesOutcome,
  ): void;
  getRunUsageTotals(runId: string): RunUsageTotals;
  /** 父 Run 仍在运行时写入一个已结束的子 Run 及其全部消息。 */
  appendSubAgentRun(
    record: SubAgentRunRecord,
    usage?: StoredRunUsage,
  ): void;
  listSubAgentRuns(runId: string): readonly SubAgentRunView[];
  loadSubAgentTranscript(subAgentRunId: string): readonly TranscriptMessage[];
}
