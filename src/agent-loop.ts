import type { AgentRun } from "./agent-run.js";
import {
  AgentEventFactory,
  AgentEventType,
  type AgentEvent,
  type RunErrorData,
  type RunStartedData,
} from "./agent-events.js";
import {
  type LlmProvider,
  type ProviderUsage,
} from "./provider-protocol.js";
import { RunUsageLog } from "./run-usage.js";
import {
  executeAgentToolBatch,
  ToolBatchInterruptedError,
  type AgentToolBatchResult,
} from "./agent-tool-batch.js";
import { interruptedToolResult } from "./agent-tool-interruption.js";
import {
  AuthorizedToolExecutor,
  type ToolPermissionContext,
} from "./tool-permissions.js";
import {
  ToolRegistry,
  type Tool,
} from "./tools.js";
import type { TranscriptMessage } from "./transcript.js";
import type { StopHook } from "./stop-hook.js";
import { runStopHookCheck } from "./application/stop-hook-session.js";
import {
  assertValidToolCalls,
  runProviderAttempts,
} from "./agent-provider-turn.js";
import type { NativeToolCall } from "./provider-protocol.js";
import {
  assertTranscriptCompleteOnWrite,
  formatInternalError,
  MaxStepsExceededError,
  publicRunError,
} from "./agent-run-errors.js";
import type { RunStopReason } from "./agent-events.js";
import {
  applyReadySubAgentResults,
  closeSubAgents,
  needsBarrierToContinue,
  needsFinalBarrier,
  waitInsideStep,
  type SubAgentRunControl,
} from "./sub-agent-run-control.js";

export type { AgentEvent } from "./agent-events.js";
export type { TranscriptMessage } from "./transcript.js";
export type { LlmProvider, ProviderRequest } from "./provider-protocol.js";

export {
  ContextCompactionFailedError,
  ContextLimitExceededError,
  MaxStepsExceededError,
  ProviderTurnTooLargeError,
  assertTranscriptCompleteOnWrite,
  formatInternalError,
} from "./agent-run-errors.js";

const DEFAULT_MAX_STEPS = 512;

