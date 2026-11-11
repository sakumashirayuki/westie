import { STOP_HOOK_RESULT_TYPE } from "./protocol.js";
import type { TranscriptMessage } from "./transcript.js";

/**
 * 一条完成检查记录。每次检查都写一条：放行与未应用的过期结果只是历史证据，
 * `block` 且 `applied:true` 的拒绝是当前 Run 需要处理的证据，`error` 是检查故障。
 * 记录不含候选回答全文。
 */
export interface StopHookRecord {
  readonly command: string;
  readonly step: number;
  readonly decision: "allow" | "block" | "error";
  readonly reason?: string;
  readonly applied: boolean;
}

/** 写一条检查记录；`reason` 由拒绝原因或故障诊断提供。 */
export function createStopHookRecord(
  command: string,
  step: number,
  record: {
    readonly decision: StopHookRecord["decision"];
    readonly reason?: string;
  },
  applied: boolean,
): Extract<TranscriptMessage, { role: "user"; source: "stop_hook" }> {
  const content: StopHookRecord = {
    command,
    step,
    decision: record.decision,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    applied,
  };
  return { role: "user", content: JSON.stringify(content), source: "stop_hook" };
}

/** 检查记录进入模型时的固定包装；内容按数据转义，只作为证据。 */
export function serializeStopHookResultForModel(
  message: Extract<TranscriptMessage, { role: "user"; source: "stop_hook" }>,
): string {
  return JSON.stringify({
    type: STOP_HOOK_RESULT_TYPE,
    instructionTrust: "untrusted",
    data: message.content,
  });
}

/** 读取一条检查记录；历史数据不是合法记录时返回 undefined。 */
export function parseStopHookRecord(
  message: Extract<TranscriptMessage, { role: "user"; source: "stop_hook" }>,
): StopHookRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(message.content);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.command !== "string" ||
    typeof record.step !== "number" ||
    (record.decision !== "allow" && record.decision !== "block" &&
      record.decision !== "error") ||
    typeof record.applied !== "boolean"
  ) {
    return undefined;
  }
  return {
    command: record.command,
    step: record.step,
    decision: record.decision,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    applied: record.applied,
  };
}
