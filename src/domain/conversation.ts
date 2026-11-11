import type { SubAgentStopReason } from "../application/conversation-store.js";
import type { RunUsageTotals } from "../run-usage.js";

export type ConversationRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutionMode = "workspace_sandbox" | "full_access";

export interface ConversationRunView {
  readonly id: string;
  readonly attempt: number;
  readonly status: ConversationRunStatus;
  readonly error?: { readonly code: string; readonly message: string };
  readonly usage: RunUsageTotals;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly steeringMessages: readonly RunSteeringMessageView[];
  /** 该 Run 委托出去的子 Run，按开始时间排序。 */
  readonly subAgentRuns: readonly SubAgentRunView[];
}

export type SubAgentRunStatus = "completed" | "failed" | "cancelled";

export interface SubAgentRunView {
  readonly id: string;
  /** 父 Run 里那次 agent 调用的 callId。 */
  readonly toolCallId: string;
  readonly description: string;
  readonly status: SubAgentRunStatus;
  readonly stopReason?: SubAgentStopReason;
  readonly finalAnswer?: string;
  readonly error?: { readonly code: string; readonly message: string };
  /** 该子 Run 自己的模型调用用量，来自父 Run 的 sub_agent 记账。 */
  readonly usage: RunUsageTotals;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunSteeringMessageView {
  readonly seq: number;
  readonly content: string;
}

export interface ConversationTurnView {
  readonly id: string;
  readonly userMessage: string;
  readonly assistantMessage?: string;
  readonly status: ConversationRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runs: readonly ConversationRunView[];
}

export interface ConversationWorkspaceView {
  readonly name: string;
  readonly canonicalPath: string;
}

/**
 * 会话所属项目。`git:<canonical git common dir>` 与 `dir:<canonical directory>`
 * 是持久化归属，来自 `conversations.project_key`；项目展示名与操作锚点来自
 * `conversations.project_root`。两者都为 NULL 的会话属于「未识别」分组。
 */
export interface ConversationProjectView {
  readonly key: string;
  readonly root: string;
  readonly name: string;
}

/** 工作目录类型；由服务端按目录、Git 登记与所选入口判定。 */
export type WorkspaceKind =
  | "main"
  | "worktree"
  | "subdirectory"
  | "directory"
  | "unknown";

/** 实时读取的分支状态；无法读取 Git 信息时为 `unknown`。 */
export type WorkspaceBranchView =
  | { readonly status: "branch"; readonly name: string }
  | { readonly status: "detached"; readonly commit: string | null }
  | { readonly status: "unknown" };

/** 目录是否可访问；不可用时保留会话历史并给出原因。 */
export type WorkspaceAvailabilityView =
  | { readonly status: "available" }
  | { readonly status: "missing" }
  | { readonly status: "unreadable"; readonly reason: string };

/** 工作目录的实时状态：分支与可用性来自文件系统和 Git，不落库。 */
export interface ConversationWorkspaceStatusView {
  readonly kind: WorkspaceKind;
  readonly branch: WorkspaceBranchView;
  readonly availability: WorkspaceAvailabilityView;
}

export interface ConversationSummaryView {
  readonly id: string;
  readonly revision: number;
  readonly executionMode: ExecutionMode;
  /** 用户设置的会话标题；未设置时为 null，界面回退显示 `workspace.name`。 */
  readonly title: string | null;
  readonly workspace: ConversationWorkspaceView;
  /**
   * 持久化的工作目录类型（`conversations.workspace_kind`）。历史会话读取时
   * 由实时探测推断并补写，推断前为 null；HTTP 响应不下发该字段。
   */
  readonly workspaceKind: WorkspaceKind | null;
  /** 已识别的项目归属；`conversations.project_key` 为 NULL 时为 null。 */
  readonly project: ConversationProjectView | null;
  readonly workspaceStatus: ConversationWorkspaceStatusView;
  /** 是否已归档。归档会话只读，不出现在侧栏主列表。 */
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationView extends ConversationSummaryView {
  /** 该 Conversation 全部 Run（含失败重试）的用量合计。 */
  readonly usage: RunUsageTotals;
  readonly turns: readonly ConversationTurnView[];
}

export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} was not found.`);
    this.name = "ConversationNotFoundError";
  }
}

export class ConversationBusyError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} already has an active run.`);
    this.name = "ConversationBusyError";
  }
}

export class ConversationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationStateError";
  }
}

export class ConversationArchivedError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} is archived.`);
    this.name = "ConversationArchivedError";
  }
}

/** 归档某 worktree 会话时，该 worktree 目录正被另一个未归档会话复用。 */
export class ConversationWorkspaceSharedError extends Error {
  constructor(conversationId: string, workspaceRoot: string) {
    super(
      `Conversation ${conversationId} cannot be archived because its worktree ` +
        `${workspaceRoot} is reused by another active conversation.`,
    );
    this.name = "ConversationWorkspaceSharedError";
  }
}

export class ConversationIdleError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} has no active run.`);
    this.name = "ConversationIdleError";
  }
}

export class SteeringRunMismatchError extends Error {
  constructor(conversationId: string) {
    super(
      `Steering run does not match the active run for conversation ${conversationId}.`,
    );
    this.name = "SteeringRunMismatchError";
  }
}

export class SteeringQueueFullError extends Error {
  constructor() {
    super("Steering queue is full.");
    this.name = "SteeringQueueFullError";
  }
}
