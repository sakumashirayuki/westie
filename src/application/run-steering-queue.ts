import {
  MAX_PENDING_STEERING_MESSAGES,
  MAX_STEERING_MESSAGE_BYTES,
  ProtocolError,
} from "../protocol.js";
import { SteeringQueueFullError } from "../domain/conversation.js";

export interface SteeringMessage {
  readonly seq: number;
  readonly content: string;
}

// 运行期转向消息的内存队列。Run 是进程内的，重启后 running Run 会被
// recoverStaleRuns 标成 failed，没有任何转向状态需要跨重启存活。
//
// 队列同时是等待方的唤醒源：enqueue 先保存再通知，等待方先注册通知再检查条件，
// 因此「检查」与「休眠」之间到达的消息不会丢。
export class RunSteeringQueue {
  readonly #queues = new Map<string, SteeringMessage[]>();
  readonly #nextSeq = new Map<string, number>();
  readonly #listeners = new Map<string, Set<() => void>>();

  enqueue(runId: string, content: string): number {
    assertSteeringContent(content);
    const queue = this.#queues.get(runId) ?? [];
    if (queue.length >= MAX_PENDING_STEERING_MESSAGES) {
      throw new SteeringQueueFullError();
    }
    const seq = this.#nextSeq.get(runId) ?? 0;
    this.#nextSeq.set(runId, seq + 1);
    queue.push({ seq, content });
    this.#queues.set(runId, queue);
    this.#notify(runId);
    return seq;
  }

  take(runId: string, _step: number): readonly SteeringMessage[] {
    const queue = this.#queues.get(runId) ?? [];
    this.#queues.delete(runId);
    return [...queue].sort((left, right) => left.seq - right.seq);
  }

  /** 是否还有未取走的用户追加消息；父 Run 的等待条件之一。 */
  hasPending(runId: string): boolean {
    return (this.#queues.get(runId)?.length ?? 0) > 0;
  }

  /** 订阅新的用户追加消息；返回解除订阅的函数。 */
  onEnqueued(runId: string, listener: () => void): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => listeners.delete(listener);
  }

  dispose(runId: string): void {
    this.#queues.delete(runId);
    this.#nextSeq.delete(runId);
    this.#listeners.delete(runId);
  }

  #notify(runId: string): void {
    for (const listener of [...(this.#listeners.get(runId) ?? [])]) {
      listener();
    }
  }
}

function assertSteeringContent(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (content.trim() === "" || bytes > MAX_STEERING_MESSAGE_BYTES) {
    throw new ProtocolError("Steering message is empty or exceeds 16 KiB.");
  }
}
