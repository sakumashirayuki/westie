// 单个子 Run 的执行体：跑 `streamAgentRun()`，收集结束记录，并在保存成功之后再
// 对外发布终态。父循环只通过协调器与它交互，不直接认识它。

import { randomUUID } from "node:crypto";

import {
  AgentEventType,
  type AgentEvent,
  type RunErrorData,
  type RunStopReason,
} from "./agent-events.js";
import {
  streamAgentRun,
  type AgentContextBuilder,
} from "./agent-loop.js";
import { createAgentRun } from "./agent-run.js";
import { ContextBuilder } from "./application/context-builder.js";
import type { LlmProvider } from "./provider-protocol.js";
import {
  RunUsageLog,
  type RunModelCall,
  type RunUsageTotals,
} from "./run-usage.js";
import { SUB_AGENT_MAX_STEPS } from "./sub-agent-limits.js";
import type {
  AuthorizedToolExecutor,
  ToolPermissionContext,
} from "./tool-permissions.js";
import type { Tool } from "./tools.js";
import type { TranscriptMessage } from "./transcript.js";

export type SubAgentStatus = "completed" | "failed" | "cancelled";

/** 子 Run 结束时的完整记录；应用层用它写库，工具不直接碰数据库。 */
export interface SubAgentRunRecord {
  readonly runId: string;
  readonly toolCallId: string;
  readonly description: string;
  readonly status: SubAgentStatus;
  readonly stopReason?: RunStopReason;
  readonly finalAnswer?: string;
  readonly error?: RunErrorData;
  readonly internalError?: string;
  readonly systemPrompt: string;
  readonly transcript: readonly TranscriptMessage[];
  readonly createdAt: string;
}

/** 结束记录连同该时刻父 Run 的用量快照；快照用于把子用量补进父 Run。 */
export interface SubAgentFinish {
  readonly record: SubAgentRunRecord;
  readonly modelCalls: readonly RunModelCall[];
  readonly totals: RunUsageTotals;
}

export interface SubAgentRunnerOptions {
  readonly provider: LlmProvider;
  /** 子 Run 可见的工具集；不含 agent 自身，嵌套深度因此固定为 1。 */
  readonly tools: readonly Tool[];
  readonly systemPrompt: string;
  readonly toolCallId: string;
  readonly description: string;
  readonly task: string;
  readonly authorizedToolExecutor: AuthorizedToolExecutor;
  /** 与父 Run 相同的 workspaceRoot、executionMode、conversationId。 */
  readonly toolPermissionContext: Omit<ToolPermissionContext, "runId">;
  readonly createContextBuilder?: (
    runId: string,
    usageLog: RunUsageLog,
  ) => AgentContextBuilder;
  /** 父 Run 的记账；子 Run 的每次模型调用以 sub_agent 记入。 */
  readonly parentUsageLog: RunUsageLog;
  readonly signal: AbortSignal;
  /**
   * 发布子事件：过程事件立即发布，结束事件在保存成功后发布；保存失败时发布错误。
   */
  readonly onEvent: (event: AgentEvent) => void;
  /** 应用层保存子记录与用量；抛错代表基础设施故障。 */
  readonly persist: (finish: SubAgentFinish) => void;
}

/**
 * 子 Run 已经开始的执行体。事件流在构造后立即开始被消费，调用方拿到的
 * `finished` 在结束记录保存成功后 resolve。
 */
export class RunningSubAgent {
  readonly runId: string;
  readonly toolCallId: string;
  readonly description: string;
  readonly controller: AbortController;
  readonly finished: Promise<SubAgentRunRecord>;
  readonly #cancel: (reason: unknown) => void;
  #status: "running" | "stopping" = "running";
  #cancelReason: string | undefined;

  constructor(runId: string, executor: Executor) {
    this.runId = runId;
    this.toolCallId = executor.toolCallId;
    this.description = executor.description;
    this.controller = executor.controller;
    this.#cancel = executor.cancel;
    this.finished = executor.finished;
  }

  get status(): "running" | "stopping" {
    return this.#status;
  }

  get cancelReason(): string | undefined {
    return this.#cancelReason;
  }

