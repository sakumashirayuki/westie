import type {
  AgentEvent,
  AgentEventFactory,
  RunErrorData,
  RunStopReason,
} from "./agent-events.js";
import type { SteeringSource } from "./agent-loop.js";
import { serializeSubAgentReport } from "./sub-agent-report.js";
import type { TranscriptMessage } from "./transcript.js";

/**
 * 父循环使用的子任务协作接口，由协调器实现。
 */
export interface SubAgentRunControl {
  /** 取走已经结束并保存成功的子任务报告；每个终态只交付一次。 */
  takeReady(): readonly SubAgentResult[];
  hasActive(): boolean;
  hasReady(): boolean;
  throwIfFailed(): void;
  waitForReadyOrSteering(
    subscribeSteering: (listener: () => void) => () => void,
    signal?: AbortSignal,
  ): Promise<SubAgentWaitReason>;
  close(reason: SubAgentEndReason): Promise<void>;
  release(): void;
}

export type SubAgentWaitReason =
  | "child_result"
  | "steering"
  | "no_active_children";

/** 父 Run 收尾时通知子任务的原因。 */
export type SubAgentEndReason =
  | "parent_cancelled"
  | "parent_failed"
  | "parent_step_limit";

/** 交付给父模型的一条子任务结果；由协调器提供。 */
export interface SubAgentResult {
  readonly runId: string;
  readonly toolCallId: string;
  readonly description: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly stopReason?: RunStopReason;
  readonly answer?: string;
  readonly error?: RunErrorData;
}

interface SubAgentStepOptions {
  readonly subAgents?: SubAgentRunControl;
  readonly steeringSource?: Pick<SteeringSource, "hasPending" | "onEnqueued">;
  readonly signal?: AbortSignal;
  readonly eventFactory: AgentEventFactory;
}

/**
 * 把已经结束的子任务报告注入父上下文。报告是带来源的内部 user 消息，与真实用户
 * 追加的消息区分；每个终态只交付一次。
 */
export function applyReadySubAgentResults(
  transcript: TranscriptMessage[],
  subAgents: SubAgentRunControl | undefined,
): void {
  const ready = subAgents?.takeReady() ?? [];
  for (const result of ready) {
    transcript.push({
      role: "user",
      content: serializeSubAgentReport(result),
      source: "sub_agent",
      subAgentRunId: result.runId,
    });
  }
}

/** 只有存在子任务协作、且确实有未交付结果或活跃子任务时才需要暂存正文。 */
export function needsFinalBarrier(
  subAgents: SubAgentRunControl | undefined,
): boolean {
  return subAgents !== undefined && (subAgents.hasActive() || subAgents.hasReady());
}

/**
 * 真正的"等待子任务"：等待工具或 final 屏障实际挂起。唤醒后由父循环在下一步统一
 * 注入子结果与 steering。
 */
export async function* waitInsideStep(
  options: SubAgentStepOptions,
  stepNumber: number,
): AsyncGenerator<AgentEvent, void, void> {
  const subAgents = options.subAgents;
  if (subAgents === undefined) return;
  yield options.eventFactory.runWaiting(stepNumber);
  options.signal?.throwIfAborted();
  await subAgents.waitForReadyOrSteering(
    (listener) => options.steeringSource?.onEnqueued?.(listener) ?? (() => {}),
    options.signal,
  );
  options.signal?.throwIfAborted();
}

/**
 * final 屏障的条件检查。返回 undefined 表示可以正常结束；返回 `candidates` 表示
 * 已经有可交付的输入、丢弃这个候选 final 后下一步重答；其余情况需要在工具内部等待。
 */
export function needsBarrierToContinue(
  options: SubAgentStepOptions,
): { readonly reason: "candidates" | "wait" } | undefined {
  const subAgents = options.subAgents;
  if (subAgents === undefined) return undefined;
  subAgents.throwIfFailed();
  if (subAgents.hasReady()) return { reason: "candidates" };
  if (options.steeringSource?.hasPending?.()) return { reason: "candidates" };
  if (subAgents.hasActive()) return { reason: "wait" };
  return undefined;
}

export async function closeSubAgents(
  subAgents: SubAgentRunControl | undefined,
  reason: SubAgentEndReason,
): Promise<void> {
  if (subAgents === undefined) return;
  try {
    await subAgents.close(reason);
  } catch {
    // 保存失败已经记成父任务的基础设施故障；这里不再抛出，交给上层按失败收尾。
  }
}
