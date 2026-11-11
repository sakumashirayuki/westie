// beginRun 的两个分支：新开一个 Turn，或为重试重开上一个 Turn。两者都在调用方的
// 事务里执行，只写 turns 表，runs 行由调用方在之后插入。

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { ConversationStateError } from "../../domain/conversation.js";
import { expectInteger, expectString } from "./rows.js";

export interface OpenedTurn {
  readonly turnId: string;
  /** 开场 user 消息在 transcript_messages 里的 seq。 */
  readonly openingSeq: number;
}

/** 第一次尝试：分配下一个 position 与 seq，插入 running 状态的 Turn。 */
export function openNewTurn(
  database: DatabaseSync,
  conversationId: string,
  input: string,
  now: string,
): OpenedTurn {
  const positionRow = database.prepare(`
    SELECT COALESCE(MAX(position), -1) + 1 AS next_position
    FROM turns
    WHERE conversation_id = $conversationId
  `).get({ "$conversationId": conversationId });
  const position = expectInteger(positionRow?.next_position, "next_position");
  const openingSeqRow = database.prepare(`
    SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
    FROM transcript_messages
    WHERE conversation_id = $conversationId
  `).get({ "$conversationId": conversationId });
  const openingSeq = expectInteger(openingSeqRow?.next_seq, "next_seq");

  const turnId = randomUUID();
  database.prepare(`
    INSERT INTO turns (
      id,
      conversation_id,
      position,
      user_message,
      opening_seq,
      status,
      created_at,
      updated_at
    ) VALUES (
      $id,
      $conversationId,
      $position,
      $input,
      $openingSeq,
      'running',
      $now,
      $now
    )
  `).run({
    "$id": turnId,
    "$conversationId": conversationId,
    "$position": position,
    "$input": input,
    "$openingSeq": openingSeq,
    "$now": now,
  });
  return { turnId, openingSeq };
}

/**
 * attempt >= 2：沿用最近一个 Turn 与它的开场消息，校验 attempt 恰好接在已有
 * 尝试之后，并把 Turn 置回 running。返回 Turn id。
 */
export function reopenTurnForRetry(
  database: DatabaseSync,
  conversationId: string,
  attempt: number,
  now: string,
): string {
  const turn = database.prepare(`
    SELECT
      id,
      status
    FROM turns
    WHERE conversation_id = $conversationId
    ORDER BY position DESC
    LIMIT 1
  `).get({ "$conversationId": conversationId });
  if (turn === undefined) {
    throw new ConversationStateError(
      `Conversation ${conversationId} has no turn to retry.`,
    );
  }
  if (turn.status === "completed") {
    throw new ConversationStateError(`Cannot retry a completed turn.`);
  }
  const attemptRow = database.prepare(`
    SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
    FROM runs
    WHERE turn_id = $turnId
  `).get({ "$turnId": turn.id });
  const nextAttempt = expectInteger(attemptRow?.next_attempt, "next_attempt");
  if (attempt !== nextAttempt) {
    throw new ConversationStateError(
      `Attempt ${attempt} does not continue the turn's attempts.`,
    );
  }
  const turnId = expectString(turn.id, "id");
  // 重试重开这个 Turn：上一次尝试把它置成了 failed 或 cancelled，
  // 而 assertActiveRun 要求 Turn 处于 running 才接受后续写入。
  database.prepare(`
    UPDATE turns
    SET status = 'running', updated_at = $now
    WHERE id = $turnId
      AND conversation_id = $conversationId
  `).run({
    "$now": now,
    "$turnId": turnId,
    "$conversationId": conversationId,
  });
  return turnId;
}

export function inactiveRunError(
  conversationId: string,
  runId: string,
): ConversationStateError {
  return new ConversationStateError(
    `Run ${runId} is not the active run for conversation ${conversationId}.`,
  );
}
