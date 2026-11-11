import type { RunErrorData } from "./agent-events.js";
import {
  ProviderOutputError,
  ProviderTruncatedOutputError,
  ProviderUnavailableError,
} from "./provider-protocol.js";
import { ProtocolError } from "./protocol.js";
import {
  StopHookFailedError,
  StopHookLimitReachedError,
} from "./stop-hook.js";
import { StopHookConfigError } from "./infrastructure/workspace-stop-hook-config.js";
import {
  TranscriptValidationError,
  validateTranscriptBatches,
  type TranscriptMessage,
} from "./transcript.js";

export class MaxStepsExceededError extends Error {
  constructor(maxSteps: number) {
    super(`Agent did not produce a final answer within ${maxSteps} steps.`);
    this.name = "MaxStepsExceededError";
  }
}

export class ProviderTurnTooLargeError extends Error {
  constructor() {
    super("Model output exceeded the maximum provider turn size.");
    this.name = "ProviderTurnTooLargeError";
  }
}

export class ContextLimitExceededError extends Error {
  constructor(
    message = "The current agent request exceeds the model context limit.",
  ) {
    super(message);
    this.name = "ContextLimitExceededError";
  }
}

export class ContextCompactionFailedError extends Error {
  constructor(options?: ErrorOptions) {
    super("The agent could not compact its current context.", options);
    this.name = "ContextCompactionFailedError";
  }
}

export function publicRunError(error: unknown): RunErrorData {
  if (error instanceof TranscriptValidationError) {
    return {
      code: "INVALID_TRANSCRIPT",
      message: "会话记录不完整，无法继续。",
    };
  }
  if (error instanceof ProviderUnavailableError) {
    return {
      code: "MODEL_UNAVAILABLE",
      message:
        `Model service is temporarily unavailable (${error.reason}) after ${error.attempts} attempts.`,
    };
  }
  if (error instanceof ProviderTruncatedOutputError) {
    return {
      code: "OUTPUT_TRUNCATED",
      message:
        "Model output was cut off at the output token limit on every attempt.",
    };
  }
  if (error instanceof ProtocolError || error instanceof ProviderOutputError) {
    return {
      code: "INVALID_MODEL_OUTPUT",
      message: "Model returned an invalid response.",
    };
  }
  if (error instanceof MaxStepsExceededError) {
    return { code: "MAX_STEPS_EXCEEDED", message: error.message };
  }
  if (error instanceof ProviderTurnTooLargeError) {
    return {
      code: "MODEL_OUTPUT_TOO_LARGE",
      message: error.message,
    };
  }
  if (error instanceof ContextLimitExceededError) {
    return {
      code: "CONTEXT_LIMIT_EXCEEDED",
      message: error.message,
    };
  }
  if (error instanceof StopHookConfigError) {
    return {
      code: "STOP_HOOK_CONFIG_INVALID",
      message: error.message,
    };
  }
  if (error instanceof StopHookLimitReachedError) {
    return {
      code: "STOP_HOOK_LIMIT_REACHED",
      message: error.message,
    };
  }
  if (error instanceof StopHookFailedError) {
    return {
      code: "STOP_HOOK_FAILED",
      message: error.message,
    };
  }
  if (error instanceof ContextCompactionFailedError) {
    return {
      code: "CONTEXT_COMPACTION_FAILED",
      message: error.message,
    };
  }
  return { code: "AGENT_RUN_FAILED", message: "Agent run failed." };
}

export function formatInternalError(error: unknown): string {
  const detail = error instanceof Error
    ? error.stack ?? `${error.name}: ${error.message}`
    : String(error);
  const parts = [detail];
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause !== undefined) {
    const text = cause instanceof Error
      ? cause.stack ?? `${cause.name}: ${cause.message}`
      : String(cause);
    parts.push(`Caused by: ${text}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join("\n").slice(0, 64 * 1024);
}

/**
 * 把 transcript 写库前的兜底断言。正常完成或补齐过失败结果的 Run 都不应出现
 * 不成对的工具调用；一旦出现说明上面的补齐逻辑有遗漏。这里只诊断、不修复：
 * 照常写库（不能因此丢掉整个 Run 的记录），但要留一条可定位的诊断。
 */
export function assertTranscriptCompleteOnWrite(
  transcript: readonly TranscriptMessage[],
  runId: string | undefined,
): void {
  try {
    validateTranscriptBatches(transcript);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      event: "transcript.invalid_on_failure",
      ...(runId === undefined ? {} : { runId }),
      ...(error instanceof TranscriptValidationError
        ? { message: error.message }
        : { message: String(error) }),
    })}\n`);
  }
}
