import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type { ExecutionMode } from "../../domain/conversation.js";
import { expectNullableString, expectString } from "./rows.js";

export type WorktreeOperationStatus =
  /** 创建参数和起始 commit 已保存，尚未进入 Git 创建阶段。 */
  | "prepared"
  /** 已进入 Git 创建阶段，目录和分支可能已产生。 */
  | "started"
  | "completed"
  | "needs_inspection";

export interface WorktreeOperationRecord {
  readonly id: string;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly targetPath: string;
  readonly branch: string;
  /**
   * 起点分支：本地分支名，或远端起点的 `<remote>/<branch>`；与
   * `baseRemote` 一起描述远端起点。
   */
  readonly baseBranch: string;
  /** 远端起点的远端名；本地起点为 null。 */
  readonly baseRemote: string | null;
  readonly baseCommit: string;
  readonly executionMode: ExecutionMode;
  readonly status: WorktreeOperationStatus;
  readonly conversationId: string | null;
}

export interface PreparedWorktreeOperation extends Omit<
  WorktreeOperationRecord,
  "id" | "status" | "conversationId"
> {
  readonly id: string;
}

/**
 * worktree 创建操作日志的读写。状态推进只用条件更新，由 SQLite 裁决并发：
 * `prepared → started → completed`，失败或中断统一落到 `needs_inspection`。
 * 调用方负责事务边界：单条条件更新本身是原子的。
 */
export class SQLiteWorktreeOperationStore {
  constructor(private readonly database: DatabaseSync) {}

  /**
   * 登记 `prepared` 操作。同一 id 已存在时返回已有记录，调用方比较参数；
   * 不覆盖已固定的起点 commit。
   */
  prepare(
    operation: PreparedWorktreeOperation,
  ): { readonly created: boolean; readonly record: WorktreeOperationRecord } {
    const inserted = this.database.prepare(`
      INSERT INTO worktree_operations (
        id,
        project_key,
        project_root,
        target_path,
        branch,
        base_branch,
        base_remote,
        base_commit,
        execution_mode,
        status,
        conversation_id
      ) VALUES (
        $id,
        $projectKey,
        $projectRoot,
        $targetPath,
        $branch,
        $baseBranch,
        $baseRemote,
        $baseCommit,
        $executionMode,
        'prepared',
        NULL
      )
      ON CONFLICT (id) DO NOTHING
    `).run({
      "$id": operation.id,
      "$projectKey": operation.projectKey,
      "$projectRoot": operation.projectRoot,
      "$targetPath": operation.targetPath,
      "$branch": operation.branch,
      "$baseBranch": operation.baseBranch,
      "$baseRemote": operation.baseRemote,
      "$baseCommit": operation.baseCommit,
      "$executionMode": operation.executionMode,
    });
    const record = this.read(operation.id);
    if (record === undefined) {
      throw new Error(`Worktree operation ${operation.id} was not persisted.`);
    }
    return { created: inserted.changes === 1, record };
  }

  read(operationId: string): WorktreeOperationRecord | undefined {
    const row = this.database.prepare(`
      SELECT
        id,
        project_key,
        project_root,
        target_path,
        branch,
        base_branch,
        base_remote,
        base_commit,
        execution_mode,
        status,
        conversation_id
      FROM worktree_operations
      WHERE id = $operationId
    `).get({ "$operationId": operationId });
    return row === undefined ? undefined : mapWorktreeOperationRow(row);
  }

  /** `prepared` 条件更新为 `started`；已被其它请求推进时返回 false。 */
  markStarted(operationId: string): boolean {
    const updated = this.database.prepare(`
      UPDATE worktree_operations
      SET status = 'started'
      WHERE id = $operationId
        AND status = 'prepared'
    `).run({ "$operationId": operationId });
    return updated.changes === 1;
  }

  /**
   * 按会话 id 查找最近一条 `completed` 的 worktree 操作，用于归档时定位需要
   * 清理的 worktree；没有则返回 undefined。
   */
  findCompletedByConversation(
    conversationId: string,
  ): WorktreeOperationRecord | undefined {
    const row = this.database.prepare(`
      SELECT
        id,
        project_key,
        project_root,
        target_path,
        branch,
        base_branch,
        base_remote,
        base_commit,
        execution_mode,
        status,
        conversation_id
      FROM worktree_operations
      WHERE conversation_id = $conversationId
        AND status = 'completed'
      ORDER BY id DESC
      LIMIT 1
    `).get({ "$conversationId": conversationId });
    return row === undefined ? undefined : mapWorktreeOperationRow(row);
  }

  /** 记录失败或中断。已是 `completed` 的操作保持不变。 */
  markNeedsInspection(operationId: string): void {
    this.database.prepare(`
      UPDATE worktree_operations
      SET status = 'needs_inspection'
      WHERE id = $operationId
        AND status IN ('prepared', 'started')
    `).run({ "$operationId": operationId });
  }

  /**
   * 启动时调用：进程重启前没走完的操作状态不可信，统一转为
   * `needs_inspection`，由用户检查目标目录与分支后决定，不自动重跑。
   */
  markInterruptedOperations(): number {
    const updated = this.database.prepare(`
      UPDATE worktree_operations
      SET status = 'needs_inspection'
      WHERE status IN ('prepared', 'started')
    `).run();
    return Number(updated.changes);
  }
}

function mapWorktreeOperationRow(
  row: Record<string, SQLOutputValue>,
): WorktreeOperationRecord {
  const executionMode = row.execution_mode;
  if (executionMode !== "workspace_sandbox" && executionMode !== "full_access") {
    throw new Error("SQLite column execution_mode has an invalid value.");
  }
  const status = row.status;
  if (
    status !== "prepared" &&
    status !== "started" &&
    status !== "completed" &&
    status !== "needs_inspection"
  ) {
    throw new Error("SQLite column status has an invalid value.");
  }
  return {
    id: expectString(row.id , "id"),
    projectKey: expectString(row.project_key , "project_key"),
    projectRoot: expectString(row.project_root , "project_root"),
    targetPath: expectString(row.target_path , "target_path"),
    branch: expectString(row.branch , "branch"),
    baseBranch: expectString(row.base_branch , "base_branch"),
    baseRemote: expectNullableString(row.base_remote , "base_remote"),
    baseCommit: expectString(row.base_commit , "base_commit"),
    executionMode,
    status,
    conversationId: expectNullableString(
      row.conversation_id ,
      "conversation_id",
    ),
  };
}
