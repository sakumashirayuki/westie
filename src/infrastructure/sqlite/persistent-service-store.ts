import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type { ExecutionMode } from "../../domain/conversation.js";
import { expectInteger, expectNullableInteger, expectNullableString, expectString } from "./rows.js";

export type PersistentServiceStatus =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "stopped"
  | "failed"
  | "interrupted";

export const LIVE_SERVICE_STATUSES = [
  "starting",
  "running",
  "stopping",
] as const satisfies readonly PersistentServiceStatus[];

export interface PersistentServiceRow {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly name: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly executionMode: ExecutionMode;
  readonly status: PersistentServiceStatus;
  readonly pid: number | null;
  readonly artifactsDir: string;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly finalLogTail: string | null;
  readonly logTruncated: boolean;
  readonly createdByConversationId: string | null;
  readonly createdByToolCallId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface InsertPersistentService {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly name: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly executionMode: ExecutionMode;
  readonly status: "starting" | "exited";
  readonly pid: number | null;
  readonly artifactsDir: string;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly createdByConversationId: string | null;
  readonly createdByToolCallId: string | null;
  readonly createdAt: string;
}

const LIVE_STATUS_SQL = "( 'starting', 'running', 'stopping' )";

/**
 * `persistent_services` 表的读写。状态推进全部使用带状态条件的 UPDATE，由
 * SQLite 裁决并发；live（starting/running/stopping）行必须带 pid 且没有结束
 * 时间，`exited`/`stopped` 行必须带退出码或信号，`failed`/`interrupted` 两者
 * 皆无，这些一致性由表级 CHECK 约束兜底。
 */
export class SQLitePersistentServiceStore {
  constructor(private readonly database: DatabaseSync) {}

  insert(row: InsertPersistentService): void {
    this.database.prepare(`
      INSERT INTO persistent_services (
        id,
        workspace_root,
        name,
        command,
        cwd,
        execution_mode,
        status,
        pid,
        artifacts_dir,
        exit_code,
        exit_signal,
        final_log_tail,
        log_truncated,
        created_by_conversation_id,
        created_by_tool_call_id,
        created_at,
        updated_at,
        ended_at
      ) VALUES (
        $id,
        $workspaceRoot,
        $name,
        $command,
        $cwd,
        $executionMode,
        $status,
        $pid,
        $artifactsDir,
        $exitCode,
        $exitSignal,
        NULL,
        0,
        $createdByConversationId,
        $createdByToolCallId,
        $createdAt,
        $createdAt,
        CASE WHEN $status IN ('exited') THEN $createdAt ELSE NULL END
      )
    `).run({
      "$id": row.id,
      "$workspaceRoot": row.workspaceRoot,
      "$name": row.name,
      "$command": row.command,
      "$cwd": row.cwd,
      "$executionMode": row.executionMode,
      "$status": row.status,
      "$pid": row.pid,
      "$artifactsDir": row.artifactsDir,
      "$exitCode": row.exitCode,
      "$exitSignal": row.exitSignal,
      "$createdByConversationId": row.createdByConversationId,
      "$createdByToolCallId": row.createdByToolCallId,
      "$createdAt": row.createdAt,
    });
  }

  read(id: string): PersistentServiceRow | undefined {
    const row = this.database.prepare(`
      SELECT
        id,
        workspace_root,
        name,
        command,
        cwd,
        execution_mode,
        status,
        pid,
        artifacts_dir,
        exit_code,
        exit_signal,
        final_log_tail,
        log_truncated,
        created_by_conversation_id,
        created_by_tool_call_id,
        created_at,
        updated_at,
        ended_at
      FROM persistent_services
      WHERE id = $id
    `).get({ "$id": id });
    return row === undefined ? undefined : mapPersistentServiceRow(row);
  }

  /** 按工作区列出全部 live 记录加最近 `limit` 条终态记录。 */
  listForWorkspace(
    workspaceRoot: string,
    terminalLimit: number,
  ): readonly PersistentServiceRow[] {
    const rows = this.database.prepare(`
      SELECT
        id,
        workspace_root,
        name,
        command,
        cwd,
        execution_mode,
        status,
        pid,
        artifacts_dir,
        exit_code,
        exit_signal,
        final_log_tail,
        log_truncated,
        created_by_conversation_id,
        created_by_tool_call_id,
        created_at,
        updated_at,
        ended_at
      FROM persistent_services
      WHERE workspace_root = $workspaceRoot
        AND (
          status IN ${LIVE_STATUS_SQL}
          OR id IN (
            SELECT id
            FROM persistent_services
            WHERE workspace_root = $workspaceRoot
              AND status NOT IN ${LIVE_STATUS_SQL}
            ORDER BY ended_at DESC
            LIMIT $terminalLimit
          )
        )
      ORDER BY
        CASE WHEN status IN ${LIVE_STATUS_SQL} THEN 0 ELSE 1 END,
        created_at DESC,
        id DESC
    `).all({
      "$workspaceRoot": workspaceRoot,
      "$terminalLimit": terminalLimit,
    });
    return rows.map(mapPersistentServiceRow);
  }

