import type { AgentEvent } from "./agent-events.js";
import {
  executePreparedAgentToolCall,
  prepareAgentToolCall,
  type ExecuteAgentToolCallOptions,
  type ExecutedAgentToolCall,
  type PreparedAgentToolCall,
} from "./agent-tool-call.js";
import { interruptedToolResult } from "./agent-tool-interruption.js";
import type { NativeToolCall } from "./provider-protocol.js";
import {
  MAX_CONCURRENT_TOOL_EXECUTIONS,
  PARALLEL_TOOL_NAMES,
  type ToolResult,
} from "./protocol.js";
import { WAIT_AGENT_TOOL_NAME } from "./tools/sub-agents.js";

const PARALLEL_SAFE_TOOL_NAMES = new Set<string>(PARALLEL_TOOL_NAMES);

export interface ExecuteAgentToolBatchOptions
  extends Omit<ExecuteAgentToolCallOptions, "call"> {
  readonly calls: readonly NativeToolCall[];
}

export interface AgentToolBatchResult {
  readonly toolCallId: string;
  readonly result: ToolResult;
}

/**
 * 批次在全部调用完成前被中断或出错：不能只抛原始错误，否则同一批里已经完成的
 * 真实结果、在飞调用的结果会一起丢掉，落库的 transcript 里工具调用就没有对应
 * 结果。改成抛出带有 partial results 的错误，让 agent loop 先把这批结果补齐进
 * transcript 再抛出原始 cause。
 */
export class ToolBatchInterruptedError extends Error {
  /** 与 calls 一一对应、顺序一致：已完成的是真实结果，其余是合成结果。 */
  readonly results: readonly AgentToolBatchResult[];

  constructor(
    results: readonly AgentToolBatchResult[],
    cause: unknown,
  ) {
    super("Tool batch was interrupted before every call finished.", {
      cause,
    });
    this.name = "ToolBatchInterruptedError";
    this.results = results;
  }
}

export async function* executeAgentToolBatch(
  options: ExecuteAgentToolBatchOptions,
): AsyncGenerator<AgentEvent, readonly AgentToolBatchResult[], void> {
  const cancellation = new AbortController();
  const signal = options.signal === undefined
    ? cancellation.signal
    : AbortSignal.any([options.signal, cancellation.signal]);
  const callOptions = options.calls.map((call) => ({
    ...options,
    call,
    signal,
  }));
  // 每个调用最终是否真正起飞执行过（launch 过）：据此区分「执行中」与「未开始」。
  const launched = new Set<number>();
  const prepared: PreparedAgentToolCall[] = [];
  const results: Array<ToolResult | undefined> = Array(options.calls.length);

  try {
    for (const [index, perCallOptions] of callOptions.entries()) {
      const call = yield* prepareAgentToolCall(perCallOptions);
      prepared.push(call);
      if (call.type === "complete") {
        results[index] = call.result;
        yield options.eventFactory.toolCompleted(
          options.stepNumber,
          call.call.callId,
          call.result,
          call.durationMs,
        );
      }
    }

    // 等待工具独占一个批次：它挂起时会阻塞同批其他调用，因此混用或重复调用直接
    // 按无效输入拒绝；其他调用沿用现有规则继续执行。
    for (const rejection of rejectSharedWaitAgentCalls(options, results)) {
      yield rejection;
    }

    // 全是可并行工具时最多 MAX_CONCURRENT_TOOL_EXECUTIONS 个同时执行，否则逐个执行；
    // 两种情况只差并发度。
    const limit = options.calls.every((call) =>
      PARALLEL_SAFE_TOOL_NAMES.has(call.name)
    )
      ? MAX_CONCURRENT_TOOL_EXECUTIONS
      : 1;
    yield* executeReadyCalls(
      options,
      callOptions,
      prepared,
      results,
      signal,
      launched,
      limit,
    );
  } catch (error) {
    cancellation.abort(error);
    throw interruptedResults(
      options.calls,
      results,
      launched,
      options.signal?.aborted === true,
      error,
    );
  }

  return options.calls.map((call, index) => {
    const result = results[index];
    if (result === undefined) {
      throw new Error("Tool batch completed without a result for every call.");
    }
    return { toolCallId: call.callId, result };
  });
}

/**
 * 把中断那一刻的批次状态收敛成 ToolBatchInterruptedError：已经完成的调用保留
 * 真实结果，其余按是否起飞过补「执行中」或「未开始」的合成结果。取消（signal
 * 已 abort）记为 cancelled，否则记为 failed。
 */
function interruptedResults(
  calls: readonly NativeToolCall[],
  results: ReadonlyArray<ToolResult | undefined>,
  launched: ReadonlySet<number>,
  cancelled: boolean,
  cause: unknown,
): Error {
  const reason = cancelled ? "cancelled" : "failed";
  const partial = calls.map((call, index) => {
    const result = results[index];
    if (result !== undefined) {
      return { toolCallId: call.callId, result };
    }
    return {
      toolCallId: call.callId,
      result: interruptedToolResult(
        call,
        launched.has(index) ? "running" : "not_started",
        reason,
      ),
    };
  });
  return new ToolBatchInterruptedError(partial, cause);
}

