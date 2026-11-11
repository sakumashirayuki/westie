// run_model_calls 表：每次模型调用一行，用量汇总全部从这里聚合。

import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { validateProviderUsage } from "../../provider-protocol.js";
import type { RunModelCall, RunUsageTotals } from "../../run-usage.js";
import {
  expectInteger,
  expectNullableInteger,
  expectNullableString,
  expectString,
  type SQLiteRow,
} from "./rows.js";

const USAGE_TOTALS_COLUMNS = `
  COUNT(*) AS calls,
  COALESCE(
    SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END),
    0
  ) AS unmeasured_calls,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
`;

export function validateRunModelCalls(
  calls: readonly RunModelCall[],
): readonly RunModelCall[] {
  return calls.map((call, index) => {
    if (call.seq !== index) {
      throw new Error("Model call seq must be contiguous from zero.");
    }
    if (call.kind === "step") {
      if (
        call.step === undefined ||
        !Number.isSafeInteger(call.step) ||
        call.step < 1
      ) {
        throw new Error("A step model call must include a step number.");
      }
    } else if (call.step !== undefined) {
      throw new Error("A non-step model call must not include a step.");
    }
    if ((call.kind === "sub_agent") !== (call.subAgentRunId !== undefined)) {
      throw new Error(
        "A sub_agent model call must include the sub agent run id, and only it may.",
      );
    }
    if (call.model.trim() === "") {
      throw new Error("A model call must include a non-empty model name.");
    }
    if (
      call.usage !== undefined &&
      validateProviderUsage(call.usage) === undefined
    ) {
      throw new Error(
        "Model call usage must carry non-negative token counts within " +
          "their input and output totals.",
      );
    }
    if (call.createdAt.trim() === "") {
      throw new Error("A model call must include a non-empty createdAt.");
    }
    return { ...call };
  });
}

export function insertRunModelCalls(
  database: DatabaseSync,
  runId: string,
  calls: readonly RunModelCall[],
): void {
  const insert = prepareInsertRunModelCall(database);
  for (const call of calls) {
    insert.run(modelCallParameters(runId, call));
  }
}

/**
 * calls 是父 Run 截至当前的完整模型调用记录；校验已保存的部分，再补存新增的部分。
 * 例如传入序号 [0, 1, 2, 3, 4]，数据库已有 [0, 1, 2]，本次只插入 [3, 4]。
 * 这里“前缀”指开头已经保存的记录，“后缀（suffix）”指末尾尚未保存的记录。
 * 已保存记录必须从 0 连续编号，并与 calls 中对应记录逐字段一致；缺失或内容不一致时
 * 直接报错，避免跳过冲突后继续写入。
 */
export function insertRunModelCallSuffix(
  database: DatabaseSync,
  runId: string,
  calls: readonly RunModelCall[],
): void {
  const highest = readHighestRunModelCallSeq(database, runId);
  if (highest !== undefined) {
    const stored = readRunModelCallRange(database, runId);
    for (const [seq, row] of stored) {
      const snapshot = calls[seq];
      if (snapshot === undefined) {
        throw new Error(
          `Stored model call ${seq} of run ${runId} is missing from the log snapshot.`,
        );
      }
      if (!sameModelCall(row, snapshot)) {
        throw new Error(
          `Stored model call ${seq} of run ${runId} does not match the log snapshot.`,
        );
      }
    }
  }
  const insert = prepareInsertRunModelCall(database);
  for (const call of calls.slice((highest ?? -1) + 1)) {
    insert.run(modelCallParameters(runId, call));
  }
}

/** 直接读取单行的全部字段；只用于前缀一致性比对，不经过业务映射。 */
function readRunModelCallRange(
  database: DatabaseSync,
  runId: string,
): ReadonlyMap<number, SQLiteRow> {
  const rows = database.prepare(`
    SELECT * FROM run_model_calls
    WHERE run_id = $runId
    ORDER BY seq ASC
  `).all({ "$runId": runId });
  return new Map(
    rows.map((row) => [expectInteger(row.seq, "seq"), row]),
  );
}

function sameModelCall(row: SQLiteRow, call: RunModelCall): boolean {
  return expectInteger(row.seq, "seq") === call.seq &&
    expectString(row.kind, "kind") === call.kind &&
    expectNullableInteger(row.step, "step") === (call.step ?? null) &&
    expectNullableString(row.sub_agent_run_id, "sub_agent_run_id") ===
      (call.subAgentRunId ?? null) &&
    expectString(row.model, "model") === call.model &&
    expectNullableInteger(row.input_tokens, "input_tokens") ===
      (call.usage?.inputTokens ?? null) &&
    expectNullableInteger(row.cached_input_tokens, "cached_input_tokens") ===
      (call.usage?.cachedInputTokens ?? null) &&
    expectNullableInteger(row.output_tokens, "output_tokens") ===
      (call.usage?.outputTokens ?? null) &&
    expectNullableInteger(row.reasoning_tokens, "reasoning_tokens") ===
      (call.usage?.reasoningTokens ?? null) &&
    expectString(row.created_at, "created_at") === call.createdAt;
}

