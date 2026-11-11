import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  RunActivityEvent,
  RunRegistry,
} from "../application/run-registry.js";
import { writeWithBackpressure } from "./sse.js";

export interface RunActivityRouteOptions {
  readonly registry: RunRegistry;
}

/**
 * 全局运行状态流：连接建立时先发一条 `snapshot`，之后每次状态变化发一条
 * `run.state`。运行状态只有一个来源，保证侧栏与对话区一致。
 */
export class RunActivityRoute {
  constructor(private readonly options: RunActivityRouteOptions) {}

  /** 方法校验与 Allow 头由挂载处的 defineRoute 负责。 */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();

    const controller = new AbortController();
    const disconnect = (): void => {
      if (!response.writableEnded && !controller.signal.aborted) {
        controller.abort(new Error("Client disconnected."));
      }
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);

    const heartbeat = setInterval(() => {
      if (!response.writableEnded) {
        response.write(`: heartbeat\n\n`);
      }
    }, 30_000);
    heartbeat.unref();

    const registry = this.options.registry;
    const write = (event: string, data: unknown): Promise<void> =>
      writeWithBackpressure(
        response,
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        controller.signal,
      );

    const unsubscribe = registry.onActivity((event: RunActivityEvent) => {
      // 连接在等待 drain 时断开会让这条 write 抛错；必须 catch，否则成为
      // unhandled rejection 导致进程退出。清理在 finally 里完成。
      const pending = write("run.state", {
        conversationId: event.conversationId,
        runId: event.runId,
        state: event.state,
        ...(event.status === undefined ? {} : { status: event.status }),
      });
      pending.catch(() => {});
    });

    try {
      await write("snapshot", { runs: registry.snapshot() });

      // 等连接断开；事件由 onActivity 推送。
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) {
          resolve();
          return;
        }
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    } finally {
      unsubscribe();
      clearInterval(heartbeat);
      request.off("aborted", disconnect);
      response.off("close", disconnect);
      if (!response.destroyed) response.end();
    }
  }
}