export interface AgentContextBuilder {
  buildContext(request: {
    readonly systemPrompt: string;
    readonly currentTranscript: readonly TranscriptMessage[];
    readonly tools: readonly Tool[];
    /** 用于把上下文预算估算值与该步的真实 usage 对账。 */
    readonly step?: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly transcript: readonly TranscriptMessage[] }>;
  /** 某一步的真实 usage，对应该步最近一次 buildContext 的请求，供实现校准估算。 */
  observeUsage?(report: {
    readonly step: number;
    readonly usage: ProviderUsage;
  }): void;
}

export interface SteeringMessage {
  readonly seq: number;
  readonly content: string;
}

export interface SteeringSource {
  take(step: number): Promise<readonly SteeringMessage[]>;
  /** 是否还有未取走的真实 steering；父循环的等待条件之一。 */
  hasPending?(): boolean;
  /** 订阅新的 steering；返回取消订阅函数。 */
  onEnqueued?(listener: () => void): () => void;
}

export type {
  SubAgentRunControl,
  SubAgentWaitReason,
  SubAgentEndReason,
  SubAgentResult,
} from "./sub-agent-run-control.js";

export interface AgentToolEnvironment {
  readonly tools: readonly Tool[];
  readonly executor: AuthorizedToolExecutor;
  readonly permissionContext: Omit<ToolPermissionContext, "runId">;
}

export interface AgentRunLifecycle {
  beforeCompleted?(result: CompletedAgentRun): void | Promise<void>;
  beforeFailed?(result: FailedAgentRun): void | Promise<void>;
}

export interface RunAgentOptions {
  readonly transcript: readonly TranscriptMessage[];
  readonly systemPrompt: string;
  readonly provider: LlmProvider;
  readonly contextBuilder: AgentContextBuilder;
  readonly toolEnvironment: AgentToolEnvironment;
  readonly run: AgentRun;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
  readonly subAgents?: SubAgentRunControl;
  readonly steeringSource?: SteeringSource;
  readonly lifecycle?: AgentRunLifecycle;
  /** 项目级完成检查；省略时最终回答沿用原有接受流程。 */
  readonly stopHook?: StopHook;
  /** 父 Run 启动事件里的项目记忆状态；子 Run 不设置。 */
  readonly runStartedData?: RunStartedData;
}

export interface CompletedAgentRun {
  readonly answer: string;
  /** 本次结束的原因：正常回答为 final，达到步数上限的交接为 step_limit。 */
  readonly stopReason: RunStopReason;
  readonly transcript: readonly TranscriptMessage[];
}

export interface FailedAgentRun {
  readonly cancelled: boolean;
  readonly error?: RunErrorData;
  readonly internalError: string;
  readonly transcript: readonly TranscriptMessage[];
}

interface AgentLoopOptions {
  readonly systemPrompt: string;
  readonly provider: LlmProvider;
  readonly registry: ToolRegistry;
  readonly maxSteps: number;
  readonly runId: string;
  readonly eventFactory: AgentEventFactory;
  readonly usageLog: RunUsageLog;
  readonly signal?: AbortSignal;
  readonly contextBuilder: AgentContextBuilder;
  readonly authorizedToolExecutor: AuthorizedToolExecutor;
  readonly toolPermissionContext: ToolPermissionContext;
  readonly runStartedData?: RunStartedData;
  readonly subAgents?: SubAgentRunControl;
  readonly beforeRunCompleted?: (
    result: CompletedAgentRun,
  ) => void | Promise<void>;
  readonly steeringSource?: SteeringSource;
  readonly stopHook?: StopHook;
}

export function runAgent(options: RunAgentOptions): Promise<string> {
  const run = prepareAgentRun(options);
  return consumeAgentEvents(run.events);
}

export function streamAgentRun(
  options: RunAgentOptions,
): AsyncIterable<AgentEvent> {
  const run = prepareAgentRun(options);
  return exposeRunErrors(
    run.events,
    run.eventFactory,
    run.usageLog,
    run.transcript,
    options.run.runId,
    options.signal,
    options.lifecycle?.beforeFailed,
    options.subAgents,
  );
}

function prepareAgentRun(options: RunAgentOptions): {
  readonly events: AsyncIterable<AgentEvent>;
  readonly eventFactory: AgentEventFactory;
  readonly usageLog: RunUsageLog;
  readonly transcript: TranscriptMessage[];
} {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new Error("maxSteps must be a positive integer.");
  }
  if (options.systemPrompt.trim() === "") {
    throw new Error("systemPrompt must not be empty.");
  }
  const { runId, eventFactory, usageLog } = options.run;
  const transcript = options.transcript.map((message) => structuredClone(message));
  const loopOptions: AgentLoopOptions = {
    systemPrompt: options.systemPrompt,
    provider: options.provider,
    contextBuilder: options.contextBuilder,
    registry: new ToolRegistry(options.toolEnvironment.tools),
    runStartedData: options.runStartedData,
    authorizedToolExecutor: options.toolEnvironment.executor,
    toolPermissionContext: { ...options.toolEnvironment.permissionContext, runId },
    maxSteps,
    runId,
    eventFactory,
    usageLog,
    signal: options.signal,
    beforeRunCompleted: options.lifecycle?.beforeCompleted,
    subAgents: options.subAgents,
    steeringSource: options.steeringSource,
    stopHook: options.stopHook,
  };
  return {
    eventFactory,
    usageLog,
    transcript,
    events: runEventLoop(transcript, loopOptions),
  };
}

async function consumeAgentEvents(
  events: AsyncIterable<AgentEvent>,
): Promise<string> {
  let answer: string | undefined;
  for await (const event of events) {
    if (event.type === AgentEventType.AnswerCompleted) {
      answer = event.data.answer;
    }
  }
  if (answer === undefined) {
    throw new Error("Agent run ended without a final answer.");
  }
  return answer;
}

async function* exposeRunErrors(
  events: AsyncIterable<AgentEvent>,
  eventFactory: AgentEventFactory,
  usageLog: RunUsageLog,
  transcript: readonly TranscriptMessage[],
  runId: string | undefined,
  signal: AbortSignal | undefined,
  beforeRunFailed:
    | ((result: FailedAgentRun) => void | Promise<void>)
    | undefined,
  subAgents?: SubAgentRunControl,
): AsyncIterable<AgentEvent> {
  try {
    for await (const event of events) {
      yield event;
    }
  } catch (error) {
    const cancelled = signal?.aborted === true;
    const publicError = cancelled ? undefined : publicRunError(error);
    // 父 Run 失败前先收尾：停止全部子任务并等它们结束，再写父终态。
    await closeSubAgents(
      subAgents,
      cancelled ? "parent_cancelled" : "parent_failed",
    );
    assertTranscriptCompleteOnWrite(transcript, runId);
    await beforeRunFailed?.({
      cancelled,
      ...(publicError === undefined ? {} : { error: publicError }),
      internalError: formatInternalError(error),
      transcript: transcript.map((message) => ({ ...message })),
    });
    if (cancelled) {
      throw signal.reason ?? error;
    }
    yield eventFactory.runError(publicError!, usageLog.totals);
  }
}

