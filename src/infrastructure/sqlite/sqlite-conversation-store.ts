import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  serializeTranscriptMessage,
  transcriptBytes,
  type TranscriptMessage,
} from "../../transcript.js";
import {
  MAX_RUN_TRANSCRIPT_BYTES,
  type AppendRunMessagesOutcome,
  type ConversationProjectAssignment,
  type BegunConversationRun,
  type ConversationListQuery,
  type ConversationStore,
  type RunContextCompaction,
  type StoredRunUsage,
  type StoredWorkspaceKind,
  type SubAgentRunRecord,
  type WorktreeConversationCommit,
} from "../../application/conversation-store.js";
import {
  emptyRunUsageTotals,
  sumRunUsageTotals,
  type RunUsageTotals,
} from "../../run-usage.js";
import {
  ConversationArchivedError,
  ConversationBusyError,
  ConversationStateError,
  type ConversationSummaryView,
  type ConversationView,
  type ExecutionMode,
  type RunSteeringMessageView,
  type SubAgentRunView,
} from "../../domain/conversation.js";
import {
  insertContextCompactions,
  readConversationCompactions,
  validateRunContextCompactions,
} from "./context-compactions.js";
import {
  expectInteger,
  expectString,
  findLatestCompletedRun,
  mapConversationSummaryRow,
  readConversationSummaryRow,
  mapRunRow,
  mapSteeringMessageRow,
  mapTranscriptMessageRow,
  mapTurnRow,
  readConversationRow,
  readRunRow,
  toConversationProject,
  toConversationSummary,
  type ConversationRow,
  type RunRow,
} from "./rows.js";
import {
  inactiveRunError,
  openNewTurn,
  reopenTurnForRetry,
} from "./run-lifecycle.js";
import {
  aggregateRunUsageTotals,
  insertRunModelCallSuffix,
  readRunUsageTotals,
  validateRunModelCalls,
} from "./run-model-calls.js";
import { SQLiteSubAgentRunStore } from "./sub-agent-runs.js";
import { immediateTransaction } from "./transaction.js";

export const MAX_SQLITE_RUN_TRANSCRIPT_BYTES = MAX_RUN_TRANSCRIPT_BYTES;

export class SQLiteConversationStore implements ConversationStore {
  readonly #subAgentRuns: SQLiteSubAgentRunStore;

  constructor(private readonly database: DatabaseSync) {
    this.#subAgentRuns = new SQLiteSubAgentRunStore(database);
  }

  createConversation(
    canonicalWorkspaceRoot: string,
    executionMode: ExecutionMode,
    project?: ConversationProjectAssignment,
    workspaceKind?: StoredWorkspaceKind,
  ): ConversationView {
    return immediateTransaction(this.database, () => {
      const id = this.insertConversation(
        canonicalWorkspaceRoot,
        executionMode,
        project,
        workspaceKind,
      );
      return this.getConversation(id);
    });
  }

  createWorktreeConversation(
    commit: WorktreeConversationCommit,
  ): ConversationView {
    return immediateTransaction(this.database, () => {
      const id = this.insertConversation(
        commit.canonicalWorkspaceRoot,
        commit.executionMode,
        commit.project,
        commit.workspaceKind,
      );
      const updated = this.database.prepare(`
        UPDATE worktree_operations
        SET status = 'completed', conversation_id = $conversationId
        WHERE id = $operationId
          AND status = 'started'
      `).run({
        "$conversationId": id,
        "$operationId": commit.worktreeOperationId,
      });
      if (updated.changes !== 1) {
        throw new ConversationStateError(
          `Worktree operation ${commit.worktreeOperationId} is not started.`,
        );
      }
      return this.getConversation(id);
    });
  }

  recordConversationProject(
    conversationId: string,
    project: ConversationProjectAssignment,
  ): boolean {
    const updated = this.database.prepare(`
      UPDATE conversations
      SET project_key = $projectKey, project_root = $projectRoot
      WHERE id = $conversationId
        AND project_key IS NULL
        AND project_root IS NULL
    `).run({
      "$projectKey": project.projectKey,
      "$projectRoot": project.projectRoot,
      "$conversationId": conversationId,
    });
    return updated.changes === 1;
  }

