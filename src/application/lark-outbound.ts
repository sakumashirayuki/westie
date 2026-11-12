import type { SendMessageRequest, SendOutcome } from "../lark/lark-client.js";

/** 单片回答上限：留足 JSON 与飞书头部余量。 */
export const MAX_OUTBOUND_CHUNK_BYTES = 120 * 1024;
/** 同接收者相邻发送最小间隔，对应 5 QPS 上限。 */
export const OUTBOUND_MIN_INTERVAL_MS = 210;
/** 发送失败后的重试间隔序列。 */
export const OUTBOUND_RETRY_DELAYS_MS = [2_000, 10_000, 60_000];

export interface OutboundSendRequest {
  readonly chatId: string;
  readonly content: string;
  /** 出站幂等键：同一通知的重试复用同一 uuid。 */
  readonly uuid: string;
}

export interface LarkOutboundOptions {
  readonly client: {
    sendMessage(request: SendMessageRequest): Promise<SendOutcome>;
  };
  /** 当前时间；用于串行间隔。 */
  readonly now?: () => number;
}

/**
 * 出站文本发送器：文本切片（不切断多字节字符）、按单聊串行并满足频控间隔、失败
 * 按计划重试、uuid 幂等。
 *
 * 串行队列以 chat_id 为键：同一接收者的消息按到达顺序发送，前一条完成（含重试
 * 结束）后等待最小间隔再发下一条；不同 chat_id 之间互不影响。
 */
export class LarkOutbound {
  readonly #options: LarkOutboundOptions;
  readonly #chains = new Map<string, Promise<void>>();
  #lastSendAt = new Map<string, number>();
  #abort = new AbortController();

  constructor(options: LarkOutboundOptions) {
    this.#options = options;
  }

  /**
   * 关停：中止频控与重试等待，已入队消息尽快落定（在途请求无法取消）。
   * 中止后新入队消息直接丢弃，避免关停期间继续访问飞书 API。
   */
  close(): void {
    this.#abort.abort();
  }

  /**
   * 把一个切片后的消息排入对应单聊的串行链。resolve 表示该消息的发送已结束
   * （成功、重试耗尽或关停中止）；不会 reject。
   */
  enqueue(request: OutboundSendRequest): Promise<void> {
    if (this.#abort.signal.aborted) return Promise.resolve();
    const previous = this.#chains.get(request.chatId) ?? Promise.resolve();
    const next = previous.then(() => this.#sendWithThrottle(request));
    this.#chains.set(request.chatId, next);
    return next;
  }

  /** 按可打印字符保存的字节切片：优先换行、其次空格，不切断多字节字符。 */
  chunkText(text: string, maxBytes = MAX_OUTBOUND_CHUNK_BYTES): readonly string[] {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
    const result: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = findChunkEnd(text, start, maxBytes);
      result.push(text.slice(start, end));
      start = end;
    }
    return result;
  }

  async #sendWithThrottle(request: OutboundSendRequest): Promise<void> {
    if (this.#abort.signal.aborted) return;
    const now = this.#options.now?.() ?? Date.now();
    const last = this.#lastSendAt.get(request.chatId) ?? 0;
    const wait = Math.max(0, last + OUTBOUND_MIN_INTERVAL_MS - now);
    if (wait > 0) await sleep(wait, this.#abort.signal).catch(() => {});
    if (this.#abort.signal.aborted) return;
    this.#lastSendAt.set(request.chatId, Date.now());
    await this.#sendWithRetry(request);
  }

  async #sendWithRetry(request: OutboundSendRequest): Promise<void> {
    for (const delay of [0, ...OUTBOUND_RETRY_DELAYS_MS]) {
      if (this.#abort.signal.aborted) return;
      if (delay > 0) await sleep(delay, this.#abort.signal).catch(() => {});
      if (this.#abort.signal.aborted) return;
      const outcome = await this.#options.client.sendMessage({
        chatId: request.chatId,
        content: request.content,
        uuid: request.uuid,
      });
      if (outcome.status === "sent") return;
      if (delay === OUTBOUND_RETRY_DELAYS_MS.at(-1)) {
        console.error(JSON.stringify({
          event: "lark.outbound.failed",
          chatId: request.chatId,
          uuid: request.uuid,
          code: outcome.code,
          message: outcome.message,
        }));
      }
    }
  }
}

/** 在 start 之后找片边界：不超过 maxBytes 的最后一个换行 / 空格，否则按字符回落。 */
function findChunkEnd(text: string, start: number, maxBytes: number): number {
  let budget = maxBytes;
  let end = start;
  for (; end < text.length; end += 1) {
    const char = text[end];
    const byteLength = Buffer.byteLength(char, "utf8");
    if (budget - byteLength < 0) break;
    budget -= byteLength;
  }
  if (end <= start) return start + 1;
  // 在 [start, end) 内从后向前找换行或空格，避免切断多字节字符。
  const slice = text.slice(start, end);
  const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  if (lastBreak >= 0) return start + lastBreak + 1;
  return end;
}

/**
 * 可中止的延时：收到 abort 信号时立即 reject，关停不必等完频控与重试间隔。
 * 定时器保持 ref 以保证空闲事件循环下仍能按时触发；关停方通过 close 中止。
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
