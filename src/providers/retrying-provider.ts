import {
  ProviderTransientError,
  ProviderUnavailableError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "../provider-protocol.js";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetryAfterMs: number;
  readonly maxTotalDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
  maxTotalDelayMs: 120_000,
};

interface RetryDeps {
  readonly sleep?: (
    delayMs: number,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
  readonly random?: () => number;
}

/**
 * 在 Provider 之上加一层有上限的重试。装饰器自己只负责重试与退避，内层
 * provider 依旧只描述"一次请求"，因此父 Run、子 Run 和 compaction 摘要
 * 只要包一层就能全部获得重试能力。
 *
 * 可重试的失败必须由内层抛 `ProviderTransientError`；其余错误原样冒泡。
 * 重试前会 yield 一条 `retrying` 事件，含义是"本调用到目前为止 yield 的
 * delta 全部作废，下一次尝试从头开始"。
 */
export class RetryingProvider implements LlmProvider {
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;

  readonly #inner: LlmProvider;
  readonly #policy: RetryPolicy;
  readonly #sleep: (
    delayMs: number,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
  readonly #random: () => number;

  constructor(
    inner: LlmProvider,
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
    deps: RetryDeps = {},
  ) {
    this.#inner = inner;
    this.#policy = policy;
    this.model = inner.model;
    this.contextWindowTokens = inner.contextWindowTokens;
    this.maxOutputTokens = inner.maxOutputTokens;
    this.#sleep = deps.sleep ?? abortableSleep;
    this.#random = deps.random ?? Math.random;
  }

  async *stream(
    request: ProviderRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    let totalDelayMs = 0;

    for (
      let attempt = 1;
      attempt <= this.#policy.maxAttempts;
      attempt += 1
    ) {
      try {
        for await (const event of this.#inner.stream(request)) {
          yield event;
        }
        return;
      } catch (error) {
        if (request.signal?.aborted) {
          throw error;
        }
        if (!(error instanceof ProviderTransientError)) {
          throw error;
        }
        const delay = attempt < this.#policy.maxAttempts
          ? this.#computeDelay(attempt, error)
          : undefined;
        // 次数用尽、服务端要求等太久、或累计等待将超过上限，都按服务不可用处理。
        if (
          delay === undefined ||
          totalDelayMs + delay > this.#policy.maxTotalDelayMs
        ) {
          throw new ProviderUnavailableError(attempt, error.reason, {
            cause: error,
          });
        }
        yield {
          type: "retrying",
          attempt: attempt + 1,
          maxAttempts: this.#policy.maxAttempts,
          delayMs: delay,
          reason: error.reason,
        };
        await this.#sleep(delay, request.signal);
        totalDelayMs += delay;
      }
    }
  }

  #computeDelay(attempt: number, error: ProviderTransientError): number | undefined {
    const { baseDelayMs, maxDelayMs } = this.#policy;
    const upperBound = Math.min(
      maxDelayMs,
      baseDelayMs * 2 ** (attempt - 1),
    );
    const jittered = this.#random() * upperBound;
    if (error.retryAfterMs !== undefined) {
      if (error.retryAfterMs > this.#policy.maxRetryAfterMs) {
        return undefined;
      }
      return Math.max(error.retryAfterMs, jittered);
    }
    return jittered;
  }
}

async function abortableSleep(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
