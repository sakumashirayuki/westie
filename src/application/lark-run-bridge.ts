import { AgentEventType, type AgentEvent } from "../agent-events.js";
import type { RunStreamRecord } from "../run-stream.js";
import type { RunRegistry, RunActivityEvent } from "./run-registry.js";
import type { LarkOutbound, OutboundSendRequest } from "./lark-outbound.js";

export interface LarkRunBridgeOptions {
  readonly registry: RunRegistry;
  readonly outbound: LarkOutbound;
}

/** 关停时等待出站泵落定的上限，与 server-bootstrap 的关停注释保持一致。 */
export const LARK_RUN_BRIDGE_STOP_TIMEOUT_MS = 5_000;

/**
 * 飞书启动的 Run 的出站泵：消费订阅事件流，发送待批准提醒与终态结果通知。
 *
 * - 只跟踪由飞书消息启动的 Run；网页端启动的 Run 不推送飞书。
 * - 每个跟踪 Run 一个订阅异步迭代器，泵之间互不等待，网页 SSE 消费不受影响。
 * - 待批准提醒通过 `registry.onActivity` 在状态沿边沿进入 `awaiting_interaction`
 *   时发一条，同一段等待不重复。
 * - Run 终态后（completed/error/cancelled）发对应通知并注销泵。
 */
export class LarkRunBridge {
  readonly #registry: RunRegistry;
  readonly #outbound: LarkOutbound;
  readonly #notifiedAwaiting = new Set<string>();
  readonly #pumps = new Map<string, Promise<void>>();
  #activityOff: (() => void) | undefined;

  constructor(options: LarkRunBridgeOptions) {
    this.#registry = options.registry;
    this.#outbound = options.outbound;
  }

  /** 登记一个飞书启动的 Run 并开始订阅其结果。启动与登记在同一 worker 步内完成。 */
  register(runId: string, chatId: string): void {
    if (this.#pumps.has(runId)) return;
    this.#ensureActivityListener();
    const controller = new AbortController();
    const pump = this.#pump(runId, chatId, controller);
    this.#pumps.set(runId, pump);
    // 出站泵不阻塞 worker；异常只记录日志。
    void pump.catch((error) => {
      console.error(JSON.stringify({
        event: "lark.run_bridge.error",
        runId,
        message: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  /**
   * 停止活动监听并等待在途泵落定，最多等待 timeoutMs。超时后放弃等待，
   * 残留泵随进程退出结束；终止订阅不取消 Run。超时定时器保持 ref：
   * 事件循环没有其他句柄时也要保证本方法在 timeoutMs 内返回。
   */
  async stop(timeoutMs = LARK_RUN_BRIDGE_STOP_TIMEOUT_MS): Promise<void> {
    this.#activityOff?.();
    this.#activityOff = undefined;
    const pending = Promise.allSettled([...this.#pumps.values()]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([pending, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    this.#pumps.clear();
  }

  #ensureActivityListener(): void {
    if (this.#activityOff !== undefined) return;
    this.#activityOff = this.#registry.onActivity((event) => {
      this.#onActivity(event);
    });
  }

  #onActivity(event: RunActivityEvent): void {
    if (!this.#pumps.has(event.runId)) return;
    if (event.state !== "awaiting_interaction") {
      // 离开待批准状态（继续运行 / 等待子 Run / 结束）后清除标记，
      // 同一 Run 下一次进入该状态时仍会发一条提醒。
      this.#notifiedAwaiting.delete(event.runId);
      return;
    }
    if (this.#notifiedAwaiting.has(event.runId)) return;
    this.#notifiedAwaiting.add(event.runId);
    void this.#outbound.enqueue({
      chatId: this.#chatIdOf(event.runId),
      content:
        "任务需要批准：请回到 Westie 网页界面批准工具操作，任务正在等待。",
      uuid: `westie-await-${event.runId}`,
    });
  }

  #chatIdOf(runId: string): string {
    // 泵注册时把 chatId 记录在本桥的 map 里；此处通过已登记的泵上下文取。
    return this.#knownChats.get(runId) ?? "";
  }

  readonly #knownChats = new Map<string, string>();

  async #pump(
    runId: string,
    chatId: string,
    controller: AbortController,
  ): Promise<void> {
    this.#knownChats.set(runId, chatId);
    let lastAnswer: string | undefined;
    try {
      const iterable = this.#registry.subscribe(runId, 0, controller.signal);
      for await (const record of iterable) {
        if (isEventRecord(record) === false) continue;
        const event = record.event;
        if (event.type === AgentEventType.AnswerCompleted) {
          lastAnswer = event.data.answer;
        } else if (event.type === AgentEventType.RunCompleted) {
          await this.#sendTerminal(runId, chatId, {
            kind: "completed",
            answer: lastAnswer,
          });
        } else if (event.type === AgentEventType.RunError) {
          await this.#sendTerminal(runId, chatId, {
            kind: "failed",
            code: event.data.code,
            message: event.data.message,
          });
        } else if (event.type === AgentEventType.RunCancelled) {
          await this.#sendTerminal(runId, chatId, { kind: "cancelled" });
        }
      }
    } finally {
      this.#knownChats.delete(runId);
      this.#notifiedAwaiting.delete(runId);
      this.#pumps.delete(runId);
      controller.abort();
    }
  }

  async #sendTerminal(
    runId: string,
    chatId: string,
    terminal:
      | { readonly kind: "completed"; readonly answer?: string }
      | { readonly kind: "failed"; readonly code: string; readonly message: string }
      | { readonly kind: "cancelled" },
  ): Promise<void> {
    if (terminal.kind === "completed") {
      const content =
        terminal.answer === undefined || terminal.answer.length === 0
          ? "任务已完成。"
          : terminal.answer;
      const chunks = this.#outbound.chunkText(content);
      if (chunks.length === 1) {
        await this.#outbound.enqueue({
          chatId,
          content: chunks[0],
          uuid: `westie-answer-${runId}`,
        });
        return;
      }
      for (const [index, chunk] of chunks.entries()) {
        await this.#outbound.enqueue({
          chatId,
          content: `${chunk}\n（${index + 1}/${chunks.length}）`,
          uuid: `westie-answer-${runId}-${index}`,
        });
      }
      return;
    }
    if (terminal.kind === "failed") {
      await this.#outbound.enqueue({
        chatId,
        content: `任务失败：${terminal.message}（${terminal.code}）`,
        uuid: `westie-err-${runId}`,
      });
      return;
    }
    await this.#outbound.enqueue({
      chatId,
      content: "任务已取消。",
      uuid: `westie-cancel-${runId}`,
    });
  }
}

function isEventRecord(
  record: RunStreamRecord,
): record is Extract<RunStreamRecord, { event: AgentEvent }> {
  return "event" in record;
}