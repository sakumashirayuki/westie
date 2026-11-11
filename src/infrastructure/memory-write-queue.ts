/**
 * 进程内按记忆目录串行化的写入队列。同一服务进程里，不同会话可能同时修改同一
 * 仓库的记忆，写入和删除因此要按目录排队；读取不排队。队列不跨进程，也不覆盖
 * 外部编辑器或其他服务进程的写入。
 */

export const DEFAULT_WRITE_WAIT_MS = 5_000;

export class MemoryWriteTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for another project memory write to finish.");
    this.name = "MemoryWriteTimeoutError";
  }
}

interface QueueEntry {
  tail: Promise<void>;
  pending: number;
}

const queues = new Map<string, QueueEntry>();

/**
 * 取得某个记忆目录的写入位置。等待期间取消时立即返回，不修改任何文件；超时
 * 返回 `MemoryWriteTimeoutError`。返回的函数只生效一次。
 */
export async function acquireWritePosition(
  directory: string,
  options: {
    readonly waitMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<() => void> {
  options.signal?.throwIfAborted();
  const queue = queues.get(directory) ?? {
    tail: Promise.resolve(),
    pending: 0,
  };
  queues.set(directory, queue);
  queue.pending += 1;

  let releaseQueue!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const previous = queue.tail;
  queue.tail = settleAfter(previous, turn);

  try {
    await waitForTurn(previous, options.signal, options.waitMs ?? DEFAULT_WRITE_WAIT_MS);
  } catch (error) {
    // 放弃等待：释放自己的位置，后面的等待者按序继续。
    releaseQueue();
    forgetQueue(directory, queue);
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseQueue();
    forgetQueue(directory, queue);
  };
}

/** 队列里的位置只在轮到自己（或被主动释放）后放行，前一个位置的错误不外泄。 */
function settleAfter(previous: Promise<void>, turn: Promise<void>): Promise<void> {
  return Promise.allSettled([previous, turn]).then(() => undefined);
}

/** 队列空了就从注册表移除，避免长期运行的服务累积无用条目。 */
function forgetQueue(directory: string, queue: QueueEntry): void {
  queue.pending -= 1;
  if (queue.pending === 0 && queues.get(directory) === queue) {
    queues.delete(directory);
  }
}

/** 等前一个写操作完成；期间取消或超过等待上限时失败，且清理监听器与定时器。 */
function waitForTurn(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
  waitMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void =>
      finish(signal?.reason ?? new Error("Memory write cancelled."));
    const timer = setTimeout(
      () => finish(new MemoryWriteTimeoutError()),
      waitMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    previous.then(() => finish(), () => finish());
  });
}