  /** 接受停止请求：立即中止执行；实际结束前仍占用活跃名额。 */
  requestStop(reason: string, note?: string): void {
    if (this.#status === "stopping") return;
    this.#status = "stopping";
    this.#cancelReason = note ?? reason;
    this.#cancel(Object.assign(new Error(note ?? cancelMessage(reason)), { code: `SUB_AGENT_CANCELLED_${reason.toUpperCase()}` }));
  }
}

interface Executor {
  readonly toolCallId: string;
  readonly description: string;
  readonly controller: AbortController;
  readonly cancel: (reason: unknown) => void;
  readonly finished: Promise<SubAgentRunRecord>;
}

export function startSubAgent(options: SubAgentRunnerOptions): RunningSubAgent {
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const childRun = createAgentRun({ runId });
  const childUsage = childRun.usageLog;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const terminal: AgentEvent[] = [];
  let record: SubAgentRunRecord | undefined;
  let naturalStopReason: RunStopReason = "final";
  let lastSeq = 0;

  const events = streamAgentRun({
    transcript: [{ role: "user", content: options.task }],
    systemPrompt: options.systemPrompt,
    provider: options.provider,
    contextBuilder: options.createContextBuilder?.(runId, childUsage) ??
      new ContextBuilder({
        provider: options.provider,
        runId,
        usageLog: childUsage,
      }),
    maxSteps: SUB_AGENT_MAX_STEPS,
    run: childRun,
    toolEnvironment: {
      tools: options.tools,
      executor: options.authorizedToolExecutor,
      permissionContext: options.toolPermissionContext,
    },
    signal,
    lifecycle: {
      beforeCompleted: ({ answer, transcript, stopReason }) => {
        record = {
          runId,
          toolCallId: options.toolCallId,
          description: options.description,
          status: "completed",
          stopReason: stopReason ?? naturalStopReason,
          finalAnswer: answer,
          systemPrompt: options.systemPrompt,
          transcript,
          createdAt,
        };
      },
      beforeFailed: ({ cancelled, error, internalError, transcript }) => {
        record = {
          runId,
          toolCallId: options.toolCallId,
          description: options.description,
          status: cancelled ? "cancelled" : "failed",
          ...(error === undefined ? {} : { error }),
          internalError,
          systemPrompt: options.systemPrompt,
          transcript,
          createdAt,
        };
      },
    },
  });

  const finished = consume();
  return new RunningSubAgent(runId, {
    toolCallId: options.toolCallId,
    description: options.description,
    controller,
    cancel: (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    finished,
  });

  /**
   * 结束顺序固定：子模型与工具结束 → 收集记录与用量 → 父 Run 记账 → 保存 →
   * 发布子终态。终态事件在保存成功前只攒在 `terminal` 里。
   */
  async function consume(): Promise<SubAgentRunRecord> {
    try {
      for await (const event of events) {
        publish(event);
      }
    } catch (error) {
      if (record === undefined) {
        // 取消没有自然的 run.cancelled 事件，由 runner 补一条；父信号中止时
        // 错误原样抛回，同样在下面是补终态的依据。
        record = {
          runId,
          toolCallId: options.toolCallId,
          description: options.description,
          status: signal.aborted ? "cancelled" : "failed",
          systemPrompt: options.systemPrompt,
          transcript: [],
          createdAt,
          internalError: formatError(error),
        };
      }
    }
    const finishedRecord = record ?? {
      runId,
      toolCallId: options.toolCallId,
      description: options.description,
      status: "cancelled" as const,
      systemPrompt: options.systemPrompt,
      transcript: [],
      createdAt,
    };
    if (finishedRecord.status === "cancelled") {
      const reason = signal.reason;
      Object.assign(finishedRecord, { error: {
        code: reason instanceof Error && "code" in reason ? String(reason.code) : "SUB_AGENT_CANCELLED",
        message: reason instanceof Error ? reason.message : "子任务已停止。",
      } });
    }
    copyChildUsage(finishedRecord);
    const finish: SubAgentFinish = {
      record: finishedRecord,
      modelCalls: options.parentUsageLog.calls,
      totals: childUsage.totals,
    };
    try {
      options.persist(finish);
    } catch (error) {
      options.onEvent({
        v: 1, runId, seq: lastSeq + 1, type: AgentEventType.RunError,
        data: { code: "SUB_AGENT_SAVE_FAILED", message: "子任务结果保存失败。", usage: childUsage.totals },
      });
      throw error;
    }
    for (const event of terminal) options.onEvent(event);
    return finishedRecord;

    function publish(event: AgentEvent): void {
      lastSeq = event.seq;
      if (event.type === AgentEventType.AnswerCompleted) {
        terminal.push(event);
        return;
      }
      if (event.type === AgentEventType.RunCompleted) {
        naturalStopReason = event.data.stopReason;
        terminal.push(event);
        return;
      }
      if (
        event.type === AgentEventType.RunError ||
        event.type === AgentEventType.RunCancelled
      ) {
        terminal.push(event);
        return;
      }
      options.onEvent(event);
    }

    /** 子 Run 花掉的每一次模型调用都记在父 Run 上，指向这个子 Run。 */
    function copyChildUsage(finished: SubAgentRunRecord): void {
      for (const call of childUsage.calls) {
        options.parentUsageLog.record({
          kind: "sub_agent",
          subAgentRunId: runId,
          model: call.model,
          ...(call.usage === undefined ? {} : { usage: call.usage }),
        });
      }
      if (finished.status === "cancelled" && !terminal.some((event) => event.type === AgentEventType.RunCancelled)) {
        terminal.push({
          v: 1,
          runId,
          seq: lastSeq + 1,
          type: AgentEventType.RunCancelled,
          data: {
            usage: childUsage.totals,
            ...(finished.error === undefined
              ? {}
              : { error: { ...finished.error } }),
          },
        });
      }
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function cancelMessage(reason: string): string {
  switch (reason) {
    case "user_request": return "用户停止了子任务。";
    case "no_longer_needed": return "父任务不再需要此子任务。";
    case "parent_cancelled": return "父任务已停止。";
    case "parent_failed": return "父任务失败，子任务已停止。";
    case "parent_step_limit": return "父任务达到执行上限，子任务已停止。";
    default: return reason;
  }
}
