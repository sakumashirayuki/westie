import type { AgentEvent, AgentEventFactory } from "./agent-events.js";
import {
  ProviderOutputError,
  ProviderTruncatedOutputError,
  type LlmProvider,
  type NativeToolCall,
  type ProviderRequest,
  type ProviderTurn,
  type ProviderUsage,
} from "./provider-protocol.js";

import { ProtocolError } from "./protocol.js";
import type { RunUsageLog } from "./run-usage.js";
import type { TranscriptMessage } from "./transcript.js";
import type { AuthorizedToolExecutor, ToolPermissionContext } from "./tool-permissions.js";
import type { Tool } from "./tools.js";
import {
  ProviderTurnTooLargeError,
} from "./agent-run-errors.js";
import type { AgentContextBuilder } from "./agent-loop.js";

export const MAX_PROVIDER_TURN_BYTES = 256 * 1024;

// 一步之内因输出截断而重试的次数上限。截断不是非法响应，告知模型后原地重试。
export const MAX_TRUNCATED_OUTPUT_ATTEMPTS = 3;
export const TRUNCATED_OUTPUT_NOTICE = [
  "Your previous response was cut off at the output token limit and was discarded.",
  "Produce a smaller response for this step: write one file at a time,",
  "or do part of the work now and continue in the next step.",
].join(" ");

const STEP_LIMIT_HANDOFF_INSTRUCTIONS = [
  "The step budget for this run is exhausted, so tools are disabled for this final step.",
  "Reply with a handoff note for the next run: what you changed with exact paths,",
  "what you verified and its result, what remains unfinished, and the next concrete action.",
].join(" ");

export interface ProviderTurnOptions {
  readonly systemPrompt: string;
  readonly provider: LlmProvider;
  readonly registry: { readonly tools: readonly Tool[] };
  readonly runId: string;
  readonly eventFactory: AgentEventFactory;
  readonly usageLog: RunUsageLog;
  readonly signal?: AbortSignal;
  readonly contextBuilder: AgentContextBuilder;
  readonly authorizedToolExecutor: AuthorizedToolExecutor;
  readonly toolPermissionContext: ToolPermissionContext;
  /**
   * 本步有活跃子任务或未交付结果时为 true：正文 delta 先攒在内存里，等该步的结局
   * 明确后再一次性发布，避免暂存中的回答先被当成阶段性说明或最终答案。
   */
  readonly stageAnswerDeltas?: () => boolean;
}

/** 一次模型调用的流式结果；暂存状态由调用方读取，用来决定何时发布正文。 */
export interface ProviderTurnStream {
  readonly turn: ProviderTurn;
  readonly usage?: ProviderUsage;
  /** 本步攒下的正文；外部事件源被暂存时由调用方在结局明确后发布。 */
  readonly stagedText: string;
}

export async function* runProviderAttempts(
  transcript: TranscriptMessage[],
  options: ProviderTurnOptions,
  stepNumber: number,
  forcesFinalAnswer: boolean,
): AsyncGenerator<
  AgentEvent,
  ProviderTurnStream,
  void
> {
  for (let attempt = 1;; attempt += 1) {
    const request = await createProviderRequest(
      transcript,
      options,
      stepNumber,
      forcesFinalAnswer,
    );
    try {
      return yield* streamProviderTurn(request, stepNumber, options);
    } catch (error) {
      if (
        !(error instanceof ProviderTruncatedOutputError) ||
        attempt >= MAX_TRUNCATED_OUTPUT_ATTEMPTS
      ) {
        throw error;
      }
      transcript.push({ role: "user", content: TRUNCATED_OUTPUT_NOTICE });
      options.signal?.throwIfAborted();
    }
  }
}

