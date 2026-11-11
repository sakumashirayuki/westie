import {
  AgentEventType,
  type AgentEvent,
  type AgentEventFactory,
} from "../agent-events.js";
import {
  StopHookFailedError,
  StopHookLimitReachedError,
  type StopHook,
  type StopHookDecision,
} from "../stop-hook.js";
import { createStopHookRecord } from "../stop-hook-result.js";
import type { TranscriptMessage } from "../transcript.js";

/** 检查记录里保留的故障诊断上限。 */
const MAX_STOP_HOOK_DIAGNOSTIC_BYTES = 2 * 1024;

/** 一次候选回答的检查结论；主循环只读这个结果决定继续还是接受。 */
export type StopHookOutcome =
  | { readonly kind: "allowed" }
  | { readonly kind: "stale" }
  | {
      readonly kind: "rejected";
      /** 本 Run 到目前为止实际应用的拒绝次数（含这一次）。 */
      readonly applied: number;
    };

export interface StopHookSessionOptions {
  readonly hook: StopHook;
  readonly transcript: TranscriptMessage[];
  readonly step: number;
  readonly candidateAnswer: string;
  /** 本 Run 已实际应用的拒绝次数；作废的检查不计入。 */
  readonly appliedRejections: number;
  /** 与主循环共用同一个事件工厂，检查失败时由这里补发完成的工具事件。 */
  readonly eventFactory: AgentEventFactory;
  readonly signal?: AbortSignal;
}

/**
 * 一次完成检查的完整流程：执行检查、把检查事件转给调用方展示、把结论写进
 * canonical transcript、执行补做次数上限；检查本身失败时写故障记录、补发完成
 * 事件再抛出。
 *
 * 主循环只负责 `yield*` 转发事件并按返回值决定下一步：事件用于展示，检查的
 * 返回值与异常用于控制执行。`isStale` 在检查期间新输入到达时返回 true，此时
 * 结论记为未应用且不消耗补做次数。
 */
export async function* runStopHookCheck(
  options: StopHookSessionOptions,
  isStale: () => boolean,
): AsyncGenerator<AgentEvent, StopHookOutcome, void> {
  const { hook, transcript, step, eventFactory, signal } = options;
  // 检查自己是否已经发布过完成事件：发布过就不再补发，避免前端多一张失败卡片。
  let completed = false;
  try {
    const decision = yield* forwardCheckEvents(hook, {
      candidateAnswer: options.candidateAnswer,
      transcript: transcript.map((message) => ({ ...message })),
      step,
      continuations: options.appliedRejections,
      ...(signal === undefined ? {} : { signal }),
    }, (event) => {
      if (
        event.type === AgentEventType.ToolCompleted &&
        event.data.name === "stop_hook"
      ) {
        completed = true;
      }
    });
    // 用户取消优先于脚本输出；取消不写记录。
    signal?.throwIfAborted();

    if (isStale()) {
      transcript.push(
        createStopHookRecord(hook.command, step, describe(decision), false),
      );
      return { kind: "stale" };
    }

    transcript.push(
      createStopHookRecord(hook.command, step, describe(decision), true),
    );

    if (decision.decision === "allow") return { kind: "allowed" };

    const applied = options.appliedRejections + 1;
    if (applied > hook.maxContinuations) {
      throw new StopHookLimitReachedError(
        hook.maxContinuations,
        decision.reason,
      );
    }
    return { kind: "rejected", applied };
  } catch (error) {
    // 检查故障在这里变成记录并继续上抛，调用方只处理 Run 级别的失败。
    if (error instanceof StopHookFailedError) {
      transcript.push(
        createStopHookRecord(
          hook.command,
          step,
          { decision: "error", reason: diagnosis(error) },
          false,
        ),
      );
      // 检查已经发布过完成事件时不再补发，否则前端会多出一张失败卡片。
      if (!completed) {
        yield eventFactory.stopHookFailed(
          step,
          internalStopHookCallId(step, options.appliedRejections),
          error.code,
          error.message,
        );
      }
    }
    throw error;
  }
}

async function* forwardCheckEvents(
  hook: StopHook,
  request: Parameters<StopHook["check"]>[0],
  onEvent: (event: AgentEvent) => void,
): AsyncGenerator<AgentEvent, StopHookDecision, void> {
  const check = hook.check(request);
  for (;;) {
    const next = await check.next();
    if (next.done === true) return next.value;
    onEvent(next.value);
    yield next.value;
  }
}

/** 检查没发布过完成事件时补发所用的调用 ID；每次检查互不相同。 */
function internalStopHookCallId(step: number, appliedRejections: number): string {
  return `stop_hook:${step}:${appliedRejections + 1}`;
}

function describe(
  decision: StopHookDecision,
): { readonly decision: "allow" | "block"; readonly reason?: string } {
  return decision.decision === "block"
    ? { decision: "block", reason: decision.reason }
    : { decision: "allow" };
}

/** 故障诊断进入检查记录时只保留上限内的摘录。 */
function diagnosis(error: StopHookFailedError): string {
  const text = `${error.code}: ${error.message}`;
  if (Buffer.byteLength(text, "utf8") <= MAX_STOP_HOOK_DIAGNOSTIC_BYTES) {
    return text;
  }
  return `${Buffer.from(text, "utf8")
    .subarray(0, MAX_STOP_HOOK_DIAGNOSTIC_BYTES)
    .toString("utf8")}…`;
}
