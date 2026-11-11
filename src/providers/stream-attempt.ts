import { ProviderTransientError } from "../provider-protocol.js";

/**
 * 一次 provider 请求的中止信号与流 idle 超时。
 *
 * SDK 的 `timeout` 只管到拿到响应头为止，流开始后服务端不再发数据会一直挂着。
 * 连续 `idleTimeoutMs` 没有调用 `touch()` 就中止本次请求，并把原因记成
 * `ProviderTransientError("timeout")`，交给 `RetryingProvider` 重试。
 *
 * 用 `using attempt = new StreamAttempt(...)` 声明，离开作用域时清理计时器和监听器。
 */
export class StreamAttempt implements Disposable {
  readonly #controller = new AbortController();
  readonly #parent: AbortSignal | undefined;
  readonly #idleTimeoutMs: number;
  readonly #label: string;
  readonly #onParentAbort = (): void => {
    this.#controller.abort(this.#parent?.reason);
  };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #idleTimeout: ProviderTransientError | undefined;

  constructor(
    parent: AbortSignal | undefined,
    idleTimeoutMs: number,
    label: string,
  ) {
    this.#parent = parent;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#label = label;
    if (parent?.aborted) {
      this.#controller.abort(parent.reason);
    } else {
      parent?.addEventListener("abort", this.#onParentAbort, { once: true });
    }
    this.touch();
  }

  /** 传给 SDK 的信号：用户取消和 idle 超时都会触发它。 */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** 本次请求因 idle 超时被中止时返回对应错误，否则为 undefined。 */
  get idleTimeout(): ProviderTransientError | undefined {
    return this.#idleTimeout;
  }

  /** 收到任何数据时调用，重新开始计时。 */
  touch(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#idleTimeout = new ProviderTransientError(
        "timeout",
        `${this.#label} stream idle timed out.`,
      );
      this.#controller.abort(this.#idleTimeout);
    }, this.#idleTimeoutMs);
  }

  /** SDK 被中止时可能静默结束迭代，循环结束后用它补上超时错误。 */
  throwIfIdleTimedOut(): void {
    if (this.#idleTimeout !== undefined) throw this.#idleTimeout;
  }

  [Symbol.dispose](): void {
    clearTimeout(this.#timer);
    this.#parent?.removeEventListener("abort", this.#onParentAbort);
  }
}
