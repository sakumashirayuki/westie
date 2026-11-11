// 合并父子事件来源，保留各 Run 的原始事件身份。父终态在子任务收尾后输出。

import {
  AgentEventType,
  type AgentEvent,
  type AgentEventFactory,
} from "./agent-events.js";
import type { RunEventSource } from "./run-stream.js";
import type {
  DisplayEvent,
  SubAgentCoordinator,
} from "./sub-agent-coordinator.js";

export interface MergeAgentEventsOptions {
  readonly parentEvents: AsyncIterable<AgentEvent>;
  readonly coordinator: SubAgentCoordinator;
  /** 与父循环共享，用于父任务等待和停止子任务的控制事件。 */
  readonly eventFactory: AgentEventFactory;
}

/**
 * 持续拉取两条来源，父终态保留到子事件源排空之后再输出。父迭代器抛错或提前结束时
 * 同样会关闭子任务并回收所有 producer。
 */
export async function* mergeAgentEvents(
  options: MergeAgentEventsOptions,
): AsyncGenerator<RunEventSource, void, void> {
  const queue: RunEventSource[] = [];
  const toolSteps = new Map<string, number>();
  let wake: (() => void) | undefined;
  let closed = false;
  let terminal: AgentEvent | undefined;
  let drained = false;
  let failure: unknown;

  const notify = (): void => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const removeSink = options.coordinator.addEventSink((event) => {
    const wrapped = wrapDisplayEvent(options, event, toolSteps);
    if (wrapped !== undefined) {
      queue.push(wrapped);
      notify();
    }
  });

  const pump = (async (): Promise<void> => {
    try {
      for await (const event of options.parentEvents) {
        if (event.type === AgentEventType.ToolStarted) {
          toolSteps.set(event.data.toolCallId, event.step);
        }
        if (
          event.type === AgentEventType.RunCompleted ||
          event.type === AgentEventType.RunError ||
          event.type === AgentEventType.RunCancelled
        ) {
          // 父终态最后输出：先让子事件源排空。
          terminal = event;
          break;
        }
        queue.push({ event });
        notify();
      }
    } catch (error) {
      failure = error;
    } finally {
      closed = true;
      notify();
    }
  })();

  try {
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await pump;
    // The parent terminal is held until the coordinator has persisted and
    // published every child terminal event.
    await options.coordinator.close("parent_failed");
    while (queue.length > 0) yield queue.shift()!;
    drained = true;
    if (failure !== undefined) throw failure;
    if (terminal !== undefined) {
      yield { event: terminal };
    }
  } finally {
    removeSink();
    // 迭代器异常或被提前 return：同样回收所有 producer。
    if (!drained) {
      await options.coordinator.close("parent_failed").catch(() => {});
      await pump.catch(() => {});
    }
  }
}

function wrapDisplayEvent(
  options: MergeAgentEventsOptions,
  event: DisplayEvent,
  toolSteps: ReadonlyMap<string, number>,
): RunEventSource | undefined {
  if (event.kind === "child_started") return undefined;
  const toolCallId = event.kind === "parent_waiting"
    ? event.toolCallId
    : event.child.toolCallId;
  const step = toolSteps.get(toolCallId);
  if (step === undefined) throw new Error(`Missing parent tool call: ${toolCallId}`);
  if (event.kind === "parent_waiting") {
    return { event: options.eventFactory.runWaiting(step) };
  }
  if (event.kind === "child_event") {
    return { event: event.event, subAgent: { toolCallId: event.child.toolCallId, parentStep: step } };
  }
  if (event.kind === "child_stopping") {
    return { event: options.eventFactory.subAgentStopping(
      step,
      event.child.runId,
      event.child.toolCallId,
      event.reason,
    ) };
  }
  return undefined;
}
