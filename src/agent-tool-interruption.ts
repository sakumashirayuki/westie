import type { NativeToolCall } from "./provider-protocol.js";
import type { ToolResult } from "./protocol.js";

/**
 * 一个工具调用在批次被中断时所处的阶段。「running」表示已经发过 tool.started、
 * 工具可能已经产生副作用；「not_started」表示还在等审批/授权，或排在队列里
 * 尚未起飞。
 */
export type InterruptedPhase = "not_started" | "running";

/** 批次中断的原因：用户取消，或 Run 因内部异常结束。 */
export type InterruptionReason = "cancelled" | "failed";

const MESSAGES: Record<
  InterruptedPhase,
  Record<InterruptionReason, string>
> = {
  not_started: {
    cancelled: "Run 在执行这个工具之前被用户取消，工具没有执行。",
    failed: "Run 在执行这个工具之前出错结束，工具没有执行。",
  },
  running: {
    cancelled:
      "Run 在这个工具执行期间被用户取消，工具可能已经部分执行，结果未知。",
    failed:
      "Run 在这个工具执行期间出错结束，工具可能已经部分执行，结果未知。",
  },
};

/**
 * 为一条工具调用生成「被中断」的合成结果。结果是 status 为 error、code 为
 * TOOL_INTERRUPTED 的 ToolResult，message 按阶段与原因取四档措辞之一。
 * 「running」的措辞明确提醒模型可能有副作用，下一轮应先检查现状。
 */
export function interruptedToolResult(
  call: NativeToolCall,
  phase: InterruptedPhase,
  reason: InterruptionReason,
): ToolResult {
  return {
    type: "tool_result",
    tool: call.name,
    status: "error",
    error: {
      code: "TOOL_INTERRUPTED",
      message: MESSAGES[phase][reason],
    },
  };
}