  private insertConversation(
    canonicalWorkspaceRoot: string,
    executionMode: ExecutionMode,
    project: ConversationProjectAssignment | undefined,
    workspaceKind: StoredWorkspaceKind | undefined,
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO conversations (
        id,
        revision,
        workspace_root,
        execution_mode,
        project_key,
        project_root,
        workspace_kind,
        active_run_id,
        created_at,
        updated_at
      ) VALUES (
        $id, 0, $workspaceRoot, $executionMode, $projectKey, $projectRoot,
        $workspaceKind, NULL, $now, $now
      )
    `).run({
      "$id": id,
      "$workspaceRoot": canonicalWorkspaceRoot,
      "$executionMode": executionMode,
      "$projectKey": project?.projectKey ?? null,
      "$projectRoot": project?.projectRoot ?? null,
      "$workspaceKind": workspaceKind ?? null,
      "$now": now,
    });
    return id;
  }

  recordConversationMembership(
    conversationId: string,
    project: ConversationProjectAssignment,
    workspaceKind: StoredWorkspaceKind,
  ): boolean {
    // 归属与目录类型同一条 UPDATE：要么都写，要么都不写。
    const updated = this.database.prepare(`
      UPDATE conversations
      SET
        project_key = $projectKey,
        project_root = $projectRoot,
        workspace_kind = $workspaceKind
      WHERE id = $conversationId
        AND project_key IS NULL
        AND project_root IS NULL
    `).run({
      "$projectKey": project.projectKey,
      "$projectRoot": project.projectRoot,
      "$workspaceKind": workspaceKind,
      "$conversationId": conversationId,
    });
    return updated.changes === 1;
  }

  recordConversationWorkspaceKind(
    conversationId: string,
    kind: StoredWorkspaceKind,
  ): void {
    this.database.prepare(`
      UPDATE conversations
      SET workspace_kind = $workspaceKind
      WHERE id = $conversationId
        AND workspace_kind IS NULL
    `).run({
      "$workspaceKind": kind,
      "$conversationId": conversationId,
    });
  }

  getConversation(conversationId: string): ConversationView {
    const conversation = this.getConversationRow(conversationId);
    const turns = this.database.prepare(`
      SELECT
        id,
        conversation_id,
        position,
        user_message,
        opening_seq,
        status,
        created_at,
        updated_at
      FROM turns
      WHERE conversation_id = $conversationId
      ORDER BY position ASC
    `).all({ "$conversationId": conversationId }).map(mapTurnRow);
    const runsByTurn = new Map<string, RunRow[]>();
    let usageByRun = new Map<string, RunUsageTotals>();
    if (turns.length > 0) {
      const runs = this.database.prepare(`
        SELECT
          runs.id,
          runs.turn_id,
          runs.attempt,
          runs.status,
          runs.final_answer,
          runs.message_count,
          runs.transcript_bytes,
          runs.error_code,
          runs.error_message,
          runs.internal_error,
          runs.created_at,
          runs.updated_at
        FROM runs
        INNER JOIN turns ON turns.id = runs.turn_id
        WHERE turns.conversation_id = $conversationId
        ORDER BY turns.position ASC, runs.attempt ASC
      `).all({ "$conversationId": conversationId }).map(mapRunRow);
      for (const run of runs) {
        const turnRuns = runsByTurn.get(run.turnId);
        if (turnRuns === undefined) {
          runsByTurn.set(run.turnId, [run]);
        } else {
          turnRuns.push(run);
        }
      }
      usageByRun = aggregateRunUsageTotals(this.database, conversationId);
    }

    const steeringMessages = this.listConversationRunSteeringMessages(
      conversationId,
    );
    const subAgentRuns = this.#subAgentRuns.listByConversation(conversationId);

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
      usage: sumRunUsageTotals(usageByRun.values()),
      turns: turns.map((turn) => {
        const runs = runsByTurn.get(turn.id) ?? [];
        const completedRun = findLatestCompletedRun(runs);
        return {
          id: turn.id,
          userMessage: turn.userMessage,
          ...(completedRun?.finalAnswer === null ||
              completedRun?.finalAnswer === undefined
            ? {}
            : { assistantMessage: completedRun.finalAnswer }),
          status: turn.status,
          createdAt: turn.createdAt,
          updatedAt: turn.updatedAt,
          runs: runs.map((run) => ({
            id: run.id,
            attempt: run.attempt,
            status: run.status,
            ...(run.errorCode === null || run.errorMessage === null
              ? {}
              : {
                  error: {
                    code: run.errorCode,
                    message: run.errorMessage,
                  },
                }),
            usage: usageByRun.get(run.id) ?? emptyRunUsageTotals(),
            steeringMessages: steeringMessages.get(run.id) ?? [],
            subAgentRuns: subAgentRuns.get(run.id) ?? [],
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
          })),
        };
      }),
    };
  }

  getActiveRunId(conversationId: string): string | undefined {
    const conversation = this.getConversationRow(conversationId);
    return conversation.activeRunId ?? undefined;
  }

  /**
   * 设置会话标题，`null` 表示回到工作区名。只改 `title`，不动 `updated_at` 和
   * `revision`：改名不属于会话活动，列表位置和内容版本都应保持原样。
   * 运行中的会话不允许改名。返回会话摘要，调用方不需要轮次、Run 和用量。
   */
  renameConversation(
    conversationId: string,
    title: string | null,
  ): ConversationSummaryView {
    immediateTransaction(this.database, () => {
      const conversation = this.getConversationRow(conversationId);
      if (conversation.archived) {
        throw new ConversationArchivedError(conversationId);
      }
      if (conversation.activeRunId !== null) {
        throw new ConversationBusyError(conversationId);
      }
      const renamed = this.database.prepare(`
        UPDATE conversations
        SET title = $title
        WHERE id = $conversationId
          AND active_run_id IS NULL
      `).run({
        "$title": title,
        "$conversationId": conversationId,
      });
      if (renamed.changes !== 1) {
        throw new ConversationBusyError(conversationId);
      }
    });
    return toConversationSummary(
      readConversationSummaryRow(this.database, conversationId),
    );
  }

  deleteConversation(conversationId: string): void {
    immediateTransaction(this.database, () => {
      const conversation = this.getConversationRow(conversationId);
      if (conversation.activeRunId !== null) {
        throw new ConversationBusyError(conversationId);
      }
      const deleted = this.database.prepare(`
        DELETE FROM conversations
        WHERE id = $conversationId
      `).run({ "$conversationId": conversationId });
      if (deleted.changes !== 1) {
        throw new ConversationStateError(
          `Conversation ${conversationId} could not be deleted.`,
        );
      }
    });
  }

  findConversationProject(projectKey: string): ConversationProjectAssignment | undefined {
    const row = this.database.prepare(`
      SELECT project_key, project_root FROM conversations
      WHERE project_key = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(projectKey);
    if (row === undefined) return undefined;
    return {
      projectKey: expectString(row.project_key, "project_key"),
      projectRoot: expectString(row.project_root, "project_root"),
    };
  }

