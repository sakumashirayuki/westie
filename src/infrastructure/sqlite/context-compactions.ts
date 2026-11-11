// conversation_context_compactions 表：Run 结束时随 transcript 一起落库的压缩摘要。

import type { DatabaseSync } from "node:sqlite";

import {
  MAX_CONTEXT_SUMMARY_BYTES,
  type RunContextCompaction,
} from "../../application/conversation-store.js";
import { expectInteger, expectString } from "./rows.js";

export function validateRunContextCompactions(
  compactions: readonly RunContextCompaction[],
): readonly RunContextCompaction[] {
  let previousCoverage = -1;
  return compactions.map((compaction, index) => {
    if (compaction.position !== index) {
      throw new Error(
        "Context compaction positions must be contiguous from zero.",
      );
    }
    if (
      !Number.isSafeInteger(compaction.coveredThroughSeq) ||
      compaction.coveredThroughSeq <= previousCoverage
    ) {
      throw new Error(
        "Context compaction coverage must strictly increase within the transcript.",
      );
    }
    if (
      compaction.summary.trim() === "" ||
      Buffer.byteLength(compaction.summary, "utf8") > MAX_CONTEXT_SUMMARY_BYTES
    ) {
      throw new Error(
        "Context compaction summary must be non-empty and within the absolute byte bound.",
      );
    }
    if (compaction.createdAt.trim() === "") {
      throw new Error("Context compaction createdAt must not be empty.");
    }
    previousCoverage = compaction.coveredThroughSeq;
    return { ...compaction };
  });
}

export function insertContextCompactions(
  database: DatabaseSync,
  conversationId: string,
  compactions: readonly RunContextCompaction[],
): void {
  const insert = database.prepare(`
    INSERT INTO conversation_context_compactions (
      conversation_id,
      position,
      covered_through_seq,
      summary_text,
      created_at
    ) VALUES (
      $conversationId,
      $position,
      $coveredThroughSeq,
      $summaryText,
      $createdAt
    )
  `);
  for (const compaction of compactions) {
    insert.run({
      "$conversationId": conversationId,
      "$position": compaction.position,
      "$coveredThroughSeq": compaction.coveredThroughSeq,
      "$summaryText": compaction.summary,
      "$createdAt": compaction.createdAt,
    });
  }
}

export function readConversationCompactions(
  database: DatabaseSync,
  conversationId: string,
): readonly RunContextCompaction[] {
  return database.prepare(`
    SELECT position, covered_through_seq, summary_text, created_at
    FROM conversation_context_compactions
    WHERE conversation_id = $conversationId
    ORDER BY position ASC
  `).all({ "$conversationId": conversationId }).map((row) => ({
    position: expectInteger(row.position, "position"),
    coveredThroughSeq: expectInteger(
      row.covered_through_seq,
      "covered_through_seq",
    ),
    summary: expectString(row.summary_text, "summary_text"),
    createdAt: expectString(row.created_at, "created_at"),
  }));
}