  /** 当前工作区 live（starting/running/stopping）service 数量。 */
  countLive(workspaceRoot: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM persistent_services
      WHERE workspace_root = $workspaceRoot
        AND status IN ${LIVE_STATUS_SQL}
    `).get({ "$workspaceRoot": workspaceRoot });
    return expectInteger(row?.count, "count");
  }

  /** 启动恢复前读取全部历史 live 行，返回时按 id 排序保证确定顺序。 */
  listInterruptible(): readonly PersistentServiceRow[] {
    const rows = this.database.prepare(`
      SELECT
        id,
        workspace_root,
        name,
        command,
        cwd,
        execution_mode,
        status,
        pid,
        artifacts_dir,
        exit_code,
        exit_signal,
        final_log_tail,
        log_truncated,
        created_by_conversation_id,
        created_by_tool_call_id,
        created_at,
        updated_at,
        ended_at
      FROM persistent_services
      WHERE status IN ${LIVE_STATUS_SQL}
      ORDER BY id
    `).all();
    return rows.map(mapPersistentServiceRow);
  }

  /**
   * 条件推进到 `running`：只有 `starting` 行且 pid 尚未被清空时推进，返回是否
   * 推进成功。宽限窗口结束时进程仍存活调用。
   */
  markRunning(id: string, now: string): boolean {
    const updated = this.database.prepare(`
      UPDATE persistent_services
      SET status = 'running', updated_at = $now
      WHERE id = $id
        AND status = 'starting'
        AND pid IS NOT NULL
    `).run({ "$id": id, "$now": now });
    return updated.changes === 1;
  }

  /**
   * 自然退出：把 `starting`/`running` 推进到 `exited`，写退出信息、尾部日志与
   * 结束时间，并清空 pid。返回是否推进成功；竞争失败（如已被 stop 置为
   * `stopping`）由调用方重新读取当前状态。
   */
  markExited(
    id: string,
    outcome: {
      readonly exitCode: number | null;
      readonly exitSignal: string | null;
      readonly finalLogTail: string | null;
    },
    now: string,
  ): boolean {
    const updated = this.database.prepare(`
      UPDATE persistent_services
      SET
        status = 'exited',
        pid = NULL,
        exit_code = $exitCode,
        exit_signal = $exitSignal,
        final_log_tail = $finalLogTail,
        updated_at = $now,
        ended_at = $now
      WHERE id = $id
        AND status IN ('starting', 'running')
    `).run({
      "$id": id,
      "$exitCode": outcome.exitCode,
      "$exitSignal": outcome.exitSignal,
      "$finalLogTail": outcome.finalLogTail,
      "$now": now,
    });
    return updated.changes === 1;
  }

  /**
   * 发起停止：把 `starting`/`running` 推进到 `stopping`。返回是否推进成功；
   * 已终态时返回 false，调用方按幂等 no-op 处理。
   */
  markStopping(id: string, now: string): boolean {
    const updated = this.database.prepare(`
      UPDATE persistent_services
      SET status = 'stopping', updated_at = $now
      WHERE id = $id
        AND status IN ('starting', 'running')
    `).run({ "$id": id, "$now": now });
    return updated.changes === 1;
  }

  /**
   * 停止完成：把 `stopping` 推进到 `stopped`，写退出信息、尾部日志与结束时间，
   * 并清空 pid。`exitSignal` 为 null 且 `exitCode` 为 null 时（强杀兜底后仍拿不到
   * 退出信息）用 'SIGKILL' 兜底，满足表级「exited/stopped 必须带退出码或信号」
   * 的 CHECK 约束。
   */
  markStopped(
    id: string,
    outcome: {
      readonly exitCode: number | null;
      readonly exitSignal: string | null;
      readonly finalLogTail: string | null;
    },
    now: string,
  ): boolean {
    const updated = this.database.prepare(`
      UPDATE persistent_services
      SET
        status = 'stopped',
        pid = NULL,
        exit_code = $exitCode,
        exit_signal = $exitSignal,
        final_log_tail = $finalLogTail,
        updated_at = $now,
        ended_at = $now
      WHERE id = $id
        AND status = 'stopping'
    `).run({
      "$id": id,
      "$exitCode": outcome.exitCode,
      "$exitSignal":
        outcome.exitCode === null && outcome.exitSignal === null
          ? "SIGKILL"
          : outcome.exitSignal,
      "$finalLogTail": outcome.finalLogTail,
      "$now": now,
    });
    return updated.changes === 1;
  }

  /** 记录启动前失败（spawn 或 artifacts 初始化失败）。 */
  insertFailed(
    row: {
      readonly id: string;
      readonly workspaceRoot: string;
      readonly name: string | null;
      readonly command: string;
      readonly cwd: string;
      readonly executionMode: ExecutionMode;
      readonly artifactsDir: string;
      readonly createdByConversationId: string | null;
      readonly createdByToolCallId: string | null;
    },
    now: string,
  ): void {
    this.database.prepare(`
      INSERT INTO persistent_services (
        id,
        workspace_root,
        name,
        command,
        cwd,
        execution_mode,
        status,
        pid,
        artifacts_dir,
        exit_code,
        exit_signal,
        final_log_tail,
        log_truncated,
        created_by_conversation_id,
        created_by_tool_call_id,
        created_at,
        updated_at,
        ended_at
      ) VALUES (
        $id,
        $workspaceRoot,
        $name,
        $command,
        $cwd,
        $executionMode,
        'failed',
        NULL,
        $artifactsDir,
        NULL,
        NULL,
        NULL,
        0,
        $createdByConversationId,
        $createdByToolCallId,
        $createdAt,
        $createdAt,
        $createdAt
      )
    `).run({
      "$id": row.id,
      "$workspaceRoot": row.workspaceRoot,
      "$name": row.name,
      "$command": row.command,
      "$cwd": row.cwd,
      "$executionMode": row.executionMode,
      "$artifactsDir": row.artifactsDir,
      "$createdByConversationId": row.createdByConversationId,
      "$createdByToolCallId": row.createdByToolCallId,
      "$createdAt": now,
    });
  }

  /** 启动恢复：把历史 live 行统一置为 `interrupted`，清空 pid 并写结束时间。 */
  markInterrupted(id: string, now: string): void {
    this.database.prepare(`
      UPDATE persistent_services
      SET
        status = 'interrupted',
        pid = NULL,
        updated_at = $now,
        ended_at = $now
      WHERE id = $id
        AND status IN ('starting', 'running', 'stopping')
    `).run({ "$id": id, "$now": now });
  }
}

function mapPersistentServiceRow(
  row: Record<string, SQLOutputValue>,
): PersistentServiceRow {
  const executionMode = row.execution_mode;
  if (executionMode !== "workspace_sandbox" && executionMode !== "full_access") {
    throw new Error("SQLite column execution_mode has an invalid value.");
  }
  const status = row.status;
  if (
    status !== "starting" &&
    status !== "running" &&
    status !== "stopping" &&
    status !== "exited" &&
    status !== "stopped" &&
    status !== "failed" &&
    status !== "interrupted"
  ) {
    throw new Error("SQLite column status has an invalid value.");
  }
  const logTruncated = row.log_truncated;
  if (logTruncated !== 0 && logTruncated !== 1) {
    throw new Error("SQLite column log_truncated has an invalid value.");
  }
  return {
    id: expectString(row.id, "id"),
    workspaceRoot: expectString(row.workspace_root, "workspace_root"),
    name: expectNullableString(row.name, "name"),
    command: expectString(row.command, "command"),
    cwd: expectString(row.cwd, "cwd"),
    executionMode,
    status,
    pid: expectNullableInteger(row.pid, "pid"),
    artifactsDir: expectString(row.artifacts_dir, "artifacts_dir"),
    exitCode: expectNullableInteger(row.exit_code, "exit_code"),
    exitSignal: expectNullableString(row.exit_signal, "exit_signal"),
    finalLogTail: expectNullableString(row.final_log_tail, "final_log_tail"),
    logTruncated: logTruncated === 1,
    createdByConversationId: expectNullableString(
      row.created_by_conversation_id,
      "created_by_conversation_id",
    ),
    createdByToolCallId: expectNullableString(
      row.created_by_tool_call_id,
      "created_by_tool_call_id",
    ),
    createdAt: expectString(row.created_at, "created_at"),
    updatedAt: expectString(row.updated_at, "updated_at"),
    endedAt: expectNullableString(row.ended_at, "ended_at"),
  };
}
