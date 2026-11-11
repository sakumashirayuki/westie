import type { NativeToolCall, TranscriptMessage } from "./transcript.js";
import type { Tool } from "./tools.js";

export type { NativeToolCall } from "./transcript.js";

export type ProviderTurn =
  | {
      readonly type: "final";
      readonly content: string;
    }
  | {
      readonly type: "tool_calls";
      readonly calls: readonly [NativeToolCall, ...NativeToolCall[]];
    };

export interface ProviderUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export function validateProviderUsage(
  usage: ProviderUsage | undefined,
): ProviderUsage | undefined {
  if (usage === undefined) return undefined;
  if (usage.model.trim() === "") return undefined;
  if (
    !isNonNegativeSafeInteger(usage.inputTokens) ||
    !isNonNegativeSafeInteger(usage.cachedInputTokens) ||
    !isNonNegativeSafeInteger(usage.outputTokens) ||
    !isNonNegativeSafeInteger(usage.reasoningTokens)
  ) {
    return undefined;
  }
  if (usage.cachedInputTokens > usage.inputTokens) return undefined;
  if (usage.reasoningTokens > usage.outputTokens) return undefined;
  return usage;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export type ProviderStreamEvent =
  | {
      readonly type: "output_text.delta";
      readonly text: string;
    }
  | {
      readonly type: "tool_arguments.delta";
      readonly callIndex: number;
      readonly text: string;
    }
  | {
      readonly type: "completed";
      readonly turn: ProviderTurn;
      readonly usage?: ProviderUsage;
    }
  | {
      readonly type: "retrying";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly reason: ProviderTransientReason;
    };

export interface ProviderRequest {
  readonly systemPrompt: string;
  readonly transcript: readonly TranscriptMessage[];
  readonly tools: readonly Tool[];
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface LlmProvider {
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export class ProviderOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderOutputError";
  }
}

export type ProviderTransientReason =
  | "rate_limited"
  | "server_error"
  | "overloaded"
  | "timeout"
  | "connection";

/**
 * 瞬时故障：同一请求稍后重发大概率成功。只有 `instanceof` 该类型的错误
 * 会被 `RetryingProvider` 重试，其余错误一律原样冒泡。
 */
export class ProviderTransientError extends Error {
  readonly reason: ProviderTransientReason;
  /** 服务端建议的等待时间（Retry-After / retry-after-ms），已解析成毫秒。 */
  readonly retryAfterMs?: number;

  constructor(
    reason: ProviderTransientReason,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderTransientError";
    this.reason = reason;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/** 重试耗尽或等待超限：服务暂时不可用。 */
export class ProviderUnavailableError extends Error {
  readonly attempts: number;
  readonly reason: ProviderTransientReason;

  constructor(
    attempts: number,
    reason: ProviderTransientReason,
    options?: ErrorOptions,
  ) {
    super(
      `Model service is temporarily unavailable (${reason}) after ${attempts} attempts.`,
      options,
    );
    this.name = "ProviderUnavailableError";
    this.attempts = attempts;
    this.reason = reason;
  }
}

/** 输出在 max_output_tokens 处被截断：不是非法响应，调用方应告知模型后重试。 */
export class ProviderTruncatedOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderTruncatedOutputError";
  }
}