async function* runEventLoop(
  transcript: TranscriptMessage[],
  options: AgentLoopOptions,
): AsyncIterable<AgentEvent> {
  const { eventFactory, signal, subAgents } = options;
  signal?.throwIfAborted();
  yield eventFactory.runStarted(options.runStartedData);
  const reservesHandoffStep = options.maxSteps >= 2;
  // 本 Run 已实际应用的完成检查拒绝次数；作废的检查不计入。
  let appliedRejections = 0;

  for (
    let stepNumber = 1;
    stepNumber <= options.maxSteps;
    stepNumber += 1
  ) {
    signal?.throwIfAborted();
    // 父 Run 的基础设施故障（例如子记录保存失败）在安全边界让父任务失败。
    subAgents?.throwIfFailed();
    yield eventFactory.stepStarted(stepNumber);
    signal?.throwIfAborted();

    const forcesFinalAnswer = reservesHandoffStep &&
      stepNumber === options.maxSteps;
    if (forcesFinalAnswer) {
      await subAgents?.close("parent_step_limit");
      subAgents?.throwIfFailed();
    }
    applyReadySubAgentResults(transcript, subAgents);
    if (!forcesFinalAnswer) yield* applySteering(transcript, options, stepNumber);

    const { turn, usage, stagedText } = yield* runProviderAttempts(
      transcript,
      {
        ...options,
        stageAnswerDeltas: () =>
          options.stopHook !== undefined || needsFinalBarrier(subAgents),
      },
      stepNumber,
      forcesFinalAnswer,
    );

    if (turn.type === "final") {
      const deferred = yield* runFinalAnswerStep(
        transcript,
        options,
        stepNumber,
        turn.content,
        stagedText,
        usage,
        forcesFinalAnswer,
        appliedRejections,
      );
      appliedRejections = deferred.appliedRejections;
      if (deferred.done) return;
      continue;
    }

    if (forcesFinalAnswer) break;

    yield* runToolStep(
      transcript,
      options,
      stepNumber,
      turn.calls,
      usage,
      stagedText,
    );
  }

  // 最后一个禁用工具的交接步骤之前，先关闭入口并收齐或停止全部子任务。
  await closeSubAgents(subAgents, "parent_step_limit");
  throw new MaxStepsExceededError(options.maxSteps);
}

async function* applySteering(
  transcript: TranscriptMessage[],
  options: AgentLoopOptions,
  stepNumber: number,
): AsyncGenerator<AgentEvent, void, void> {
  const steering = await options.steeringSource?.take(stepNumber);
  options.signal?.throwIfAborted();
  if (steering === undefined) return;
  for (const message of steering) {
    transcript.push({ role: "user", content: message.content });
    yield options.eventFactory.steeringApplied(
      stepNumber,
      message.seq,
      message.content,
    );
    options.signal?.throwIfAborted();
  }
}

interface FinalAnswerStepOutcome {
  /** 本次 Run 已经结束（正常完成或失败），事件流不再继续。 */
  readonly done: boolean;
  /** 本 Run 已应用的完成检查拒绝次数。 */
  readonly appliedRejections: number;
}