function readHighestRunModelCallSeq(
  database: DatabaseSync,
  runId: string,
): number | undefined {
  const row = database.prepare(`
    SELECT MAX(seq) AS seq FROM run_model_calls WHERE run_id = $runId
  `).get({ "$runId": runId });
  if (row === undefined || row.seq === null) return undefined;
  const seq = expectInteger(row.seq, "seq");
  if (seq !== readRunModelCallCount(database, runId) - 1) {
    throw new Error(`Stored model call seq of run ${runId} is not contiguous.`);
  }
  return seq;
}

function readRunModelCallCount(
  database: DatabaseSync,
  runId: string,
): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS n FROM run_model_calls WHERE run_id = $runId
  `).get({ "$runId": runId });
  return expectInteger(row?.n, "n");
}

function prepareInsertRunModelCall(database: DatabaseSync) {
  return database.prepare(`
    INSERT INTO run_model_calls (
      run_id,
      seq,
      kind,
      step,
      sub_agent_run_id,
      model,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      reasoning_tokens,
      created_at
    ) VALUES (
      $runId,
      $seq,
      $kind,
      $step,
      $subAgentRunId,
      $model,
      $inputTokens,
      $cachedInputTokens,
      $outputTokens,
      $reasoningTokens,
      $createdAt
    )
  `);
}

function modelCallParameters(
  runId: string,
  call: RunModelCall,
): Record<string, SQLOutputValue> {
  return {
    "$runId": runId,
    "$seq": call.seq,
    "$kind": call.kind,
    "$step": call.step ?? null,
    "$subAgentRunId": call.subAgentRunId ?? null,
    "$model": call.model,
    "$inputTokens": call.usage?.inputTokens ?? null,
    "$cachedInputTokens": call.usage?.cachedInputTokens ?? null,
    "$outputTokens": call.usage?.outputTokens ?? null,
    "$reasoningTokens": call.usage?.reasoningTokens ?? null,
    "$createdAt": call.createdAt,
  };
}

/** 单个 Run 的用量；没有任何调用时各项为 0。 */
export function readRunUsageTotals(
  database: DatabaseSync,
  runId: string,
): RunUsageTotals {
  const row = database.prepare(`
    SELECT ${USAGE_TOTALS_COLUMNS}
    FROM run_model_calls
    WHERE run_id = $runId
  `).get({ "$runId": runId });
  return mapUsageTotalsRow(row ?? {});
}

/** 一个 Conversation 内按 Run 分组的用量。 */
export function aggregateRunUsageTotals(
  database: DatabaseSync,
  conversationId: string,
): Map<string, RunUsageTotals> {
  const rows = database.prepare(`
    SELECT
      run_model_calls.run_id AS run_id,
      ${USAGE_TOTALS_COLUMNS}
    FROM run_model_calls
    INNER JOIN runs ON runs.id = run_model_calls.run_id
    INNER JOIN turns ON turns.id = runs.turn_id
    WHERE turns.conversation_id = $conversationId
    GROUP BY run_model_calls.run_id
  `).all({ "$conversationId": conversationId });
  const result = new Map<string, RunUsageTotals>();
  for (const row of rows) {
    result.set(expectString(row.run_id, "run_id"), mapUsageTotalsRow(row));
  }
  return result;
}

/** 按子 Run 汇总父 Run 里以 sub_agent 记账的模型调用。 */
export function aggregateSubAgentUsageTotals(
  database: DatabaseSync,
  subAgentRunIds: readonly string[],
): Map<string, RunUsageTotals> {
  const result = new Map<string, RunUsageTotals>();
  if (subAgentRunIds.length === 0) return result;
  const placeholders = subAgentRunIds.map((_, index) => `$id${index}`);
  const parameters = Object.fromEntries(
    subAgentRunIds.map((id, index) => [`$id${index}`, id]),
  );
  const rows = database.prepare(`
    SELECT
      sub_agent_run_id,
      ${USAGE_TOTALS_COLUMNS}
    FROM run_model_calls
    WHERE sub_agent_run_id IN (${placeholders.join(", ")})
    GROUP BY sub_agent_run_id
  `).all(parameters);
  for (const row of rows) {
    result.set(
      expectString(row.sub_agent_run_id, "sub_agent_run_id"),
      mapUsageTotalsRow(row),
    );
  }
  return result;
}

function mapUsageTotalsRow(row: SQLiteRow): RunUsageTotals {
  return {
    calls: expectInteger(row.calls, "calls"),
    unmeasuredCalls: expectInteger(row.unmeasured_calls, "unmeasured_calls"),
    inputTokens: expectInteger(row.input_tokens, "input_tokens"),
    cachedInputTokens: expectInteger(
      row.cached_input_tokens,
      "cached_input_tokens",
    ),
    outputTokens: expectInteger(row.output_tokens, "output_tokens"),
    reasoningTokens: expectInteger(row.reasoning_tokens, "reasoning_tokens"),
  };
}
