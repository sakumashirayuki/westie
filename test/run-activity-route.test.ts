import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type {
  RunActivityEvent,
  RunRegistry,
} from "../src/application/run-registry.js";
import { RunActivityRoute } from "../src/http/run-activity-route.js";

/** 写缓冲区一直满着的响应：write 永远返回 false，也永远不会 drain。 */
class StalledResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  readonly chunks: string[] = [];

  writeHead(): this {
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return false;
  }

  end(): void {
    this.writableEnded = true;
  }
}

function fakeRegistry() {
  const listeners = new Set<(event: RunActivityEvent) => void>();
  const registry = {
    snapshot: () => [],
    onActivity(listener: (event: RunActivityEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RunRegistry;
  return { registry, listeners };
}

test("runs:watch does not leak a rejection when the client disconnects while run.state waits for drain", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { registry, listeners } = fakeRegistry();
    const request = Object.assign(new EventEmitter(), { method: "GET" });
    const response = new StalledResponse();
    const route = new RunActivityRoute({ registry });

    const handled = route.handle(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );
    // snapshot 已经写入并卡在 drain 上；此时来一条状态变化，它的写入同样卡在 drain 上。
    assert.equal(listeners.size, 1);
    for (const listener of listeners) {
      listener({ conversationId: "c1", runId: "r1", state: "running" });
    }
    assert.equal(response.chunks.filter((c) => c.startsWith("event: run.state")).length, 1);

    // 客户端断开：两条等待 drain 的写入都会 reject。
    response.emit("close");
    // handle 自身的 rejection 由 createAgentServer 的 catch 兜底，这里同样吞掉。
    await handled.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.equal(listeners.size, 0, "onActivity listener must be removed");
    assert.equal(response.writableEnded, true);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