  listConversations(
    query: ConversationListQuery,
  ): readonly ConversationSummaryView[] {
    if (!Number.isSafeInteger(query.limit) || query.limit <= 0) {
      throw new Error("Conversation list limit must be a positive integer.");
    }
    const select =
      `SELECT
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
        FROM conversations`;
    const archivedWhere = query.archived === undefined
      ? ""
      : "archived = $archived";
    const commonParams = {
      ...(query.archived === undefined
        ? {}
        : { "$archived": query.archived ? 1 : 0 }),
    };
    const rows =
      query.after === undefined
        ? this.database.prepare(`
            ${select}
            ${archivedWhere === "" ? "" : `WHERE ${archivedWhere}`}
            ORDER BY updated_at DESC, id DESC
            LIMIT $limit
          `).all({ ...commonParams, "$limit": query.limit })
        : this.database.prepare(`
            ${select}
            ${archivedWhere === ""
              ? "WHERE"
              : `WHERE ${archivedWhere} AND`}
            (updated_at < $updatedAt OR (updated_at = $updatedAt AND id < $id))
            ORDER BY updated_at DESC, id DESC
            LIMIT $limit
          `).all({
            "$updatedAt": query.after.updatedAt,
            "$id": query.after.id,
            ...commonParams,
            "$limit": query.limit,
          });
    return rows.map((row) =>
      toConversationSummary(mapConversationSummaryRow(row))
    );
  }

  hasActiveConversationAt(
    exceptConversationId: string,
    workspaceRoot: string,
  ): boolean {
    const row = this.database.prepare(`
      SELECT id
      FROM conversations
      WHERE workspace_root = $workspaceRoot
        AND archived = 0
        AND id <> $conversationId
      LIMIT 1
    `).get({
      "$workspaceRoot": workspaceRoot,
      "$conversationId": exceptConversationId,
    });
    return row !== undefined;
  }

