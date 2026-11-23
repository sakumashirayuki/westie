export interface RawLarkMessage {
  readonly event: unknown;
}

/** 有界入站消息队列 + 单串行 worker。保证飞书事件处理函数 3 秒内返回。 */
export const MAX_INBOUND_QUEUE_CAPACITY = 256;

export class LarkInboundQueue {
  readonly #items: unknown[] = [];
  #draining = false;
  #capacity = MAX_INBOUND_QUEUE_CAPACITY;

  constructor(
    private readonly handler: (event: unknown) => Promise<void> | void,
    capacity = MAX_INBOUND_QUEUE_CAPACITY,
  ) {
    this.#capacity = capacity;
  }

  /** 入队原始事件；队列满时丢弃新事件并记录告警（处理函数仍然立即返回）。 */
  push(event: unknown): void {
    if (this.#items.length >= this.#capacity) {
      console.warn(JSON.stringify({
        event: "lark.inbound.queue_full",
        dropped: true,
      }));
      return;
    }
    this.#items.push(event);
    void this.#drain();
  }

  /** 返回当前积压的事件数，用于关闭时的宽限判断。 */
  get pendingCount(): number {
    return this.#items.length;
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#items.length > 0) {
        const event = this.#items.shift()!;
        try {
          // 单串行：前一个 handler 完成前不处理下一条，保证去重与副作用顺序稳定。
          await this.handler(event);
        } catch (error) {
          console.error(JSON.stringify({
            event: "lark.inbound.handler_error",
            message: error instanceof Error ? error.message : String(error),
          }));
          // 单条事件失败不中断队列，继续处理后续事件（去重记录已由 handler 先写）。
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  /** 丢弃尚未处理的事件，返回丢弃条数。 */
  flushPending(): number {
    const dropped = this.#items.length;
    this.#items.splice(0, this.#items.length);
    return dropped;
  }
}