function rejectSharedWaitAgentCalls(
  options: ExecuteAgentToolBatchOptions,
  results: Array<ToolResult | undefined>,
): AgentEvent[] {
  const waitIndexes = options.calls
    .map((call, index) => (call.name === WAIT_AGENT_TOOL_NAME ? index : -1))
    .filter((index) => index !== -1);
  if (waitIndexes.length === 0) return [];
  if (waitIndexes.length === 1 && options.calls.length === 1) return [];
  const message = [
    `${WAIT_AGENT_TOOL_NAME} must be called on its own, in a batch without ` +
      "any other tool call.",
    "It only returns when a sub agent reports back, the user sends a new " +
      "message, or no sub agent is running; other calls in the same batch " +
      "would be blocked while it waits.",
  ].join(" ");
  const rejections: AgentEvent[] = [];
  for (const index of waitIndexes) {
    const call = options.calls[index]!;
    results[index] = {
      type: "tool_result",
      tool: call.name,
      status: "error",
      error: { code: "INVALID_TOOL_INPUT", message },
    };
    rejections.push(
      options.eventFactory.toolCompleted(
        options.stepNumber,
        call.callId,
        results[index]!,
        0,
      ),
    );
  }
  return rejections;
}

/** 一个正在执行的调用：执行结束时的结果。 */
interface RunningCall {
  /** 工具执行完成时 resolve，带着它在批次里的下标；一个调用只 resolve 一次。 */
  readonly completion: Promise<CompletedExecution>;
}

interface CompletedExecution {
  readonly index: number;
  readonly executed: ExecutedAgentToolCall;
}

/**
 * 执行已通过授权的调用，同时在飞的最多 limit 个，超出的排队。
 */
async function* executeReadyCalls(
  options: ExecuteAgentToolBatchOptions,
  callOptions: readonly ExecuteAgentToolCallOptions[],
  prepared: readonly PreparedAgentToolCall[],
  results: Array<ToolResult | undefined>,
  signal: AbortSignal,
  launched: Set<number>,
  limit: number,
): AsyncGenerator<AgentEvent, void, void> {
  const queue = prepared
    .map((call, index) => ({ call, index }))
    .filter((entry) => entry.call.type === "ready" && results[entry.index] === undefined);
  const running = new Map<number, RunningCall>();
  let next = 0;

  try {
    while (next < queue.length || running.size > 0) {
      // 1. 补位：在飞的不足 limit 个且队列还有人，就让下一个起飞。
      while (running.size < limit && next < queue.length) {
        const { call, index } = queue[next]!;
        next += 1;
        if (call.type !== "ready") continue;
        signal.throwIfAborted();
        launched.add(index);
        yield options.eventFactory.toolStarted(
          options.stepNumber,
          call.call.callId,
          call.prepared.name,
          call.prepared.input,
        );
        running.set(index, launch(callOptions[index]!, call, index));
      }
      if (running.size === 0) break;

      // 2. 等任一调用结束。
      const wakeup = await Promise.race(
        [...running.values()].map((call) => call.completion),
      );
      signal.throwIfAborted();

      // 3. 处理刚结束的调用。
      running.delete(wakeup.index);
      results[wakeup.index] = wakeup.executed.result;
      yield completedEvent(options, wakeup.executed);
    }
  } catch (error) {
    // 取消或内部异常：等在飞的执行落地。落在取消窗口里、不理会 signal 仍正常返回
    // 的调用，其真实结果要保留进 results，让上层补出成对的 transcript；被 signal
    // 中断的调用 reject，拿不到结果，留给上层按 running 补合成结果。
    const settled = await Promise.allSettled(
      [...running.values()].map((call) => call.completion),
    );
    let callIndex = 0;
    for (const [index] of running) {
      const outcome = settled[callIndex]!;
      if (outcome.status === "fulfilled") {
        results[index] = outcome.value.executed.result;
      }
      callIndex += 1;
    }
    throw error;
  }
}

/** 起飞一个调用。 */
function launch(
  callOptions: ExecuteAgentToolCallOptions,
  call: Extract<PreparedAgentToolCall, { type: "ready" }>,
  index: number,
): RunningCall {
  const completion = executePreparedAgentToolCall(callOptions, call).then(
    (executed) => ({ index, executed }),
  );
  return { completion };
}

function completedEvent(
  options: ExecuteAgentToolBatchOptions,
  executed: ExecutedAgentToolCall,
): AgentEvent {
  return options.eventFactory.toolCompleted(
    options.stepNumber,
    executed.call.callId,
    executed.result,
    executed.durationMs,
  );
}
