// 子任务报告的序列化与交付大小限制。

import type { RunStopReason } from "./agent-events.js";
import type { SubAgentStatus } from "./sub-agent-runner.js";

/** 单条报告序列化后的字节上限，与普通工具输出同口径。 */
export const MAX_SUB_AGENT_REPORT_BYTES = 64 * 1024;

export interface SubAgentReport {
  readonly runId: string;
  readonly toolCallId: string;
  readonly description: string;
  readonly status: SubAgentStatus;
  readonly stopReason?: RunStopReason;
  readonly answer?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * 报告进入父上下文的 JSON 文本；超过上限时保留子任务已落库的完整答案，只向父
 * 模型交付一条带 child ID 的超限说明，父模型据此重新委派更聚焦的任务。
 */
export function serializeSubAgentReport(result: SubAgentReport): string {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_SUB_AGENT_REPORT_BYTES) {
    return serialized;
  }
  return JSON.stringify({
    runId: result.runId,
    toolCallId: result.toolCallId,
    description: result.description,
    status: result.status,
    ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
    error: {
      code: "TOOL_OUTPUT_TOO_LARGE",
      message:
        "The sub agent report exceeded the delivery limit; its full answer is " +
        "stored with the sub agent run. Delegate a more focused task instead of " +
        "treating this notice as the report.",
    },
  } satisfies SubAgentReport);
}