  archiveConversation(conversationId: string): void {
    immediateTransaction(this.database, () => {
      const conversation = this.getConversationRow(conversationId);
      if (conversation.activeRunId !== null) {
        throw new ConversationBusyError(conversationId);
      }
      if (conversation.archived) {
        throw new ConversationArchivedError(conversationId);
      }
      const now = new Date().toISOString();
      const updated = this.database.prepare(`
        UPDATE conversations
        SET
          archived = 1,
          revision = revision + 1,
          updated_at = $now
        WHERE id = $conversationId
          AND active_run_id IS NULL
          AND archived = 0
      `).run({
        "$now": now,
        "$conversationId": conversationId,
      });
      if (updated.changes !== 1) {
        throw new ConversationStateError(
          `Conversation ${conversationId} could not be archived.`,
        );
      }
    });
  }

  beginRun(
    conversationId: string,
    input: string,
    runId: string,
    attempt = 1,
  ): BegunConversationRun {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error("attempt must be a positive integer.");
    }
    return immediateTransaction(this.database, () => {
      const conversation = this.getConversationRow(conversationId);
      if (conversation.archived) {
        throw new ConversationArchivedError(conversationId);
      }
      if (conversation.activeRunId !== null) {
        throw new ConversationBusyError(conversationId);
      }

      const now = new Date().toISOString();
      // 开场 user 消息要等 runs 行落库后再插入：transcript_messages.run_id
      // 有指向 runs(id) 的外键。attempt >= 2 的重试沿用原有开场消息。
      const opened = attempt === 1
        ? openNewTurn(this.database, conversationId, input, now)
        : {
            turnId: reopenTurnForRetry(
              this.database,
              conversationId,
              attempt,
              now,
            ),
            openingSeq: undefined,
          };

      this.database.prepare(`
        INSERT INTO runs (
          id,
          turn_id,
          attempt,
          status,
          final_answer,
          message_count,
          transcript_bytes,
          created_at,
          updated_at
        ) VALUES (
          $id,
          $turnId,
          $attempt,
          'running',
          NULL,
          NULL,
          NULL,
          $now,
          $now
        )
      `).run({
        "$id": runId,
        "$turnId": opened.turnId,
        "$attempt": attempt,
        "$now": now,
      });

      if (opened.openingSeq !== undefined) {
        this.database.prepare(`
          INSERT INTO transcript_messages (
            conversation_id,
            seq,
            run_id,
            role,
            message_json
          ) VALUES (
            $conversationId,
            $seq,
            $runId,
            'user',
            $messageJson
          )
        `).run({
          "$conversationId": conversationId,
          "$seq": opened.openingSeq,
          "$runId": runId,
          "$messageJson": serializeTranscriptMessage({
            role: "user",
            content: input,
          }),
        });
      }

      const updated = this.database.prepare(`
        UPDATE conversations
        SET
          active_run_id = $runId,
          revision = revision + 1,
          updated_at = $now
        WHERE id = $conversationId
          AND active_run_id IS NULL
      `).run({
        "$runId": runId,
        "$now": now,
        "$conversationId": conversationId,
      });
      if (updated.changes !== 1) {
        throw new ConversationBusyError(conversationId);
      }

      return {
        conversationId,
        turnId: opened.turnId,
        runId,
        workspaceRoot: conversation.workspaceRoot,
        executionMode: conversation.executionMode,
        projectKey: conversation.projectKey,
        projectRoot: conversation.projectRoot,
        workspaceKind: conversation.workspaceKind,
      };
    });
  }

  recordRunSystemPrompt(
    conversationId: string,
    turnId: string,
    runId: string,
    systemPrompt: string,
  ): void {
    if (systemPrompt.trim() === "") {
      throw new Error("systemPrompt must not be empty.");
    }
    immediateTransaction(this.database, () => {
      this.assertActiveRun(conversationId, turnId, runId);
      const now = new Date().toISOString();
      const updated = this.database.prepare(`
        UPDATE runs
        SET
          system_prompt = $systemPrompt,
          updated_at = $now
        WHERE id = $runId
          AND turn_id = $turnId
          AND status = 'running'
          AND system_prompt IS NULL
      `).run({
        "$systemPrompt": systemPrompt,
        "$now": now,
        "$runId": runId,
        "$turnId": turnId,
      });
      if (updated.changes !== 1) {
        throw inactiveRunError(conversationId, runId);
      }
    });
  }

  loadConversationTranscript(
    conversationId: string,
  ): readonly TranscriptMessage[] {
    this.getConversationRow(conversationId);
    return this.database.prepare(`
      SELECT role, message_json
      FROM transcript_messages
      WHERE conversation_id = $conversationId
      ORDER BY seq ASC
    `).all({ "$conversationId": conversationId }).map(mapTranscriptMessageRow);
  }

  loadConversationCompactions(
    conversationId: string,
  ): readonly RunContextCompaction[] {
    this.getConversationRow(conversationId);
    return readConversationCompactions(this.database, conversationId);
  }

  listRunSteeringMessages(
    runId: string,
  ): readonly RunSteeringMessageView[] {
    return this.database.prepare(`
      SELECT
        transcript_messages.seq AS seq,
        transcript_messages.message_json AS message_json
      FROM transcript_messages
      INNER JOIN runs ON runs.id = transcript_messages.run_id
      INNER JOIN turns ON turns.id = runs.turn_id
      WHERE transcript_messages.run_id = $runId
        AND transcript_messages.role = 'user'
        AND transcript_messages.seq <> turns.opening_seq
        AND json_extract(transcript_messages.message_json, '$.source') IS NULL
      ORDER BY transcript_messages.seq ASC
    `).all({ "$runId": runId }).map(mapSteeringMessageRow);
  }

  private listConversationRunSteeringMessages(
    conversationId: string,
  ): Map<string, readonly RunSteeringMessageView[]> {
    const rows = this.database.prepare(`
      SELECT
        transcript_messages.run_id AS run_id,
        transcript_messages.seq AS seq,
        transcript_messages.message_json AS message_json
      FROM transcript_messages
      INNER JOIN runs ON runs.id = transcript_messages.run_id
      INNER JOIN turns ON turns.id = runs.turn_id
      WHERE turns.conversation_id = $conversationId
        AND transcript_messages.role = 'user'
        AND transcript_messages.seq <> turns.opening_seq
        AND json_extract(transcript_messages.message_json, '$.source') IS NULL
      ORDER BY transcript_messages.run_id ASC, transcript_messages.seq ASC
    `).all({ "$conversationId": conversationId });
    const result = new Map<string, RunSteeringMessageView[]>();
    for (const row of rows) {
      const runId = expectString(row.run_id, "run_id");
      const entry = result.get(runId) ?? [];
      entry.push(mapSteeringMessageRow(row));
      result.set(runId, entry);
    }
    return result;
  }

  appendRunMessages(
    conversationId: string,
    turnId: string,
    runId: string,
    messages: readonly TranscriptMessage[],
    outcome: AppendRunMessagesOutcome,
  ): void {
    const status = outcome.status;
    const finalAnswer = outcome.finalAnswer ?? null;
    const bytes = transcriptBytes(messages);
    if (bytes > MAX_SQLITE_RUN_TRANSCRIPT_BYTES) {
      throw new Error(
        `Run transcript exceeds ${MAX_SQLITE_RUN_TRANSCRIPT_BYTES} bytes.`,
      );
    }
    const validatedCompactions = validateRunContextCompactions(
      outcome.contextCompactions ?? [],
    );
    const validatedModelCalls = validateRunModelCalls(
      outcome.modelCalls ?? [],
    );

    immediateTransaction(this.database, () => {
      this.assertActiveRun(conversationId, turnId, runId);
      const now = new Date().toISOString();

      const nextSeqRow = this.database.prepare(`
        SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
        FROM transcript_messages
        WHERE conversation_id = $conversationId
      `).get({ "$conversationId": conversationId });
      let nextSeq = expectInteger(nextSeqRow?.next_seq, "next_seq");

      const insertMessage = this.database.prepare(`
        INSERT INTO transcript_messages (
          conversation_id,
          seq,
          run_id,
          role,
          message_json
        ) VALUES (
          $conversationId,
          $seq,
          $runId,
          $role,
          $messageJson
        )
      `);
      for (const message of messages) {
        insertMessage.run({
          "$conversationId": conversationId,
          "$seq": nextSeq,
          "$runId": runId,
          "$role": message.role,
          "$messageJson": serializeTranscriptMessage(message),
        });
        nextSeq += 1;
      }

      insertContextCompactions(
        this.database,
        conversationId,
        validatedCompactions,
      );
      insertRunModelCallSuffix(this.database, runId, validatedModelCalls);

      const updatedRun = this.database.prepare(`
        UPDATE runs
        SET
          status = $status,
          final_answer = $finalAnswer,
          message_count = $messageCount,
          transcript_bytes = $transcriptBytes,
          error_code = $errorCode,
          error_message = $errorMessage,
          internal_error = $internalError,
          updated_at = $now
        WHERE id = $runId
          AND turn_id = $turnId
          AND status = 'running'
      `).run({
        "$status": status,
        "$finalAnswer": finalAnswer,
        "$messageCount": messages.length,
        "$transcriptBytes": bytes,
        "$errorCode": outcome.errorCode ?? null,
        "$errorMessage": outcome.errorMessage ?? null,
        "$internalError": outcome.internalError ?? null,
        "$now": now,
        "$runId": runId,
        "$turnId": turnId,
      });
      const updatedTurn = this.database.prepare(`
        UPDATE turns
        SET status = $status, updated_at = $now
        WHERE id = $turnId
          AND conversation_id = $conversationId
          AND status = 'running'
      `).run({
        "$status": status,
        "$now": now,
        "$turnId": turnId,
        "$conversationId": conversationId,
      });
      const updatedConversation = this.database.prepare(`
        UPDATE conversations
        SET
          active_run_id = NULL,
          revision = revision + 1,
          updated_at = $now
        WHERE id = $conversationId
          AND active_run_id = $runId
      `).run({
        "$now": now,
        "$conversationId": conversationId,
        "$runId": runId,
      });
      if (
        updatedRun.changes !== 1 ||
        updatedTurn.changes !== 1 ||
        updatedConversation.changes !== 1
      ) {
        throw inactiveRunError(conversationId, runId);
      }
    });
  }

  recoverStaleRuns(): number {
    return immediateTransaction(this.database, () => {
      const conversationIds = this.database.prepare(`
        SELECT id
        FROM conversations
        WHERE active_run_id IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM turns
            WHERE turns.conversation_id = conversations.id
              AND turns.status = 'running'
          )
          OR EXISTS (
            SELECT 1
            FROM turns
            INNER JOIN runs ON runs.turn_id = turns.id
            WHERE turns.conversation_id = conversations.id
              AND runs.status = 'running'
          )
      `).all().map((row) => expectString(row.id, "id"));
      if (conversationIds.length === 0) return 0;

      const now = new Date().toISOString();
      const failRuns = this.database.prepare(`
        UPDATE runs
        SET
          status = 'failed',
          error_code = 'RUN_INTERRUPTED',
          error_message = 'Agent service stopped before the run completed.',
          message_count = 0,
          transcript_bytes = 0,
          updated_at = $now
        WHERE status = 'running'
          AND turn_id IN (
            SELECT id
            FROM turns
            WHERE conversation_id = $conversationId
          )
      `);
      const failTurns = this.database.prepare(`
        UPDATE turns
        SET status = 'failed', updated_at = $now
        WHERE conversation_id = $conversationId
          AND status = 'running'
      `);
      const recoverConversation = this.database.prepare(`
        UPDATE conversations
        SET
          active_run_id = NULL,
          revision = revision + 1,
          updated_at = $now
        WHERE id = $conversationId
      `);
      for (const conversationId of conversationIds) {
        const parameters = {
          "$now": now,
          "$conversationId": conversationId,
        };
        failRuns.run(parameters);
        failTurns.run(parameters);
        recoverConversation.run(parameters);
      }
      return conversationIds.length;
    });
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  getRunUsageTotals(runId: string): RunUsageTotals {
    return readRunUsageTotals(this.database, runId);
  }

  appendSubAgentRun(
    record: SubAgentRunRecord,
    usage: StoredRunUsage = {},
  ): void {
    this.#subAgentRuns.append(record, usage);
  }

  listSubAgentRuns(runId: string): readonly SubAgentRunView[] {
    return this.#subAgentRuns.listByParentRun(runId);
  }

  loadSubAgentTranscript(subAgentRunId: string): readonly TranscriptMessage[] {
    return this.#subAgentRuns.loadTranscript(subAgentRunId);
  }

  private getConversationRow(conversationId: string): ConversationRow {
    return readConversationRow(this.database, conversationId);
  }

  private assertActiveRun(
    conversationId: string,
    turnId: string,
    runId: string,
  ): void {
    const conversation = this.getConversationRow(conversationId);
    const run = readRunRow(this.database, runId);
    if (
      conversation.activeRunId !== runId ||
      run === undefined ||
      run.turnId !== turnId ||
      run.status !== "running"
    ) {
      throw inactiveRunError(conversationId, runId);
    }
    const turn = this.database.prepare(`
      SELECT status
      FROM turns
      WHERE id = $turnId
        AND conversation_id = $conversationId
    `).get({
      "$turnId": turnId,
      "$conversationId": conversationId,
    });
    if (turn?.status !== "running") {
      throw inactiveRunError(conversationId, runId);
    }
  }
}