async function* runFinalAnswerStep(
  transcript: TranscriptMessage[],
  options: AgentLoopOptions,
  stepNumber: number,
  content: string,
  stagedText: string,
  usage: ProviderUsage | undefined,
  forcesFinalAnswer: boolean,
  appliedRejections: number,
): AsyncGenerator<AgentEvent, FinalAnswerStepOutcome, void> {
  const { eventFactory, signal, stopHook } = options;
  // 结束屏障：模型过早输出 final 时，仍有活跃子任务、未交付结果或新 steering
  // 就先弃掉这个候选 final，等下一轮再回答。
  const barrier = needsBarrierToContinue(options);
  if (barrier !== undefined) {
    if (barrier.reason !== "candidates") {
      yield eventFactory.stepCompleted(stepNumber, "waiting", usage);
      signal?.throwIfAborted();
      yield* waitInsideStep(options, stepNumber);
      return { done: false, appliedRejections };
    }
    yield eventFactory.stepCompleted(stepNumber, "waiting", usage);
    signal?.throwIfAborted();
    return { done: false, appliedRejections };
  }

  // 达到步数上限的交接步直接沿用原收尾路径，不经过完成检查：它表达的是
  // 「步数已用尽」，不属于任务完成的候选回答。
  if (stopHook !== undefined && !forcesFinalAnswer) {
    // 执行完成检查。事件由调用方原样转发；失败由检查模块记录后以
    // STOP_HOOK_FAILED 抛出，走原有的失败落库路径。
    const checked = yield* runStopHookCheck(
      {
        hook: stopHook,
        transcript,
        step: stepNumber,
        candidateAnswer: content,
        appliedRejections,
        eventFactory,
        ...(signal === undefined ? {} : { signal }),
      },
      // 检查期间到达的新输入或子任务结果让候选回答过期。这里直接看 steering
      // 队列和子任务状态：没注册 steering 订阅时 needsBarrierToContinue 不检查。
      () => {
        options.subAgents?.throwIfFailed();
        return options.steeringSource?.hasPending?.() === true ||
          options.subAgents?.hasReady() === true ||
          options.subAgents?.hasActive() === true;
      },
    );
    // 复查取消和新输入之后，按检查结论继续或接受候选回答。
    signal?.throwIfAborted();
    if (checked.kind !== "allowed") {
      yield eventFactory.stepCompleted(stepNumber, "waiting", usage);
      signal?.throwIfAborted();
      return {
        done: false,
        appliedRejections: checked.kind === "rejected"
          ? checked.applied
          : appliedRejections,
      };
    }
  }

  yield* acceptFinalAnswer(
    transcript,
    options,
    stepNumber,
    content,
    stagedText,
    usage,
    forcesFinalAnswer,
  );
  return { done: true, appliedRejections };
}

async function* acceptFinalAnswer(
  transcript: TranscriptMessage[],
  options: AgentLoopOptions,
  stepNumber: number,
  content: string,
  stagedText: string,
  usage: ProviderUsage | undefined,
  forcesFinalAnswer: boolean,
): AsyncGenerator<AgentEvent, void, void> {
  const { eventFactory, signal } = options;
  await options.subAgents?.close("parent_failed");
  options.subAgents?.throwIfFailed();
  transcript.push({ role: "assistant", content });
  yield eventFactory.stepCompleted(stepNumber, "final", usage);
  signal?.throwIfAborted();
  if (stagedText !== "") {
    yield eventFactory.answerDelta(stepNumber, stagedText);
    signal?.throwIfAborted();
  }
  yield eventFactory.answerCompleted(stepNumber, content);
  signal?.throwIfAborted();
  assertTranscriptCompleteOnWrite(transcript, options.runId);
  const stopReason: RunStopReason = forcesFinalAnswer ? "step_limit" : "final";
  await options.beforeRunCompleted?.({
    answer: content,
    stopReason,
    transcript: transcript.map((message) => ({ ...message })),
  });
  signal?.throwIfAborted();
  yield eventFactory.runCompleted(
    stepNumber,
    stopReason,
    options.usageLog.totals,
  );
}

async function* runToolStep(
  transcript: TranscriptMessage[],
  options: AgentLoopOptions,
  stepNumber: number,
  calls: readonly NativeToolCall[],
  usage: ProviderUsage | undefined,
  stagedText: string,
): AsyncGenerator<AgentEvent, void, void> {
  const { eventFactory, signal } = options;
  assertValidToolCalls(calls);
  if (stagedText !== "") {
    // 只发布暂存的正文；完整的 final 由模型的工具调用结果决定。
    yield eventFactory.answerDelta(stepNumber, stagedText);
    signal?.throwIfAborted();
  }
  transcript.push({
    role: "assistant",
    content: null,
    toolCalls: [...calls],
  });
  let results: readonly AgentToolBatchResult[];
  try {
    yield eventFactory.stepCompleted(stepNumber, "tool", usage);
    signal?.throwIfAborted();
    results = yield* executeAgentToolBatch({
      calls,
      stepNumber,
      registry: options.registry,
      eventFactory,
      ...(signal === undefined ? {} : { signal }),
      authorizedToolExecutor: options.authorizedToolExecutor,
      toolPermissionContext: options.toolPermissionContext,
    });
  } catch (error) {
    transcript.push({
      role: "tool",
      results: error instanceof ToolBatchInterruptedError
        ? [...error.results]
        : calls.map((call) => ({
            toolCallId: call.callId,
            result: interruptedToolResult(
              call,
              "not_started",
              signal?.aborted === true ? "cancelled" : "failed",
            ),
          })),
    });
    throw error instanceof ToolBatchInterruptedError ? error.cause : error;
  }
  transcript.push({
    role: "tool",
    results: [...results],
  });
}