export async function createProviderRequest(
  transcript: readonly TranscriptMessage[],
  options: ProviderTurnOptions,
  stepNumber: number,
  forcesFinalAnswer = false,
): Promise<ProviderRequest> {
  const visibleTools = options.authorizedToolExecutor.visibleTools(
    options.registry.tools,
    options.toolPermissionContext,
  );
  const providerTranscript = (await options.contextBuilder.buildContext({
    systemPrompt: options.systemPrompt,
    currentTranscript: transcript,
    tools: visibleTools,
    step: stepNumber,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })).transcript;
  return {
    systemPrompt: options.systemPrompt,
    transcript: forcesFinalAnswer
      ? [
          ...providerTranscript,
          { role: "user", content: STEP_LIMIT_HANDOFF_INSTRUCTIONS },
        ]
      : providerTranscript,
    tools: forcesFinalAnswer ? [] : visibleTools,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export async function* streamProviderTurn(
  request: ProviderRequest,
  stepNumber: number,
  options: ProviderTurnOptions,
): AsyncGenerator<AgentEvent, ProviderTurnStream, void> {
  let streamedBytes = 0;
  let stagedText = "";
  let completedTurn: ProviderTurn | undefined;
  let completedUsage: ProviderUsage | undefined;
  const stageDeltas = options.stageAnswerDeltas?.() === true;

  for await (const event of options.provider.stream(request)) {
    options.signal?.throwIfAborted();
    if (completedTurn !== undefined) {
      throw new ProtocolError("Provider emitted events after completion.");
    }
    if (event.type === "completed") {
      completedTurn = event.turn;
      completedUsage = event.usage;
      continue;
    }
    if (event.type === "retrying") {
      // 本次尝试到目前为止的 delta 全部作废，下一次尝试从头输出。
      streamedBytes = 0;
      stagedText = "";
      yield options.eventFactory.modelRetrying(
        stepNumber,
        event.attempt,
        event.maxAttempts,
        event.delayMs,
        event.reason,
      );
      options.signal?.throwIfAborted();
      continue;
    }
    if (event.text === "") continue;

    streamedBytes += Buffer.byteLength(event.text, "utf8");
    if (streamedBytes > MAX_PROVIDER_TURN_BYTES) {
      throw new ProviderTurnTooLargeError();
    }
    if (stageDeltas && event.type === "output_text.delta") {
      stagedText += event.text;
      if (Buffer.byteLength(stagedText, "utf8") > MAX_PROVIDER_TURN_BYTES) {
        throw new ProviderTurnTooLargeError();
      }
      continue;
    }
    if (event.type === "output_text.delta") {
      yield options.eventFactory.answerDelta(stepNumber, event.text);
    }
  }

  options.signal?.throwIfAborted();
  if (completedTurn === undefined) {
    throw new ProtocolError("Provider stream ended without a completed turn.");
  }
  return {
    ...recordAndFinish(completedTurn, completedUsage, stepNumber, options),
    stagedText,
  };
}

function recordAndFinish(
  completedTurn: ProviderTurn,
  completedUsage: ProviderUsage | undefined,
  stepNumber: number,
  options: ProviderTurnOptions,
): { turn: ProviderTurn; usage?: ProviderUsage } {
  // 先记账再校验：这次调用已经产生费用，即使 turn 因超限被拒也必须入账。
  options.usageLog.record({
    kind: "step",
    step: stepNumber,
    model: completedUsage?.model ?? options.provider.model,
    ...(completedUsage === undefined ? {} : { usage: completedUsage }),
  });
  if (completedUsage !== undefined) {
    options.contextBuilder.observeUsage?.({
      step: stepNumber,
      usage: completedUsage,
    });
  }
  assertTurnSize(completedTurn);
  return {
    turn: completedTurn,
    ...(completedUsage === undefined ? {} : { usage: completedUsage }),
  };
}

export function assertTurnSize(turn: ProviderTurn): void {
  const bytes = turn.type === "final"
    ? Buffer.byteLength(turn.content, "utf8")
    : turn.calls.reduce(
        (total, call) =>
          total + Buffer.byteLength(call.arguments, "utf8"),
        0,
      );
  if (bytes > MAX_PROVIDER_TURN_BYTES) {
    throw new ProviderTurnTooLargeError();
  }
}

export function assertValidToolCalls(
  calls: readonly NativeToolCall[],
): void {
  // 不设数量上限：结构约束在 assertTurnSize 的字节上限，资源约束在
  // MAX_CONCURRENT_TOOL_EXECUTIONS。
  if (calls.length < 1) {
    throw new ProviderOutputError("Provider returned an empty tool call batch.");
  }
  const callIds = new Set<string>();
  for (const call of calls) {
    if (
      call.callId.trim() === "" ||
      call.name.trim() === "" ||
      callIds.has(call.callId)
    ) {
      throw new ProviderOutputError("Provider returned invalid tool calls.");
    }
    callIds.add(call.callId);
  }
}
